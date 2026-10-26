/**
 * Zeus Secretariat V0 - State Machine Implementation
 * 
 * Core invariant: After payment is submitted, we CANNOT blindly retry.
 * We must first determine settlement status before any recovery action.
 */

import {
  Operation,
  OperationStatus,
  PaymentStatus,
  ExecutionStatus,
  EvidenceRecord,
  EvidencePhase,
  PaymentPolicy,
  SellerCapabilities,
  RecoveryCapability,
  ExecuteRequest,
  ExecutionResult,
  SettlementProof,
  ExecutionEvidence,
  EvidenceStore,
  DurableEvidenceStore,
  DurablePaymentIntent,
  PaymentSigner,
  PaymentAdapter,
  PaymentRequirement,
  PaymentAuthorization,
  SigningContext,
} from './types.js';

import type { SettlementAdapter, PaymentPayload, SubmitResult } from '../adapters/x402-facilitator-client.js';
import type { ReconciliationEngine, ReconciliationOutcome } from './reconciliation-engine.js';
import type { RecoveryJob, ExecutionAttempt, AtomicSettlementHandoff } from './post-settlement-engine.js';
import type { PaymentAuthorizationRequest, PaymentSignatureResult } from './payment-types.js';
import { CryptoNonceGenerator } from './nonce-generator.js';
import { egressFetch } from './egress-guard.js';
import { keccak256, toBytes } from 'viem';
import { randomUUID } from 'node:crypto';
// R7-C6 (external audit 2026-10-26): X402Parser / SellerCapabilityResolver
// imports were sitting in the MIDDLE of the file (after the legacy
// PaymentIntent declarations) — moved to the import block.
import { X402Parser, X402Accept } from './x402-parser.js';
import { SellerCapabilityResolver, CapabilitySource } from './capability-resolver.js';
// R9-A1: standard x402 v2 client transport (third-party sellers)
import type { StandardX402Transport as StandardX402TransportType, StandardPaidCallRecord, StandardTransportTarget } from './standard-x402-transport.js';
import { isStandardPaidCallRecord } from './standard-x402-transport.js';
// F-110 (external audit 2026-10-26): single source of truth for the Operation
// FSM — the table lives in operation-fsm.ts and is shared with
// execution-feedback-service.ts (the hand-mirrored ALLOWED_EDGES copy is gone).
import { VALID_TRANSITIONS, isValidTransition } from './operation-fsm.js';
// Backwards-compatible re-export for existing imports from this module.
export { VALID_TRANSITIONS, isValidTransition };

// Legacy types used internally by StateMachine (Phase 2.1 payment flow)
// These are NOT the canonical V0 DurablePaymentIntent — they exist only for
// the legacy in-memory intent bookkeeping.
// R7-C3 (external audit 2026-10-26): the deprecated execution path
// (observeExecution_DEPRECATED_USE_POST_SETTLEMENT_ENGINE + handleRecovery +
// the three recoverVia* methods) has been DELETED — its only callers were
// each other, it re-fired seller requests WITHOUT payment proof, and it
// contained an EXECUTION_UNKNOWN → UNRESOLVABLE transition that the FSM table
// never allowed. All post-settlement execution lives in PostSettlementEngine
// (see the architectural boundary below).
interface PaymentIntent {
  operationId: string;
  requirement: PaymentRequirement;
  amount: string;
  asset: string;
  network: string;
  authorization: PaymentAuthorization;
  createdAt: number;
  status: PaymentIntentStatus;
}

type PaymentIntentStatus =
  | 'AUTHORIZED'
  | 'SUBMITTED'
  | 'SETTLED'
  | 'FAILED'
  | 'UNKNOWN';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateOperationId(): string {
  // R7-C4 (external audit 2026-10-26): crypto-random ids instead of
  // Date.now()+Math.random() — unguessable operation/request/intent ids also
  // close the "guess a requestId" read vector on the public status route.
  return `op_${Date.now()}_${randomUUID()}`;
}

function generateRequestId(): string {
  return `req_${Date.now()}_${randomUUID()}`;
}

/**
 * S1/S5 live-matrix repair (2026-10-23, Argus Agent Test Lab vs real
 * Secretariat): when the client does not supply a requestId, the previous
 * code generated a FRESH one on every create call. The idempotency lookup
 * (client_id, request_id) and the 0006 partial unique index therefore never
 * matched for retries — a duplicate create (client retry after a network
 * timeout) or a concurrent duplicate created a NEW operation and could
 * settle TWICE for one logical request (observed live: S1 → 2 settled
 * intents, S5 → 5, all with the same clientId).
 *
 * B8-001 contract: clientId is the idempotency identity of the logical
 * request. Derive the requestId deterministically from it when the client
 * omits its own, so duplicate creates resolve to the SAME operation through
 * the existing lookup + 0006 unique index arbiter.
 */
function resolveLogicalRequestId(request: ExecuteRequest): string {
  if (request.requestId) return request.requestId;
  if (request.clientId) return `cid:${request.clientId}`;
  return generateRequestId();
}

function generatePaymentIntentId(): string {
  return `pi_${Date.now()}_${randomUUID()}`;
}

/**
 * R7-B5a: key-order-insensitive JSON fingerprint for payload equality.
 * A client retry may serialize the same JSON object with different key
 * order — that is the SAME logical payload, not a collision.
 */
function stableFingerprint(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableFingerprint(record[k])}`).join(",")}}`;
}

function now(): number {
  return Date.now();
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Invalid payment authorization: ${field} is required`);
  }
  return value;
}

function toEpochSeconds(deadlineMs: number | undefined, currentMs: number): number {
  const deadline = deadlineMs ?? currentMs + 300_000;
  return deadline > 10_000_000_000 ? Math.floor(deadline / 1000) : Math.floor(deadline);
}

// ============================================================================
// STATE MACHINE TRANSITIONS
// ============================================================================

// F-110 (external audit 2026-10-26): the authoritative transition table and
// isValidTransition() live in operation-fsm.ts — a single source of truth
// shared with execution-feedback-service.ts (the hand-mirrored ALLOWED_EDGES
// copy there is gone). Re-exported at the import block for backwards
// compatibility with existing imports from this module.

// ============================================================================
// SECRETARIAT CORE
// ============================================================================

/**
 * P0-7: ARCHITECTURAL BOUNDARY — SINGLE AUTHORITATIVE EXECUTION PATH
 *
 * This state machine handles PAYMENT lifecycle transitions ONLY.
 * It does NOT execute seller HTTP calls directly.
 *
 * The SINGLE authoritative execution/recovery path is:
 *   SETTLED → PostSettlementEngine.initiateExecution() → ExecutionAttempt → seller → evidence
 *
 * R7-C3: the deprecated in-machine execution path was REMOVED — there is no
 * alternative execution path. All post-settlement execution goes through
 * PostSettlementEngine exclusively.
 *
 * Architecture:
 *   SETTLED
 *      ↓
 *   PostSettlementEngine (ONLY path)
 *      ↓
 *   ExecutionAttempt (durable in DB)
 *      ↓
 *   SellerExecutionAdapter
 *      ↓
 *   Evidence (durable in DB)
 *      ↓
 *   SUCCESS / DELIVERY_UNKNOWN / recovery
 */

export interface SecretariatConfig {
  evidenceStore: EvidenceStore & Partial<DurableEvidenceStore>;
  signer?: PaymentSigner;
  adapters: Map<string, PaymentAdapter>;
  capabilitySources?: CapabilitySource[];
  /** Canonical V2 settlement adapter. Required for production payment submission. */
  settlementAdapter?: SettlementAdapter;
  /** Canonical reconciliation engine. Required for settlement verification. */
  reconciliationEngine?: ReconciliationEngine;
  /**
   * R9-A1: standard x402 v2 client transport for THIRD-PARTY sellers.
   * Required only when a request's policy.transport === "standard"
   * (or defaultPaymentTransport === "standard"); absent → such requests
   * fail closed with a configuration error before any money moves.
   */
  standardTransport?: StandardX402TransportType;
  /**
   * R9-A1: default payment transport for requests whose policy does not pin
   * one explicitly. Default "zeus" (pay-then-prove) — the pre-existing
   * behavior; "standard" flips the whole deployment to canonical x402
   * client mode unless a request overrides it via policy.transport.
   */
  defaultPaymentTransport?: 'zeus' | 'standard';
  /**
   * R2.1-FIX-5: REQUIRED atomic settlement → execution handoff.
   * Production MUST provide PostgresExecutionStore implementing this contract.
   * If unavailable, settlement → execution handoff will fail closed.
   */
  atomicSettlementHandoff: AtomicSettlementHandoff;
  /**
   * Repair C3: Bounded retry policy for evidence persistence flushes.
   * Total attempts per flush = max(1, value). Default 3. No infinite retries.
   */
  evidencePersistenceRetries?: number;
  /**
   * F-01 fix (external audit 2026-10-25): bound for the recovery job created
   * by the atomic settlement → execution handoff. Mirrors
   * PostSettlementEngine.maxExecutionAttempts (ZEUS_MAX_EXECUTION_ATTEMPTS).
   * Default 3 when omitted.
   */
  maxExecutionAttempts?: number;
}

export type CreateRequestResult =
  | {
      status: 'AWAITING_PAYMENT_SIGNATURE';
      requestId: string;
      operationId: string;
      paymentRequired: PaymentRequirement;
      paymentIntent: Pick<
        DurablePaymentIntent,
        'paymentIntentId' | 'authorizer' | 'payTo' | 'value' | 'asset' | 'network' |
        'nonce' | 'validAfter' | 'validBefore' | 'settlementState'
      >;
    }
  | {
      status: 'COMPLETED' | 'REJECTED';
      result: ExecutionResult;
    };

type StageAPreparation =
  | {
      status: 'AWAITING_SIGNATURE';
      operation: Operation;
      paymentRequired: PaymentRequirement;
      paymentIntent: DurablePaymentIntent;
    }
  | {
      status: 'PAYMENT_REQUIRED';
      operation: Operation;
      paymentRequired: PaymentRequirement;
    }
  | {
      status: 'COMPLETED' | 'REJECTED' | 'EXISTING';
      operation: Operation;
      result: ExecutionResult;
    };

interface StageAOptions {
  /**
   * Legacy execute() historically creates its AUTHORIZED DPI inside
   * authorizePayment(). Keep that compatibility path while the canonical
   * non-custodial and V2 paths persist PENDING_SIGNATURE here.
   */
  persistPendingIntent?: boolean;
}

export class Secretariat {
  private readonly config: SecretariatConfig;
  private readonly capabilityResolver: SellerCapabilityResolver;

  /**
   * Repair C3: durable-outbox cursor per operation.
   * Maps operationId -> count of evidence records confirmed durably persisted
   * (in sequence order). The cursor only advances on CONFIRMED appends, so a
   * failed append leaves the record pending for the next flush. A failed call
   * does NOT prove the DB made no change - the store's append() is idempotent
   * via stable logical identity (see PostgresEvidenceStore), so re-appending
   * an ambiguous record cannot create duplicates.
   */
  private readonly persistedEvidenceCount = new Map<string, number>();

  constructor(config: SecretariatConfig) {
    this.config = config;
    this.capabilityResolver = new SellerCapabilityResolver(config.capabilitySources ?? []);
  }

  /** Total attempts per evidence flush (bounded; never infinite). */
  private evidenceFlushAttempts(): number {
    const n = this.config.evidencePersistenceRetries ?? 3;
    return Math.max(1, Math.min(10, Math.floor(n)));
  }

  // ==========================================================================
  // MAIN ENTRY POINT: Execute an operation
  // ==========================================================================

  async execute(request: ExecuteRequest): Promise<ExecutionResult> {
    const requestId = resolveLogicalRequestId(request);
    const canonicalV2 = Boolean(this.config.settlementAdapter);
    let stageARequest = request;

    // The Stage-A primitive never consults a signer. The existing signer-based
    // execute path supplies its binding before entering the primitive so the
    // primitive can persist the same DPI that authorization will later use.
    if (canonicalV2 && !stageARequest.authorizer && this.config.signer?.getAddress) {
      stageARequest = {
        ...request,
        authorizer: await this.config.signer.getAddress(),
      };
    }

    const stageA = await this.prepareStageA(stageARequest, {
      persistPendingIntent: canonicalV2,
    });
    if (stageA.status === 'COMPLETED' || stageA.status === 'REJECTED' || stageA.status === 'EXISTING') {
      return stageA.result;
    }

    const operation = stageA.operation;

    try {
      if (stageA.status === 'AWAITING_SIGNATURE' || stageA.status === 'PAYMENT_REQUIRED') {
        // Stage A has completed its durable boundary. The existing execute()
        // continuation is intentionally unchanged: authorize, submit, observe.
        await this.authorizePayment(operation);
        await this.persistOperation(operation);
        await this.submitPayment(operation);
        await this.observeSettlement(operation);
      }

      // Step 7: Durable settlement + execution obligation handoff
      // INV-9: Every SETTLED transition must leave a durable recoverable execution obligation.
      // StateMachine does NOT execute seller work — it only persists the handoff.
      // PostSettlementEngine owns execution lifecycle exclusively.
      if (operation.currentState === 'SETTLED' || operation.currentState === 'EXECUTION_PENDING') {
        await this.settleToExecution(operation);
      }

      // Step 8: Delivery
      if (operation.currentState === 'EXECUTION_CONFIRMED') {
        await this.deliver(operation);
      }

      // R9-A1: the standard transport completes the whole lifecycle in-process
      // (execution discharged inline) — persist the terminal/non-terminal
      // snapshot durably. The Zeus path is deliberately untouched: there the
      // durable operation is owned by the async feedback services.
      if (this.resolvePaymentTransport(operation) === 'standard') {
        await this.persistOperation(operation);
      }

      return this.buildResult(operation);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (process.env.ZEUS_DEBUG_STACK) {
        console.error('[StateMachine.execute] failure:', (error as Error)?.stack ?? error);
      }
      return await this.failOperation(operation, 'FAILED', errorMessage);
    }
  }

  /**
   * Stage A of the non-custodial payment boundary.
   *
   * This path discovers and validates the request, persists the operation and
   * DPI, and stops before a signer, signature, or facilitator call is used.
   */
  async createRequest(request: ExecuteRequest): Promise<CreateRequestResult> {
    const stageA = await this.prepareStageA(request);
    if (stageA.status === 'AWAITING_SIGNATURE') {
      return this.buildAwaitingSignatureResult(stageA.operation, stageA.paymentIntent, stageA.paymentRequired);
    }
    if (stageA.status === 'REJECTED') return { status: 'REJECTED', result: stageA.result };
    if (stageA.status === 'PAYMENT_REQUIRED') {
      // The default Stage-A primitive persists a pending intent. Keep this
      // defensive branch explicit if a caller opts into the legacy continuation.
      return { status: 'COMPLETED', result: this.buildResult(stageA.operation) };
    }
    return { status: 'COMPLETED', result: stageA.result };
  }

  /**
   * Stage B of the non-custodial payment boundary.
   *
   * The supplied payload is checked against the persisted DPI before the
   * existing facilitator/reconciliation flow is resumed.
   */
  async submitSignedPayment(
    requestId: string,
    externallySignedPaymentPayload: PaymentPayload,
  ): Promise<ExecutionResult> {
    const operation = await this.findExistingOperation(undefined, requestId);
    if (!operation) throw new Error(`REQUEST_NOT_FOUND: ${requestId}`);
    // Repair C3: the continuation appends NEW evidence with sequence values
    // derived from the in-memory copy, which may lag the durable store after a
    // restart. Reconcile: append any durable records missing from memory
    // (dedup by event+timestamp), then seed the outbox cursor from the now
    // authoritative durable prefix length.
    try {
      const durable = await this.config.evidenceStore.getEvidence(operation.operationId);
      if (Array.isArray(durable)) {
        const seen = new Set(operation.evidence.map((e) => `${e.event}|${e.timestamp}|${JSON.stringify(e.payload)}`));
        for (const rec of durable) {
          const k = `${rec.event}|${rec.timestamp}|${JSON.stringify(rec.payload)}`;
          if (!seen.has(k)) {
            operation.evidence.push(rec);
            seen.add(k);
          }
        }
        this.persistedEvidenceCount.set(operation.operationId, durable.length);
      }
    } catch {
      /* keep whatever cursor was seeded by findExistingOperation */
    }

    const dpi = await this.getDurableIntent(operation.operationId);
    if (!dpi) {
      throw new Error('PAYMENT_INTENT_NOT_PENDING_SIGNATURE');
    }
    if (dpi.settlementState !== 'PENDING_SIGNATURE') {
      const serializedPayload = JSON.stringify(externallySignedPaymentPayload);
      const paymentPayloadHash = keccak256(toBytes(serializedPayload));

      // Stage B retries are idempotent only for the exact payload already
      // accepted for this request. Do this check before the state guard because
      // the first successful submission necessarily advances the operation.
      if (dpi.paymentPayloadHash === paymentPayloadHash) {
        // F-05 fix (external audit 2026-10-25): AUTHORIZED with the SAME
        // payload means a previous attempt crashed or failed AFTER persisting
        // the authorization but BEFORE (or without durably completing) the
        // facilitator submission. Returning buildResult() here left the
        // payment stuck in AUTHORIZED forever while the retry LOOKED
        // idempotent. Resume the submission instead; the EIP-3009 nonce
        // (AuthorizationUsed on-chain) remains the double-settle guard.
        if (dpi.settlementState === 'AUTHORIZED') {
          return await this.resumeAuthorizedSubmission(operation, dpi);
        }
        // Truly advanced states (SUBMITTING/SUBMITTED/RECONCILING/SETTLED/…)
        // are owned by the in-flight submission or the reconciliation worker:
        // keep the idempotent response — never blind-resubmit (§14).
        return this.buildResult(operation);
      }

      throw new Error(
        `PAYMENT_PAYLOAD_RETRY_MISMATCH: ${operation.currentState}`,
      );
    }
    if (operation.currentState !== 'AWAITING_SIGNATURE') {
      throw new Error(`REQUEST_NOT_AWAITING_SIGNATURE: ${operation.currentState}`);
    }

    const requirement = await this.getPaymentRequirementFromEvidence(operation)
      ?? this.requirementFromIntent(dpi);
    if (!requirement) throw new Error('PAYMENT_REQUIREMENT_NOT_FOUND');
    this.validateExternalPaymentPayload(externallySignedPaymentPayload, dpi, requirement);

    const serializedPayload = JSON.stringify(externallySignedPaymentPayload);
    const paymentPayloadHash = keccak256(toBytes(serializedPayload));
    const durableStore = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;

    // F-108/F-109 fix (external audit 2026-10-26): bind the signed payload AND
    // the AUTHORIZED state in ONE CAS-guarded statement. The previous pair of
    // blind writes (updatePaymentIntentAuthorization + updatePaymentIntentStatus)
    // let two concurrent Stage B callers — both having passed the
    // PENDING_SIGNATURE check above (TOCTOU) — overwrite each other's payload
    // (last-writer-wins) and regress an intent a concurrent submission had
    // already advanced back to AUTHORIZED. The CAS makes the payload
    // immutable once bound: a conflicting payload fails closed.
    if (typeof durableStore.authorizePaymentIntent === 'function') {
      const won = await durableStore.authorizePaymentIntent(dpi.paymentIntentId, {
        paymentPayload: serializedPayload,
        paymentPayloadHash,
      }, 'PENDING_SIGNATURE');
      if (!won) {
        // CAS lost, identical payload already durably bound: a concurrent
        // duplicate owns the pipeline (it may be mid-submission). NEVER
        // resubmit here (§14) — if the winner died before submitting, the
        // F-05 resume path above handles it on the NEXT retry, once its
        // AUTHORIZED state is actually stale. Report the freshest state.
        const freshOp = await this.config.evidenceStore.getOperation(operation.operationId);
        return this.buildResult(freshOp ?? operation);
      }
    } else {
      // Legacy stores without the CAS primitive: retain the old pair.
      // (Test fakes and third-party stores; both writes remain non-atomic
      // there — documented, not silently fixed.)
      if (
        typeof durableStore.updatePaymentIntentAuthorization !== 'function' ||
        typeof durableStore.updatePaymentIntentStatus !== 'function'
      ) {
        throw new Error('Non-custodial flow requires payment intent authorization persistence');
      }
      await durableStore.updatePaymentIntentAuthorization(dpi.paymentIntentId, {
        paymentPayload: serializedPayload,
        paymentPayloadHash,
      });
      await durableStore.updatePaymentIntentStatus(dpi.paymentIntentId, 'AUTHORIZED');
    }
    if (typeof durableStore.markNonceSigned === 'function') {
      await durableStore.markNonceSigned(dpi.nonce);
    }

    const authorization: PaymentAuthorization = {
      signature: externallySignedPaymentPayload.payload.signature,
      scheme: externallySignedPaymentPayload.accepted.scheme,
      timestamp: now(),
      context: {
        operationId: operation.operationId,
        requirement,
        nonce: dpi.nonce,
      },
      authorizer: dpi.authorizer,
      payTo: dpi.payTo,
      value: dpi.value,
      validAfter: dpi.validAfter,
      validBefore: dpi.validBefore,
    };
    const paymentIntent: PaymentIntent = {
      operationId: operation.operationId,
      requirement,
      amount: dpi.value,
      asset: dpi.asset,
      network: dpi.network,
      authorization,
      createdAt: dpi.createdAt,
      status: 'AUTHORIZED',
    };

    this.transitionState(operation, 'AUTHORIZED');
    operation.paymentState = 'AUTHORIZED';
    this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_AUTHORIZED', {
      intent: paymentIntent,
      source: 'EXTERNAL_SIGNED_PAYMENT_PAYLOAD',
    });
    await this.persistOperation(operation);

    await this.submitPayment(operation);
    await this.observeSettlement(operation);
    const finalState = String(operation.currentState) as OperationStatus;
    if (finalState === 'SETTLED' || finalState === 'EXECUTION_PENDING') {
      await this.settleToExecution(operation);
    }
    await this.persistOperation(operation);
    return this.buildResult(operation);
  }

  /**
   * F-05 fix: resume a submission whose durable intent reached AUTHORIZED but
   * whose facilitator submission never durably completed (crash or failure
   * between authorization persistence and submitPayment). The signed payload
   * hash was already verified against the durable intent by the caller; the
   * on-chain AuthorizationUsed nonce remains the double-settle guard.
   */
  private async resumeAuthorizedSubmission(
    operation: Operation,
    dpi: DurablePaymentIntent,
  ): Promise<ExecutionResult> {
    const requirement = await this.getPaymentRequirementFromEvidence(operation)
      ?? this.requirementFromIntent(dpi);
    if (!requirement) throw new Error('PAYMENT_REQUIREMENT_NOT_FOUND');

    this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_SUBMISSION_RESUMED', {
      paymentIntentId: dpi.paymentIntentId,
      settlementState: dpi.settlementState,
      reason: 'AUTHORIZED without durably completed submission — resuming Stage B',
    });

    // The durable intent is the authority on authorization state: force the
    // in-memory FSM to AUTHORIZED (the durable state already IS authorized)
    // and re-drive the same submission pipeline as the normal flow.
    operation.paymentState = 'AUTHORIZED';
    operation.currentState = 'AUTHORIZED';
    await this.persistOperation(operation);

    await this.submitPayment(operation);
    await this.observeSettlement(operation);
    const resumedState = String(operation.currentState) as OperationStatus;
    if (resumedState === 'SETTLED' || resumedState === 'EXECUTION_PENDING') {
      await this.settleToExecution(operation);
    }
    await this.persistOperation(operation);
    return this.buildResult(operation);
  }

  // ==========================================================================
  // OPERATION CREATION
  // ==========================================================================

  private createOperation(operationId: string, requestId: string, request: ExecuteRequest): Operation {
    const operation: Operation = {
      operationId,
      requestId,
      clientId: request.clientId,
      target: request.target,
      method: request.method,
      requestPayload: request.payload,
      paymentPolicy: request.policy,
      paymentState: 'NOT_STARTED',
      executionState: 'NOT_STARTED',
      deliveryState: 'NOT_STARTED',
      currentState: 'CREATED',
      timestamps: {
        createdAt: now(),
        updatedAt: now(),
      },
      evidence: [],
    };

    // Record creation evidence
    this.recordEvidence(operation, 'FINAL', 'OPERATION_CREATED', {
      requestId,
      target: request.target,
      method: request.method,
    });

    return operation;
  }

  // ==========================================================================
  // PHASE 1: DISCOVERY
  // ==========================================================================

  private async discoveryPhase(operation: Operation): Promise<void> {
    this.transitionState(operation, 'DISCOVERING');
    this.recordEvidence(operation, 'DISCOVERY', 'DISCOVERY_STARTED', {
      target: operation.target,
    });

    try {
      // Make initial request to discover if payment is required.
      // F-09 fix: client-supplied target is validated against the egress
      // policy (no loopback/private/metadata destinations, no redirects).
      // R7-C5 (external audit 2026-10-26): GET/HEAD requests never carry a
      // body — (a) undici throws a TypeError on GET+body (surfaced as
      // DISCOVERY_ERROR → FAILED for perfectly valid GET APIs), and
      // (b) sending the FULL request payload during a pre-payment probe
      // fires side effects before any payment decision. Bodyless methods
      // are now probed without the payload (payment requirement discovery
      // needs the endpoint, not the body).
      const isBodylessMethod = ['GET', 'HEAD'].includes(String(operation.method ?? '').toUpperCase());
      const response = await egressFetch(operation.target, {
        method: operation.method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: !isBodylessMethod && operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
      });

      if (response.status === 402) {
        // Payment required - parse payment requirement
        await this.handlePaymentRequired(operation, response);
      } else if (response.ok) {
        // No payment required - direct success
        await this.handleDirectSuccess(operation, response);
      } else {
        // Other error
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      this.recordEvidence(operation, 'DISCOVERY', 'DISCOVERY_ERROR', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handlePaymentRequired(operation: Operation, response: Response): Promise<void> {
    this.transitionState(operation, 'PAYMENT_REQUIRED');
    operation.timestamps.paymentRequiredAt = now();

    // Parse payment requirement using x402 v2 parser (Priority: header > body)
    const accepts: X402Accept[] = await X402Parser.parseResponse(response);
    if (accepts.length === 0) {
      throw new Error('No valid x402 accepts found');
    }
    
    const paymentRequirement = this.acceptToRequirement(accepts[0]);
    
    this.recordEvidence(operation, 'DISCOVERY', 'PAYMENT_REQUIREMENT_RECEIVED', {
      requirement: paymentRequirement,
    });

    // Snapshot seller capability immediately after discovery
    await this.capabilityResolver.resolveAndSnapshot(operation, response.headers);
    
    this.recordEvidence(operation, 'DISCOVERY', 'SELLER_CAPABILITIES_DISCOVERED', {
      capabilities: operation.sellerCapability,
    });
  }

  private async handleDirectSuccess(operation: Operation, response: Response): Promise<void> {
    const body = await response.json().catch(() => null);
    
    operation.resultData = body;
    operation.executionState = 'CONFIRMED';
    operation.deliveryState = 'DELIVERED';
    operation.executionEvidence = {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      timestamp: now(),
      source: 'HTTP_RESPONSE',
    };

    this.transitionState(operation, 'SUCCESS');
    operation.timestamps.completedAt = now();

    this.recordEvidence(operation, 'FINAL', 'DIRECT_SUCCESS', {
      statusCode: response.status,
    });
  }

  // ==========================================================================
  // PHASE 2: POLICY VALIDATION
  // ==========================================================================

  private async validatePolicy(operation: Operation): Promise<boolean> {
    this.recordEvidence(operation, 'POLICY', 'POLICY_VALIDATION_STARTED', {});

    const policy = operation.paymentPolicy;
    const requirement = await this.getPaymentRequirementFromEvidence(operation);
    
    if (!requirement) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_VALIDATION_FAILED', {
        reason: 'No payment requirement found',
      });
      return false;
    }

    // Check max price.
    // R0 repair: unit-consistent comparison. x402 requirement amounts are
    // smallest-unit integers ("500000"), while legacy human quotes are decimal
    // strings ("1.00").
    // F-08 fix (external audit 2026-10-25): the legacy parseFloat fallback
    // made malformed limits a silent no-op (NaN comparisons are false → the
    // payment PASSED), and mixed-unit comparisons (smallest-unit integer vs
    // human decimal) were unit errors, not arithmetic. Now:
    //   1. A non-decimal maxPrice REJECTS the policy (fail closed);
    //   2. int vs int       → exact BigInt magnitudes (unchanged);
    //   3. decimal vs decimal → exact scaled-BigInt comparison (no float math);
    //   4. int vs decimal   → INCOMPARABLE units → REJECT (fail closed).
    const isInt = (s: string) => /^\d+$/.test(s);
    const isDecimal = (s: string) => /^\d+(\.\d+)?$/.test(s);
    const hasDot = (s: string) => s.includes(".");
    const reqAmount = String(requirement.amount).trim();
    const maxPrice = String(policy.maxPrice).trim();
    if (!isDecimal(maxPrice)) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Invalid maxPrice format (expected a non-negative decimal number)',
        required: reqAmount,
        maxAllowed: policy.maxPrice,
      });
      return false;
    }
    const scaled = (s: string, scale: number): bigint => {
      const [intPart, fracPart = ""] = s.split(".");
      return BigInt(intPart + fracPart.padEnd(scale, "0"));
    };
    let exceeds: boolean;
    let rejectUnits = false;
    if (isInt(reqAmount) && isInt(maxPrice)) {
      // Same canonical (unit-less integer) representation → exact magnitudes.
      exceeds = BigInt(reqAmount) > BigInt(maxPrice);
    } else if (hasDot(reqAmount) && hasDot(maxPrice)) {
      // Both are human decimals → exact scaled comparison, no float math.
      const scale = Math.max(reqAmount.split(".")[1].length, maxPrice.split(".")[1].length);
      exceeds = scaled(reqAmount, scale) > scaled(maxPrice, scale);
    } else {
      // Mixed units: one side is a smallest-unit integer, the other a human
      // decimal. Without asset decimals the conversion is unknowable —
      // comparing them is a unit error, not arithmetic. Fail closed.
      exceeds = false;
      rejectUnits = true;
    }
    if (rejectUnits) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'INCOMPARABLE_UNITS: requirement.amount is a smallest-unit integer while maxPrice is a human decimal — provide maxPrice in the same unit',
        required: reqAmount,
        maxAllowed: policy.maxPrice,
      });
      return false;
    }
    if (exceeds) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Amount exceeds maxPrice',
        required: reqAmount,
        maxAllowed: maxPrice,
      });
      return false;
    }

    // Check allowed networks
    // R7-B11b (external audit 2026-10-26): policy list comparisons are
    // CASE-INSENSITIVE — sellers/parsers may emit checksummed contract
    // addresses (0xAbC…) or differently-cased CAIP-2 ids while the policy
    // lists lowercase ones (or vice versa). Money policy must not reject on
    // casing.
    const norm = (v: string): string => String(v ?? "").trim().toLowerCase();
    if (!policy.allowedNetworks.map(norm).includes(norm(requirement.network))) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Network not allowed',
        required: requirement.network,
        allowed: policy.allowedNetworks,
      });
      return false;
    }

    // Check allowed assets
    if (!policy.allowedAssets.map(norm).includes(norm(requirement.asset))) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Asset not allowed',
        required: requirement.asset,
        allowed: policy.allowedAssets,
      });
      return false;
    }

    // Check allowed sellers (if specified)
    if (policy.allowedSellers && !policy.allowedSellers.map(norm).includes(norm(requirement.payee))) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Seller not allowed',
        required: requirement.payee,
        allowed: policy.allowedSellers,
      });
      return false;
    }

    this.recordEvidence(operation, 'POLICY', 'POLICY_VALIDATION_PASSED', {
      amount: requirement.amount,
      network: requirement.network,
      asset: requirement.asset,
      payee: requirement.payee,
    });

    return true;
  }

  // ==========================================================================
  // PHASE 3: PAYMENT AUTHORIZATION
  // ==========================================================================

  private async authorizePayment(operation: Operation): Promise<void> {
    this.transitionState(operation, 'AUTHORIZED');
    operation.timestamps.authorizedAt = now();

    const configuredSigner = this.config.signer;
    if (!configuredSigner) {
      throw new Error('NON_CUSTODIAL_SIGNATURE_REQUIRED: use submitSignedPayment()');
    }

    const requirement = await this.getPaymentRequirementFromEvidence(operation);
    if (!requirement) {
      throw new Error('No payment requirement found for authorization');
    }

    const canonicalV2 = Boolean(this.config.settlementAdapter);
    const adapter = canonicalV2 ? this.config.adapters.get(requirement.network) : this.getAdapterForNetwork(requirement.network);
    const durableStore = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    const signerWithAddress = configuredSigner as PaymentSigner & {
      getAddress?: () => Promise<string>;
    };
    const existingIntent = canonicalV2 && typeof durableStore.getPaymentIntentByOperationId === 'function'
      ? await durableStore.getPaymentIntentByOperationId(operation.operationId)
      : null;

    // The nonce is part of the immutable signing context, not something
    // invented after the signature has already been requested.
    const authorizer = canonicalV2
      ? requireNonEmpty(await signerWithAddress.getAddress?.(), "authorizer")
      : await signerWithAddress.getAddress?.();
    const payTo = requireNonEmpty(requirement.payee, "payTo");
    if (existingIntent && existingIntent.authorizer !== authorizer) {
      throw new Error(`Payment intent binding mismatch for operation ${operation.operationId}`);
    }
    const validAfter = existingIntent?.validAfter ?? Math.floor(now() / 1000);
    const validBefore = existingIntent?.validBefore ?? toEpochSeconds(requirement.deadline, now());
    if (validBefore <= validAfter) {
      throw new Error("Invalid payment authorization: validBefore must be after validAfter");
    }
    const context: SigningContext = {
      operationId: operation.operationId,
      requirement,
      nonce: existingIntent?.nonce ?? new CryptoNonceGenerator().generate(),
    };

    // B8.2-B.1: the canonical DPI is created before asking the signer for a
    // signature. The pending payload is replaced atomically once signing
    // returns; the binding fields are complete from the beginning.
    let preCreatedIntent: DurablePaymentIntent | null = null;
    if (canonicalV2) {
      const canonicalAuthorizer = requireNonEmpty(authorizer, "authorizer");
      const canonicalNonce = requireNonEmpty(context.nonce, "nonce");
      if (typeof durableStore.createPaymentIntent !== "function") {
        throw new Error("Canonical V2 payment flow requires durable payment intent persistence");
      }
      if (existingIntent) {
        if (
          existingIntent.authorizer !== canonicalAuthorizer ||
          existingIntent.payTo !== payTo ||
          existingIntent.nonce !== canonicalNonce ||
          existingIntent.value !== requirement.amount
        ) {
          throw new Error(`Payment intent binding mismatch for operation ${operation.operationId}`);
        }
        preCreatedIntent = existingIntent;
      } else {
        const pendingPayload = JSON.stringify({
          status: "SIGNING",
          operationId: operation.operationId,
          authorizer: canonicalAuthorizer,
          payTo,
          value: requirement.amount,
          asset: requirement.asset,
          network: requirement.network,
          nonce: canonicalNonce,
          validAfter,
          validBefore,
        });
        preCreatedIntent = {
          paymentIntentId: generatePaymentIntentId(),
          operationId: operation.operationId,
          requestId: operation.requestId,
          clientId: operation.clientId,
          authorizer: canonicalAuthorizer,
          payTo,
          value: requirement.amount,
          asset: requirement.asset,
          network: requirement.network,
          nonce: canonicalNonce,
          validAfter,
          validBefore,
          paymentPayload: pendingPayload,
          paymentPayloadHash: keccak256(toBytes(pendingPayload)),
          // F-109 fix (external audit 2026-10-26): the intent is created BEFORE
          // the signature exists, so its honest state is PENDING_SIGNATURE.
          // Claiming AUTHORIZED here opened a window where an intent was
          // durably "authorized" while still carrying the unsigned SIGNING
          // placeholder payload. authorizePaymentIntent() below performs the
          // single atomic PENDING_SIGNATURE → AUTHORIZED transition together
          // with the real payload.
          settlementState: "PENDING_SIGNATURE",
          createdAt: now(),
          updatedAt: now(),
        };
        if (typeof durableStore.createIntentWithNonce === "function") {
          await durableStore.createIntentWithNonce(preCreatedIntent, canonicalAuthorizer);
        } else {
          await durableStore.createPaymentIntent(preCreatedIntent);
        }
      }
    }

    let authorization: PaymentAuthorization;
    if (canonicalV2 && adapter) {
       authorization = await adapter.createAuthorization(requirement, configuredSigner, context);
    } else if (canonicalV2) {
      const strictSigner = this.config.signer as unknown as {
        signPayment(request: PaymentAuthorizationRequest): Promise<PaymentSignatureResult>;
      };
      const signed = await strictSigner.signPayment({
        operationId: operation.operationId,
        scheme: "exact",
        network: requirement.network,
        asset: requirement.asset,
        payer: requireNonEmpty(authorizer, "authorizer"),
        payTo,
        amount: requirement.amount,
        nonce: context.nonce!,
        validAfter,
        validBefore,
        createdAt: new Date().toISOString(),
      });
      if (signed.operationId !== operation.operationId || signed.payer !== authorizer || signed.nonce !== context.nonce) {
        throw new Error(`Payment signer binding mismatch for operation ${operation.operationId}`);
      }
      authorization = {
        signature: requireNonEmpty(signed.signature, "signature"),
        scheme: "exact",
        timestamp: Date.parse(signed.signedAt) || now(),
        context,
        authorizer: signed.payer,
        payTo,
        value: requirement.amount,
        validAfter,
        validBefore,
      };
    } else {
      if (!adapter) {
        throw new Error(`No payment adapter found for network: ${requirement.network}`);
      }
       authorization = await adapter.createAuthorization(requirement, configuredSigner, context);
    }

    requireNonEmpty(authorization.signature, "signature");
    if (canonicalV2) {
      const persistedAuthorizer = requireNonEmpty(authorization.authorizer ?? authorizer, "authorizer");
      if (persistedAuthorizer !== authorizer) {
        throw new Error(`Payment authorization authorizer mismatch for operation ${operation.operationId}`);
      }
      if (authorization.payTo !== undefined && authorization.payTo !== payTo) {
        throw new Error(`Payment authorization payTo mismatch for operation ${operation.operationId}`);
      }
      if (authorization.context.nonce !== context.nonce) {
        throw new Error(`Payment authorization nonce mismatch for operation ${operation.operationId}`);
      }

      const signedPayload: PaymentPayload = {
        x402Version: 2 as const,
        accepted: {
          scheme: authorization.scheme || "exact",
          network: requirement.network,
          amount: requirement.amount,
          asset: requirement.asset,
          payTo,
          maxTimeoutSeconds: validBefore - validAfter,
        },
        payload: {
          signature: authorization.signature,
          authorization: {
            from: persistedAuthorizer,
            to: payTo,
            value: requirement.amount,
            validAfter: String(validAfter),
            validBefore: String(validBefore),
            nonce: context.nonce!,
          },
        },
      };
      const serializedPayload = JSON.stringify(signedPayload);
      // R0 repair: call the method ON its receiver. The previous
      // `const updateAuthorization = store.updatePaymentIntentAuthorization;`
      // extraction dropped `this`, crashing every store whose implementation
      // touches instance state (e.g. InMemoryEvidenceStore).
      if (preCreatedIntent && typeof durableStore.authorizePaymentIntent === "function") {
        // F-108/F-109 fix (external audit 2026-10-26): swap the SIGNING
        // placeholder for the signed payload and flip PENDING_SIGNATURE →
        // AUTHORIZED in ONE CAS-guarded statement. The previous blind
        // updatePaymentIntentAuthorization() write let two concurrent signing
        // attempts overwrite each other's payload (last-writer-wins).
        let won: boolean;
        try {
          won = await durableStore.authorizePaymentIntent(preCreatedIntent.paymentIntentId, {
            paymentPayload: serializedPayload,
            paymentPayloadHash: keccak256(toBytes(serializedPayload)),
          }, "PENDING_SIGNATURE");
        } catch (err) {
          // Auto flow only: a lost race re-signed the SAME intent binding
          // (unique operation_id → same nonce), so the concurrent duplicate's
          // signature is equally valid for this EIP-3009 authorization. The
          // durable payload is authoritative — proceed against it without
          // overwriting anything. Any OTHER error propagates.
          if (
            err instanceof Error &&
            err.message.startsWith("PAYMENT_INTENT_AUTHORIZATION_CONFLICT")
          ) {
            won = false;
          } else {
            throw err;
          }
        }
        if (!won) {
          // Lost the CAS. Record the handoff honestly; submitPayment() below
          // re-reads the DURABLE intent and submits the durable payload.
          this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_AUTHORIZATION_CAS_LOSS', {
            paymentIntentId: preCreatedIntent.paymentIntentId,
            reason: 'concurrent signing attempt bound its payload first — durable payload kept',
          });
        }
      } else if (preCreatedIntent && typeof durableStore.updatePaymentIntentAuthorization === "function") {
        // Legacy stores without the CAS primitive: retain the blind pair.
        await durableStore.updatePaymentIntentAuthorization.call(durableStore, preCreatedIntent.paymentIntentId, {
          paymentPayload: serializedPayload,
          paymentPayloadHash: keccak256(toBytes(serializedPayload)),
        });
        if (
          preCreatedIntent.settlementState === "PENDING_SIGNATURE" &&
          typeof durableStore.updatePaymentIntentStatus === "function"
        ) {
          await durableStore.updatePaymentIntentStatus(preCreatedIntent.paymentIntentId, "AUTHORIZED");
        }
      }
    }

    // Legacy stores retain a transient compatibility record, but it still
    // carries a real nonce, signer address, and payload hash.
    if (!canonicalV2 && typeof durableStore.createPaymentIntent === "function") {
      const legacyAuthorizer = requireNonEmpty(authorization.authorizer ?? authorizer, "authorizer");
      const payload = authorization.signature;
      const durableIntent: DurablePaymentIntent = {
        paymentIntentId: generatePaymentIntentId(),
        operationId: operation.operationId,
        requestId: operation.requestId,
        clientId: operation.clientId,
        authorizer: legacyAuthorizer,
        payTo,
        value: requirement.amount,
        asset: requirement.asset,
        network: requirement.network,
        nonce: context.nonce!,
        validAfter,
        validBefore,
        paymentPayload: payload,
        paymentPayloadHash: keccak256(toBytes(payload)),
        settlementState: "AUTHORIZED",
        createdAt: now(),
        updatedAt: now(),
      };
      await durableStore.createPaymentIntent(durableIntent);
    }

    // Retain local PaymentIntent as transient orchestration data for legacy flow continuity.
    // Source of truth is DurablePaymentIntent above.
    const paymentIntent: PaymentIntent = {
      operationId: operation.operationId,
      requirement,
      amount: requirement.amount,
      asset: requirement.asset,
      network: requirement.network,
      authorization,
      createdAt: now(),
      status: 'AUTHORIZED',
    };

    this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_AUTHORIZED', {
      intent: paymentIntent,
    });

    operation.paymentState = 'AUTHORIZED';
  }

  // ==========================================================================
  // PHASE 4: PAYMENT SUBMISSION
  // CRITICAL: After this point, we cannot blindly retry
  // ==========================================================================

  private async submitPayment(operation: Operation): Promise<void> {
    this.transitionState(operation, 'PAYMENT_SUBMITTED');
    operation.timestamps.paymentSubmittedAt = now();

    // B8.2-B.2: Use canonical V2 settlement path via SettlementAdapter.
    // Legacy PaymentAdapter.submit() is NOT used for production submission.

    // 1. Retrieve persisted DurablePaymentIntent (authoritative record from B.1)
    const durableStore = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    const dpi = typeof durableStore.getPaymentIntentByOperationId === "function"
      ? await durableStore.getPaymentIntentByOperationId(operation.operationId)
      : null;

    if (!dpi) {
      throw new Error('No DurablePaymentIntent found for submission — B.1 persistence required');
    }

    // 2. Retrieve authorization from evidence (created in authorizePayment).
    // F-05 fix: fall back to the DURABLE signed payload when the evidence
    // record was not yet persisted (crash between updatePaymentIntentAuthorization
    // and persistOperation). The durable payload is the authoritative signed
    // authorization — hash-verified before it was persisted.
    const authorization = await this.getAuthorizationFromEvidence(operation)
      ?? this.authorizationFromDurableIntent(dpi);
    if (!authorization) {
      throw new Error('No payment authorization found for submission');
    }

    // 3. Construct canonical V2 PaymentPayload from DPI + authorization
    const v2Payload: PaymentPayload = {
      x402Version: 2 as const,
      accepted: {
        scheme: authorization.scheme || "exact",
        network: dpi.network,
        amount: dpi.value,
        asset: dpi.asset,
        payTo: dpi.payTo,
        maxTimeoutSeconds: dpi.validBefore > 0 && dpi.validAfter >= 0
          ? dpi.validBefore - dpi.validAfter
          : 300,
      },
      payload: {
        signature: authorization.signature,
        authorization: {
          from: dpi.authorizer || "",
          to: dpi.payTo,
          value: dpi.value,
          validAfter: String(dpi.validAfter),
          validBefore: String(dpi.validBefore),
          nonce: dpi.nonce,
        },
      },
    };

    // 4. Submit — R9-A1: transport selection.
    //    "zeus"     (default): settle via the configured SettlementAdapter
    //               (zeus-facilitator) BEFORE the seller leg (pay-then-prove).
    //    "standard": the signed payload rides in PAYMENT-SIGNATURE to a
    //               third-party seller; the SELLER's facilitator verifies +
    //               settles during the paid request, and the SAME response
    //               carries the settlement receipt and the route result.
    const transportMode = this.resolvePaymentTransport(operation);
    let result: SubmitResult;
    if (transportMode === 'standard') {
      const standardTransport = this.config.standardTransport;
      if (!standardTransport) {
        throw new Error(
          'Standard x402 transport requested (policy.transport="standard") but no standardTransport is configured'
        );
      }
      const isBodylessMethod = ['GET', 'HEAD'].includes(String(operation.method ?? '').toUpperCase());
      const target: StandardTransportTarget = {
        url: operation.target,
        method: operation.method,
        body: !isBodylessMethod && operation.requestPayload !== undefined
          ? JSON.stringify(operation.requestPayload)
          : undefined,
      };
      // The header payload must mirror the DISCOVERED requirements: the
      // seller's middleware verifies against its own route config, so the
      // advertised maxTimeoutSeconds (dropped from the DPI window arithmetic)
      // is restored from the discovery evidence when available.
      const discovered = await this.getPaymentRequirementFromEvidence(operation);
      const discoveredMaxTimeout = typeof discovered?.maxTimeoutSeconds === 'number'
        ? discovered.maxTimeoutSeconds
        : undefined;
      const payloadForStandard: PaymentPayload = {
        ...v2Payload,
        resource: { url: operation.target },
        accepted: {
          ...v2Payload.accepted,
          ...(discoveredMaxTimeout !== undefined ? { maxTimeoutSeconds: discoveredMaxTimeout } : {}),
        },
      };
      result = await standardTransport.submit(dpi, payloadForStandard, target);

      // The paid call IS the delivery. Capture the seller's answer as
      // execution evidence (durably mirrored in the intent via the
      // STANDARD_PAID_CALL marker, so a crash right after the paid call
      // cannot lose the result — SettlementFeedbackService completes from
      // the marker). UNKNOWN carries no rawResponse by contract — the
      // marker stays readable on the durable intent for forensics.
      const marker: unknown =
        result.status === 'UNKNOWN' ? null : result.rawResponse;
      if (result.status === 'SUBMITTED' && isStandardPaidCallRecord(marker)) {
        operation.resultData = marker.sellerBody ?? undefined;
        operation.executionEvidence = {
          statusCode: marker.sellerHttpStatus,
          body: marker.sellerBody,
          timestamp: marker.capturedAt,
          source: 'STANDARD_TRANSPORT',
        };
      }
      this.recordEvidence(operation, 'PAYMENT', 'STANDARD_PAID_CALL', {
        verdict: result.status,
        sellerHttpStatus: isStandardPaidCallRecord(marker) ? marker.sellerHttpStatus : undefined,
        ...(result.status === 'SUBMITTED' ? { transactionHash: result.txHash } : {}),
        ...(result.status === 'REJECTED' ? { reason: result.reason } : {}),
        ...(result.status === 'UNKNOWN' ? { error: result.error } : {}),
      });
    } else {
      const settlementAdapter = this.config.settlementAdapter;
      if (!settlementAdapter) {
        throw new Error('No settlementAdapter configured — required for V2 payment submission');
      }

      result = await settlementAdapter.submit(dpi, v2Payload);
    }

    // 5. Handle result
    if (result.status === "REJECTED") {
      this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_SUBMISSION_FAILED', {
        error: result.reason,
      });
      throw new Error(result.reason ?? 'Payment submission rejected');
    }

    if (result.status === "UNKNOWN") {
      // UNKNOWN remains UNKNOWN — do NOT convert to FAILED
      this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_SUBMISSION_UNKNOWN', {
        error: result.error,
      });
      operation.paymentState = 'SUBMITTED';
      return;
    }

    // SUBMITTED
    this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_SUBMITTED', {
      transactionHash: result.txHash,
      rawData: result.rawResponse,
    });

    operation.paymentState = 'SUBMITTED';
  }

  // ==========================================================================
  // PHASE 5: SETTLEMENT OBSERVATION
  // CRITICAL: Must determine settlement status before any recovery action
  // ==========================================================================

  private async observeSettlement(operation: Operation): Promise<void> {
    // B8.2-B.3-A: Canonical reconciliation via ReconciliationEngine.
    // Legacy PaymentAdapter.observeSettlement() is NO LONGER USED in production path.

    // 1. Retrieve persisted DPI to get paymentIntentId
    const durableStore = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    const dpi = typeof durableStore.getPaymentIntentByOperationId === "function"
      ? await durableStore.getPaymentIntentByOperationId(operation.operationId)
      : null;

    if (!dpi) {
      throw new Error('No DurablePaymentIntent found for reconciliation');
    }

    // 2. Call canonical ReconciliationEngine
    const reconEngine = this.config.reconciliationEngine;
    if (!reconEngine) {
      // No reconciliation engine configured — remain in current state, do not fail
      this.recordEvidence(operation, 'SETTLEMENT', 'RECONCILIATION_SKIPPED', {
        reason: 'No reconciliationEngine configured',
      });
      return;
    }

    this.recordEvidence(operation, 'SETTLEMENT', 'RECONCILIATION_STARTED', {
      paymentIntentId: dpi.paymentIntentId,
    });

    const outcome: ReconciliationOutcome = await reconEngine.reconcile(dpi.paymentIntentId);

    // 3. Map ReconciliationOutcome → OperationStatus transition
    switch (outcome.status) {
      case "SETTLED":
        this.transitionState(operation, 'SETTLED');
        operation.timestamps.settledAt = now();
        operation.paymentState = 'SETTLED';
        // Settlement proof is owned by ReconciliationEngine (evidence bundle).
        // StateMachine records orchestration event only.
        this.recordEvidence(operation, 'SETTLEMENT', 'SETTLEMENT_CONFIRMED', {
          paymentIntentId: dpi.paymentIntentId,
          evidenceBundle: outcome.evidence,
        });
        break;

      case "NOT_SETTLED":
        this.transitionState(operation, 'SETTLEMENT_FAILED');
        operation.paymentState = 'FAILED';
        this.recordEvidence(operation, 'SETTLEMENT', 'SETTLEMENT_NOT_CONFIRMED', {
          paymentIntentId: dpi.paymentIntentId,
          evidenceBundle: outcome.evidence,
        });
        break;

      case "RECONCILING": {
        // RECONCILING is NON-TERMINAL. Do NOT throw, do NOT convert to FAILED.
        this.transitionState(operation, 'SETTLEMENT_PENDING');
        operation.paymentState = 'UNKNOWN';

        // B.3-B2-WIRING: Create durable reconciliation job so worker can schedule next probe.
        // Idempotent: if active job already exists for this paymentIntentId, returns existing jobId.
        const nextProbeMs = outcome.nextProbeMs ?? 10_000;
        const nextProbeAt = new Date(Date.now() + nextProbeMs);

        try {
          if (typeof durableStore.createReconciliationJob !== "function") {
            throw new Error("Store does not implement createReconciliationJob");
          }
          const jobId = await durableStore.createReconciliationJob(dpi.paymentIntentId, nextProbeAt);
          this.recordEvidence(operation, 'SETTLEMENT', 'RECONCILIATION_JOB_CREATED', {
            paymentIntentId: dpi.paymentIntentId,
            jobId,
            nextProbeAt: nextProbeAt.toISOString(),
            nextProbeMs,
            reason: outcome.reason,
          });
        } catch (err) {
          // Job creation failed — record but do not throw.
          // recoverAfterCrash() will pick up non-terminal DPI on next startup.
          this.recordEvidence(operation, 'SETTLEMENT', 'RECONCILIATION_JOB_CREATION_FAILED', {
            paymentIntentId: dpi.paymentIntentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "UNRESOLVED_MANUAL":
        this.transitionState(operation, 'UNRESOLVABLE');
        operation.paymentState = 'FAILED';
        this.recordEvidence(operation, 'SETTLEMENT', 'RECONCILIATION_UNRESOLVED', {
          paymentIntentId: dpi.paymentIntentId,
          reason: outcome.reason,
        });
        break;

      case "INCIDENT":
        this.transitionState(operation, 'UNRESOLVABLE');
        operation.paymentState = 'FAILED';
        this.recordEvidence(operation, 'SETTLEMENT', 'RECONCILIATION_INCIDENT', {
          paymentIntentId: dpi.paymentIntentId,
          reason: outcome.reason,
        });
        break;
    }
  }

  // PHASE 8: DELIVERY
  // ==========================================================================

  private async deliver(operation: Operation): Promise<void> {
    operation.deliveryState = 'DELIVERED';
    operation.timestamps.deliveredAt = now();

    this.recordEvidence(operation, 'DELIVERY', 'DELIVERY_COMPLETED', {});

    // R9-A1 (2026-10-26): the F-110 authoritative FSM routes
    // EXECUTION_CONFIRMED → DELIVERED → SUCCESS. The old direct hop
    // EXECUTION_CONFIRMED → SUCCESS predates the single-source table and was
    // unreachable in the Zeus sync path (execution confirms asynchronously via
    // ExecutionFeedbackService, so execute() never entered step 8 with
    // EXECUTION_CONFIRMED). The standard x402 transport discharges execution
    // inline, making this path live — follow the table.
    this.transitionState(operation, 'DELIVERED');
    this.transitionState(operation, 'SUCCESS');
    operation.timestamps.completedAt = now();
  }

  // ==========================================================================
  // FAILURE HANDLING
  // ==========================================================================

  private async failOperation(
    operation: Operation,
    status: OperationStatus,
    error: string
  ): Promise<ExecutionResult> {
    operation.currentState = status;
    // Repair C3: the ORIGINAL business error must remain visible even when
    // evidence persistence later fails. Never overwrite it with a persistence
    // error.
    operation.error = error;
    operation.timestamps.failedAt = now();
    operation.timestamps.updatedAt = now();

    this.recordEvidence(operation, 'FINAL', 'OPERATION_FAILED', {
      status,
      error,
    });

    const result = this.buildResult(operation);

    // Repair C3: the terminal operation snapshot must be durable BEFORE we
    // attempt the evidence flush, so a reload/restart can find the FAILED
    // operation. Snapshot failure is best-effort here — the evidence flush
    // outcome governs the persistenceError below.
    try {
      await this.config.evidenceStore.saveOperation(operation);
    } catch {
      /* secondary to the evidence-flush outcome handled below */
    }

    let persistenceFailure: Error | null = null;
    try {
      await this.flushPendingEvidence(operation);
    } catch (err) {
      // Persistence exhausted its bounded retries. Expose BOTH errors:
      // result.error keeps the business failure; result.persistenceError
      // carries EVIDENCE_PERSISTENCE_FAILED details.
      persistenceFailure = err instanceof Error ? err : new Error(String(err));
    }

    if (persistenceFailure) {
      result.persistenceError = {
        code: 'EVIDENCE_PERSISTENCE_FAILED',
        message: persistenceFailure.message,
        pendingEvidenceCount: Math.max(
          0,
          operation.evidence.length -
            (this.persistedEvidenceCount.get(operation.operationId) ?? 0)
        ),
        attempts: this.evidenceFlushAttempts(),
      };
    }

    return result;
  }

  // ==========================================================================
  // STATE TRANSITION
  // ==========================================================================

  private transitionState(operation: Operation, newState: OperationStatus): void {
    if (!isValidTransition(operation.currentState, newState)) {
      throw new Error(
        `Invalid state transition: ${operation.currentState} → ${newState}`
      );
    }

    const oldState = operation.currentState;
    operation.currentState = newState;
    operation.timestamps.updatedAt = now();

    this.recordEvidence(operation, 'FINAL', 'STATE_TRANSITION', {
      from: oldState,
      to: newState,
    });
  }

  // ==========================================================================
  // EVIDENCE RECORDING
  // ==========================================================================

  private recordEvidence(
    operation: Operation,
    phase: EvidencePhase,
    event: string,
    payload: unknown
  ): void {
    const record: EvidenceRecord = {
      operationId: operation.operationId,
      phase,
      timestamp: now(),
      event,
      payload,
      // Repair C3: deterministic chronological ordering key. Derived from the
      // operation's own evidence array length at creation time, so it is
      // stable across retries (the record object is never re-sequenced) and
      // distinct for every legitimately separate record of the operation.
      sequence: operation.evidence.length,
    };

    operation.evidence.push(record);
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  private async persistOperation(operation: Operation): Promise<void> {
    // Repair C3: flush evidence FIRST. The durable outbox is the critical
    // artifact; saveOperation snapshots terminal state afterwards. If the
    // snapshot write fails (e.g. an intermediate state has no durable row
    // yet), pending evidence was already flushed and the cursor advanced,
    // so a later flush retries only the remainder without duplication.
    await this.flushPendingEvidence(operation);
    await this.config.evidenceStore.saveOperation(operation);
  }

  /**
   * Repair C3: durable-outbox flush.
   *
   * Appends EVERY evidence record not yet confirmed durably persisted, in
   * deterministic sequence order (sequence assigned at recordEvidence() time;
   * falls back to array index for legacy/reconstructed records without one).
   *
   * Cursor rules:
   *  - Advances only on a CONFIRMED successful append.
   *  - A failed append does NOT prove the DB made no change (ambiguous write).
   *    Re-appending is safe because store implementations key writes by a
   *    stable record-derived identity with conflict-safe insertion (see
   *    PostgresEvidenceStore), so an already-committed record cannot be
   *    duplicated by the retry.
   *  - Bounded attempts (config.evidencePersistenceRetries, default 3, clamped
   *    1..10). No infinite retries.
   *
   * On exhaustion throws Error('EVIDENCE_PERSISTENCE_FAILED: ...'). Callers
   * preserve the ORIGINAL business error separately; this error never
   * replaces it.
   */
  private async flushPendingEvidence(operation: Operation): Promise<void> {
    const store = this.config.evidenceStore;
    const opId = operation.operationId;
    const maxAttempts = this.evidenceFlushAttempts();
    let lastError: unknown = null;

    // Deterministic chronological order: sequence first, timestamp tiebreak.
    const ordered = operation.evidence
      .map((record, idx) => ({ record, key: record.sequence ?? idx }))
      .sort((a, b) => a.key - b.key || a.record.timestamp - b.record.timestamp);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let cursor = this.persistedEvidenceCount.get(opId) ?? 0;
      let hitFailure = false;

      for (const { record, key } of ordered) {
        if (key < cursor) continue; // already confirmed persisted
        try {
          await store.append(record);
          cursor = key + 1;
          this.persistedEvidenceCount.set(opId, cursor);
        } catch (err) {
          lastError = err;
          hitFailure = true;
          break; // stop flushing; retry remaining batch from this record
        }
      }

      if (!hitFailure) return; // full flush confirmed
    }

    const confirmed = this.persistedEvidenceCount.get(opId) ?? 0;
    const pending = Math.max(0, operation.evidence.length - confirmed);
    const msg =
      lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
    throw new Error(
      `EVIDENCE_PERSISTENCE_FAILED: ${pending} evidence record(s) unpersisted after ${maxAttempts} attempt(s); last error: ${msg}`
    );
  }

  // ==========================================================================
  // RESULT BUILDING
  // ==========================================================================

  /**
   * TASK 3+4+5: Atomically persist SETTLED state + execution obligation.
   *
   * This is the durable handoff boundary. After this method returns:
   *   - payment_intents.settlement_state = SETTLED (persisted)
   *   - recovery_jobs(EXECUTION, PENDING) exists (persisted)
   *   - execution_attempts(PENDING) exists (persisted)
   *
   * PostSettlementEngine.recoverPendingJobs() will discover and process the job.
   * StateMachine does NOT call sellerAdapter or manage execution attempts.
   *
   * If the store supports settleAndCreateExecutionObligation (PostgresExecutionStore),
   * the entire operation is atomic. Otherwise, falls back to sequential persistence.
   */
  /**
   * R2.1-FIX-5: Atomic settlement → execution handoff via typed contract.
   * Uses AtomicSettlementHandoff (required dependency) instead of duck-typing.
   * Sequential fallback REMOVED — production MUST provide atomic implementation.
   * Fails closed if atomic handoff is unavailable or returns false unexpectedly.
   */
  /**
   * R9-A1: resolve the payment transport for an operation.
   * Per-request policy wins; then the deployment default; then "zeus"
   * (the pre-existing pay-then-prove behavior) — no implicit behavior change
   * for any existing caller.
   */
  private resolvePaymentTransport(operation: Operation): 'zeus' | 'standard' {
    const policyTransport = operation.paymentPolicy?.transport;
    if (policyTransport === 'zeus' || policyTransport === 'standard') return policyTransport;
    return this.config.defaultPaymentTransport ?? 'zeus';
  }

  /**
   * R9-A1: settlement → execution dispatch.
   *
   * "zeus" mode: persist the durable execution obligation (PostSettlementEngine
   * owns the seller leg exclusively).
   *
   * "standard" mode: the paid x402 call ALREADY executed the seller route
   * atomically (verify → settle → route → response). Creating a post-settlement
   * execution obligation would re-call the seller WITHOUT payment (402) —
   * execution is discharged inline instead. Both FSM edges
   * (SETTLED → EXECUTION_PENDING → EXECUTION_CONFIRMED) exist in the
   * authoritative table; no handoff obligation is created, so the scanner
   * never sees a standard-mode intent as "settled without obligation"
   * (defense-in-depth: the scanner ALSO skips STANDARD_PAID_CALL markers).
   */
  private async settleToExecution(operation: Operation): Promise<void> {
    if (this.resolvePaymentTransport(operation) === 'standard') {
      this.transitionState(operation, 'EXECUTION_PENDING');
      this.transitionState(operation, 'EXECUTION_CONFIRMED');
      operation.executionState = 'CONFIRMED';
      operation.timestamps.executionConfirmedAt = now();
      this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_CONFIRMED', {
        source: 'STANDARD_TRANSPORT',
        note: 'execution discharged atomically by the paid x402 call — no post-settlement seller leg',
      });
      // Crash-window durability: a kill between here and step 8 must leave a
      // durable EXECUTION_CONFIRMED — the SettlementFeedbackService and the
      // FSM table replay it to SUCCESS on recovery.
      await this.persistOperation(operation);
      return;
    }
    await this.persistSettlementAndExecutionObligation(operation);
  }

  private async persistSettlementAndExecutionObligation(operation: Operation): Promise<void> {
    const now = Date.now();
    const jobId = `rj-${now}-${randomUUID()}`;
    const attemptId = `att-${now}-${randomUUID()}`;

    const job: RecoveryJob = {
      jobId,
      operationId: operation.operationId,
      jobType: "EXECUTION",
      status: "PENDING",
      priority: 0,
      // F-01 fix: honor the configured execution-attempt bound
      // (ZEUS_MAX_EXECUTION_ATTEMPTS) instead of a hardcoded 3.
      maxAttempts: this.config.maxExecutionAttempts ?? 3,
      currentAttempt: 0,
      // F-01 fix: carry the DISCOVERED recovery capability — fail-closed to
      // NONE (payment idempotency does NOT prove execution idempotency) —
      // instead of a hardcoded EXECUTION_IDEMPOTENT, plus the result-retrieval
      // endpoint advertised by the seller when available.
      metadata: {
        capability: operation.sellerCapability?.recoveryCapability ?? "NONE",
        requestBody: operation.requestPayload,
        ...(operation.sellerCapability?.resultRetrievalEndpoint
          ? { resultRetrievalEndpoint: operation.sellerCapability.resultRetrievalEndpoint }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    };

    const attempt: ExecutionAttempt = {
      attemptId,
      operationId: operation.operationId,
      executionId: operation.operationId, // INV-10: executionId = operationId
      attemptNumber: 1,
      status: "PENDING",
      // F-01 fix: the paid call must hit the EXACT target/method/payload the
      // Secretariat discovered and priced — never a config-level fallback.
      requestUrl: operation.target,
      requestMethod: operation.method,
      requestBody: operation.requestPayload,
      idempotencyKey: operation.operationId, // INV-11: stable idempotency key
      createdAt: now,
    };

    const settledEvidence = operation.settlementProof ?? {
      observedAt: now,
      source: "StateMachine.observeSettlement",
    };

    // B.3-B1: Retrieve authoritative DPI to obtain correct paymentIntentId.
    const durableStore = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    const dpi = typeof durableStore.getPaymentIntentByOperationId === "function"
      ? await durableStore.getPaymentIntentByOperationId(operation.operationId)
      : null;

    if (!dpi) {
      throw new Error(
        `Cannot create execution obligation: no DurablePaymentIntent found for operationId=${operation.operationId}. ` +
        `Settlement→execution handoff requires authoritative paymentIntentId from DPI.`
      );
    }

    // R2.1-FIX-5: Use typed AtomicSettlementHandoff contract directly.
    // No duck-type check. No sequential fallback. Fail closed.
    const success = await this.config.atomicSettlementHandoff.settleAndCreateExecutionObligation(
      dpi.paymentIntentId,     // ← payment domain identity (CAS on payment_intents)
      operation.operationId,   // ← execution domain identity (jobs/attempts)
      settledEvidence,
      job,
      attempt,
    );

    if (success) {
      this.recordEvidence(operation, 'EXECUTION', 'DURABLE_EXECUTION_OBLIGATION_CREATED', {
        jobId,
        attemptId,
        executionId: operation.operationId,
        paymentIntentId: dpi.paymentIntentId,
      });
      return;
    }

    // CAS failed — already settled by another worker. Record evidence and return.
    this.recordEvidence(operation, 'EXECUTION', 'SETTLEMENT_ALREADY_PERSISTED', {
      note: 'CAS failed — settlement already persisted by another worker',
      paymentIntentId: dpi.paymentIntentId,
    });
  }

    private buildResult(operation: Operation): ExecutionResult {
    return {
      operationId: operation.operationId,
      status: this.mapToFinalStatus(operation.currentState),
      paymentStatus: operation.paymentState,
      executionStatus: operation.executionState,
      data: operation.resultData,
      settlementProof: operation.settlementProof,
      executionEvidence: operation.executionEvidence,
      evidence: [...operation.evidence],
      error: operation.error,
    };
  }

  private mapToFinalStatus(state: OperationStatus): import('./types.js').ExecutionResultStatus {
    switch (state) {
      case 'SUCCESS':
      case 'DELIVERED':
      case 'EXECUTION_CONFIRMED':
        return 'SUCCESS';
      case 'RECOVERED':
        return 'RECOVERED';
      case 'UNRESOLVABLE':
        return 'UNRESOLVABLE';
      case 'FAILED':
      case 'POLICY_REJECTED':
      case 'SETTLEMENT_FAILED':
        return 'FAILED';
      default:
        // R7-A7 (external audit 2026-10-26): every remaining state is
        // NON-TERMINAL (CREATED, DISCOVERING, PAYMENT_REQUIRED,
        // AWAITING_SIGNATURE, AUTHORIZED, PAYMENT_SUBMITTED,
        // SETTLEMENT_PENDING, SETTLEMENT_UNKNOWN, SETTLED,
        // EXECUTION_PENDING, EXECUTION_UNKNOWN, RECOVERY_PENDING).
        // The old default collapsed ALL of them into 'FAILED' — reporting
        // an operation whose payment may still settle as definitively
        // failed. 'PENDING' is the honest answer.
        return 'PENDING';
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Canonical Stage-A preparation boundary.
   *
   * This is the only place that performs request idempotency, operation
   * creation/reconstruction, durable operation persistence, discovery, policy
   * validation, and (for the non-custodial/V2 path) pending DPI creation.
   *
   * It deliberately stops at PENDING_SIGNATURE. No signer, signature,
   * facilitator submission, settlement observation, or seller execution is
   * reachable from this primitive.
   */
  private async prepareStageA(
    request: ExecuteRequest,
    options: StageAOptions = { persistPendingIntent: true },
  ): Promise<StageAPreparation> {
    const requestId = resolveLogicalRequestId(request);
    // F-07 fix (external audit 2026-10-25): the `cid:${clientId}` derivation
    // (B8-001, anti double-settlement) collapses every requestId-less request
    // of a client into ONE logical operation. That is correct for RETRIES of
    // the same request and DANGEROUS for genuinely new requests: the second
    // different request would silently return (and eventually re-execute)
    // the first operation. Guard: a derived id may only resolve to an
    // operation whose paid contract (target/method) matches the incoming
    // request; otherwise the client must supply an explicit requestId.
    const derivedWithoutRequestId = !request.requestId && Boolean(request.clientId);
    const existing = await this.findExistingOperation(request.clientId, requestId);
    if (existing) {
      this.assertNoLogicalRequestCollision(derivedWithoutRequestId, request, existing, requestId);
      if (existing.currentState === 'AWAITING_SIGNATURE') {
        const dpi = await this.getDurableIntent(existing.operationId);
        const requirement = await this.getPaymentRequirementFromEvidence(existing)
          ?? (dpi ? this.requirementFromIntent(dpi) : null);
        if (dpi && requirement) {
          return {
            status: 'AWAITING_SIGNATURE',
            operation: existing,
            paymentRequired: requirement,
            paymentIntent: dpi,
          };
        }
      }
      return {
        status: 'EXISTING',
        operation: existing,
        result: this.buildResult(existing),
      };
    }

    const operation = this.createOperation(generateOperationId(), requestId, request);
    // Repair C3: fresh operation starts with an empty durable-evidence cursor.
    this.persistedEvidenceCount.set(operation.operationId, 0);

    try {
      // The DB unique constraint remains the final arbiter for concurrent
      // logical requests. Resolve a winner instead of creating a second flow.
      try {
        await this.persistOperation(operation);
      } catch (error: unknown) {
        const pgError = error as { code?: string };
        if (pgError.code === '23505' && request.clientId) {
          const resolved = await this.findExistingOperation(request.clientId, requestId);
          if (resolved) {
            this.assertNoLogicalRequestCollision(derivedWithoutRequestId, request, resolved, requestId);
            return {
              status: 'EXISTING',
              operation: resolved,
              result: this.buildResult(resolved),
            };
          }
        }
        throw error;
      }

      await this.discoveryPhase(operation);
      if (operation.currentState !== 'PAYMENT_REQUIRED') {
        await this.persistOperation(operation);
        return {
          status: 'COMPLETED',
          operation,
          result: this.buildResult(operation),
        };
      }

      const policyValid = await this.validatePolicy(operation);
      if (!policyValid) {
        const result = await this.failOperation(operation, 'POLICY_REJECTED', 'Payment policy validation failed');
        return { status: 'REJECTED', operation, result };
      }

      const paymentRequired = await this.getPaymentRequirementFromEvidence(operation);
      if (!paymentRequired) throw new Error('No payment requirement found after discovery');

      if (options.persistPendingIntent === false) {
        // Compatibility continuation for the pre-existing legacy signer path.
        // execute() will authorize this operation immediately, while all
        // Stage-A discovery and policy work still has this single owner.
        return { status: 'PAYMENT_REQUIRED', operation, paymentRequired };
      }

      const paymentIntent = await this.createPendingPaymentIntent(operation, request, paymentRequired);
      return {
        status: 'AWAITING_SIGNATURE',
        operation,
        paymentRequired,
        paymentIntent,
      };
    } catch (error) {
      const result = await this.failOperation(
        operation,
        'FAILED',
        error instanceof Error ? error.message : String(error),
      );
      return { status: 'REJECTED', operation, result };
    }
  }

  /**
   * F-07 fix: a clientId-derived logical id (`cid:${clientId}`) must only
   * resolve to an operation with the SAME paid contract. A different
   * target/method under the same derived id is a client bug — reject with a
   * dedicated, actionable error instead of silently reusing the old
   * operation (which would execute the WRONG request after payment).
   *
   * R7-B5a (external audit 2026-10-26, High): target+method equality was
   * also the ONLY check — the same client, same URL, same method but a
   * DIFFERENT body/price silently received the FIRST operation's result
   * (and eventually its data). The guard now also compares a stable
   * fingerprint of the request payload, and applies to explicit-requestId
   * reuse as well (a requestId is the identity of ONE logical request —
   * replaying it with a different body is the same collision class).
   */
  private assertNoLogicalRequestCollision(
    derivedWithoutRequestId: boolean,
    request: ExecuteRequest,
    existing: Operation,
    requestId: string,
  ): void {
    const normalize = (u: string) => String(u ?? '').replace(/\/+$/, '');
    const sameTarget = normalize(existing.target) === normalize(request.target);
    const sameMethod = String(existing.method ?? '').toUpperCase() === String(request.method ?? '').toUpperCase();
    if (!derivedWithoutRequestId && !sameTarget && !sameMethod) {
      // Explicit requestId resolving to a DIFFERENT paid contract: the 0006
      // unique index makes this impossible in durable stores (it would have
      // created a new operation instead), so this is only reachable against
      // stores without the index. Keep the legacy lenient behavior there.
      return;
    }
    if (sameTarget && sameMethod) {
      const samePayload = stableFingerprint(request.payload) === stableFingerprint(existing.requestPayload);
      if (samePayload) return;
      throw new Error(
        `REQUEST_COLLISION: ${derivedWithoutRequestId ? `client ${request.clientId} already owns logical request "${requestId}"` : `requestId "${requestId}" is already bound`}` +
        ` for ${existing.method} ${existing.target} with a DIFFERENT payload. ` +
        `Replays must reuse the exact same body; send a new requestId for a new logical request.`,
      );
    }
    if (!derivedWithoutRequestId) return;
    throw new Error(
      `REQUEST_COLLISION: client ${request.clientId} already owns logical request "${requestId}" ` +
      `for ${existing.method} ${existing.target}. The new request (${request.method} ${request.target}) ` +
      `differs — send an explicit requestId for each new logical request.`,
    );
  }

  private async findExistingOperation(
    clientId: string | undefined,
    requestId: string,
  ): Promise<Operation | null> {
    const store = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    if (clientId && typeof store.getOperationByClientAndRequestId === 'function') {
      const operation = await store.getOperationByClientAndRequestId(clientId, requestId);
      if (operation) return await this.seedEvidenceCursor(operation);
    }
    if (typeof store.getOperationByRequestId === 'function') {
      const operation = await store.getOperationByRequestId(requestId);
      return operation ? await this.seedEvidenceCursor(operation) : null;
    }
    return null;
  }

  /**
   * Repair C3: after restart/reload, seed the durable-outbox cursor from the
   * evidence that is ACTUALLY persisted in the store (not the in-memory
   * operation copy). Records already durable are never re-appended blindly;
   * only the suffix beyond the durable prefix is flushed. If the durable read
   * itself fails, fall back to cursor=full-length ONLY for stores whose
   * append is idempotent... safer default: cursor=0 so nothing is lost; the
   * idempotent store-side identity prevents duplicates either way.
   */
  private async seedEvidenceCursor(operation: Operation): Promise<Operation> {
    if (this.persistedEvidenceCount.has(operation.operationId)) {
      return operation; // already tracked in this process
    }
    let durableCount = 0;
    try {
      const durable = await this.config.evidenceStore.getEvidence(operation.operationId);
      durableCount = durable?.length ?? 0;
    } catch {
      durableCount = 0; // treat as nothing confirmed persisted; idempotent appends make replay safe
    }
    this.persistedEvidenceCount.set(operation.operationId, durableCount);
    return operation;
  }

  private async getDurableIntent(operationId: string): Promise<DurablePaymentIntent | null> {
    const store = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    if (typeof store.getPaymentIntentByOperationId !== 'function') return null;
    return store.getPaymentIntentByOperationId(operationId);
  }

  private async createPendingPaymentIntent(
    operation: Operation,
    request: ExecuteRequest,
    requirement: PaymentRequirement,
  ): Promise<DurablePaymentIntent> {
    const authorizer = requireNonEmpty(request.authorizer, 'authorizer');
    const validAfter = Math.floor(now() / 1000);
    const validBefore = toEpochSeconds(requirement.deadline, now());
    if (validBefore <= validAfter) {
      throw new Error('Invalid payment authorization: validBefore must be after validAfter');
    }

    // Generate exactly once in Stage A and persist it with the DPI.
    const nonce = new CryptoNonceGenerator().generate();
    const pendingPayload = JSON.stringify({
      status: 'PENDING_SIGNATURE',
      operationId: operation.operationId,
      authorizer,
      payTo: requirement.payee,
      value: requirement.amount,
      asset: requirement.asset,
      network: requirement.network,
      nonce,
      validAfter,
      validBefore,
    });
    const intent: DurablePaymentIntent = {
      paymentIntentId: generatePaymentIntentId(),
      operationId: operation.operationId,
      requestId: operation.requestId,
      clientId: operation.clientId,
      authorizer,
      payTo: requirement.payee,
      value: requirement.amount,
      asset: requirement.asset,
      network: requirement.network,
      nonce,
      validAfter,
      validBefore,
      paymentPayload: pendingPayload,
      paymentPayloadHash: keccak256(toBytes(pendingPayload)),
      settlementState: 'PENDING_SIGNATURE',
      createdAt: now(),
      updatedAt: now(),
    };

    const store = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;
    if (typeof store.createPaymentIntent !== 'function') {
      throw new Error('Non-custodial flow requires durable payment intent persistence');
    }
    if (typeof store.createIntentWithNonce === 'function') {
      await store.createIntentWithNonce(intent, authorizer);
    } else {
      await store.createPaymentIntent(intent);
    }

    this.transitionState(operation, 'AWAITING_SIGNATURE');
    operation.timestamps.paymentRequiredAt = operation.timestamps.paymentRequiredAt ?? now();
    await this.persistOperation(operation);
    return intent;
  }

  private buildAwaitingSignatureResult(
    operation: Operation,
    intent: DurablePaymentIntent,
    requirement: PaymentRequirement,
  ): CreateRequestResult {
    return {
      status: 'AWAITING_PAYMENT_SIGNATURE',
      requestId: operation.requestId,
      operationId: operation.operationId,
      paymentRequired: requirement,
      paymentIntent: {
        paymentIntentId: intent.paymentIntentId,
        authorizer: intent.authorizer,
        payTo: intent.payTo,
        value: intent.value,
        asset: intent.asset,
        network: intent.network,
        nonce: intent.nonce,
        validAfter: intent.validAfter,
        validBefore: intent.validBefore,
        settlementState: intent.settlementState,
      },
    };
  }

  private requirementFromIntent(intent: DurablePaymentIntent): PaymentRequirement {
    return {
      amount: intent.value,
      asset: intent.asset,
      network: intent.network,
      payee: intent.payTo,
      deadline: intent.validBefore * 1000,
    };
  }

  private validateExternalPaymentPayload(
    payload: PaymentPayload,
    intent: DurablePaymentIntent,
    requirement: PaymentRequirement,
  ): void {
    const authorization = payload?.payload?.authorization;
    if (payload?.x402Version !== 2 || !authorization || !payload.payload.signature) {
      throw new Error('INVALID_PAYMENT_PAYLOAD');
    }
    const equal = (left: string | number, right: string | number) => String(left).toLowerCase() === String(right).toLowerCase();
    if (
      !equal(payload.accepted.network, intent.network) ||
      !equal(payload.accepted.asset, intent.asset) ||
      !equal(payload.accepted.amount, intent.value) ||
      !equal(payload.accepted.payTo, intent.payTo) ||
      !equal(authorization.from, intent.authorizer) ||
      !equal(authorization.to, intent.payTo) ||
      !equal(authorization.value, intent.value) ||
      !equal(authorization.nonce, intent.nonce) ||
      Number(authorization.validAfter) !== intent.validAfter ||
      Number(authorization.validBefore) !== intent.validBefore ||
      !equal(requirement.network, intent.network) ||
      !equal(requirement.asset, intent.asset) ||
      !equal(requirement.amount, intent.value) ||
      !equal(requirement.payee, intent.payTo)
    ) {
      throw new Error('PAYMENT_PAYLOAD_BINDING_MISMATCH');
    }
  }

  private getAdapterForNetwork(network: string): PaymentAdapter {
    const adapter = this.config.adapters.get(network);
    if (!adapter) {
      throw new Error(`No payment adapter found for network: ${network}`);
    }
    return adapter;
  }

  private acceptToRequirement(accept: X402Accept): PaymentRequirement {
    return {
      amount: accept.amount,
      asset: accept.asset,
      network: accept.network,
      payee: accept.payTo,
      deadline: accept.maxTimeoutSeconds ? Date.now() + accept.maxTimeoutSeconds * 1000 : undefined,
      // R9-A1: carry the seller-advertised window — the standard transport
      // restores it into the PAYMENT-SIGNATURE payload (the seller's
      // middleware verifies against its own route config, not our arithmetic).
      ...(accept.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: accept.maxTimeoutSeconds }
        : {}),
    };
  }


  private async getPaymentRequirementFromEvidence(operation: Operation): Promise<PaymentRequirement | null> {
    const evidence = operation.evidence.find(
      e => e.phase === 'DISCOVERY' && e.event === 'PAYMENT_REQUIREMENT_RECEIVED'
    );
    if (!evidence || typeof evidence.payload !== 'object' || evidence.payload === null) {
      return null;
    }
    return (evidence.payload as Record<string, unknown>).requirement as PaymentRequirement;
  }

  private async getAuthorizationFromEvidence(operation: Operation): Promise<any> {
    const evidence = operation.evidence.find(
      e => e.phase === 'PAYMENT' && e.event === 'PAYMENT_AUTHORIZED'
    );
    if (!evidence || typeof evidence.payload !== 'object' || evidence.payload === null) {
      return null;
    }
    const intent = (evidence.payload as Record<string, unknown>).intent as PaymentIntent;
    return intent?.authorization;
  }

  /**
   * F-05 fix: reconstruct the authorization from the DURABLE signed payload
   * persisted on the payment intent (updatePaymentIntentAuthorization). Used
   * when the PAYMENT_AUTHORIZED evidence record was lost to a crash window.
   */
  private authorizationFromDurableIntent(dpi: DurablePaymentIntent): {
    signature: string; scheme: string;
  } | null {
    if (!dpi.paymentPayload) return null;
    try {
      const parsed = JSON.parse(dpi.paymentPayload) as {
        payload?: { signature?: string };
        accepted?: { scheme?: string };
      };
      const signature = parsed?.payload?.signature;
      if (!signature) return null;
      return { signature, scheme: parsed?.accepted?.scheme || 'exact' };
    } catch {
      return null;
    }
  }

  private async getSubmissionResultFromEvidence(operation: Operation): Promise<any> {
    const evidence = operation.evidence.find(
      e => e.phase === 'PAYMENT' && e.event === 'PAYMENT_SUBMITTED'
    );
    if (!evidence || typeof evidence.payload !== 'object' || evidence.payload === null) {
      return null;
    }
    return {
      success: true,
      transactionHash: (evidence.payload as Record<string, unknown>).transactionHash,
      rawData: (evidence.payload as Record<string, unknown>).rawData,
    };
  }

  // ==========================================================================
  // GETTERS FOR EXTERNAL ACCESS
  // ==========================================================================

  async getOperation(operationId: string): Promise<Operation | null> {
    return await this.config.evidenceStore.getOperation(operationId);
  }

  async getOperationByRequestId(requestId: string, clientId?: string): Promise<Operation | null> {
    if (typeof this.config.evidenceStore.getOperationByRequestId !== 'function') {
      return null;
    }
    // R7-B5b: pass the optional client scope through to the store.
    return await this.config.evidenceStore.getOperationByRequestId(requestId, clientId);
  }

  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return await this.config.evidenceStore.getEvidence(operationId);
  }
}
