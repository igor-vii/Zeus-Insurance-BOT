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
  AtomicSettlementHandoff,
  RecoveryJob,
  ExecutionAttempt,
} from './types';

import type { SettlementAdapter, PaymentPayload, SubmitResult } from '../adapters/x402-facilitator-client';
import type { ReconciliationEngine, ReconciliationOutcome } from './reconciliation-engine';

// Legacy types used internally by StateMachine (Phase 2.1 payment flow)
// These are NOT the canonical V0 DurablePaymentIntent — they exist only for
// the StateMachine's internal observeExecution_DEPRECATED path.
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
import { X402Parser, X402Accept } from './x402-parser';
import { SellerCapabilityResolver, CapabilitySource } from './capability-resolver';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

function generatePaymentIntentId(): string {
  return `pi_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

function now(): number {
  return Date.now();
}

// ============================================================================
// STATE MACHINE TRANSITIONS
// ============================================================================

const VALID_TRANSITIONS: Record<OperationStatus, OperationStatus[]> = {
  CREATED: ['DISCOVERING', 'FAILED'],
  DISCOVERING: ['PAYMENT_REQUIRED', 'SUCCESS', 'FAILED'],
  PAYMENT_REQUIRED: ['AUTHORIZED', 'POLICY_REJECTED', 'FAILED'],
  AUTHORIZED: ['PAYMENT_SUBMITTED', 'FAILED'],
  PAYMENT_SUBMITTED: ['SETTLEMENT_PENDING', 'SETTLEMENT_UNKNOWN', 'SETTLED', 'SETTLEMENT_FAILED'],
  SETTLEMENT_PENDING: ['SETTLED', 'SETTLEMENT_UNKNOWN', 'SETTLEMENT_FAILED'],
  SETTLEMENT_UNKNOWN: ['SETTLED', 'SETTLEMENT_FAILED'],
  SETTLED: ['EXECUTION_PENDING', 'EXECUTION_UNKNOWN'],
  EXECUTION_PENDING: ['EXECUTION_CONFIRMED', 'EXECUTION_UNKNOWN', 'FAILED'],
  EXECUTION_CONFIRMED: ['DELIVERED', 'FAILED'],
  DELIVERED: ['SUCCESS'],
  SUCCESS: [], // Terminal state
  FAILED: [], // Terminal state
  POLICY_REJECTED: [], // Terminal state
  SETTLEMENT_FAILED: ['FAILED'],
  EXECUTION_UNKNOWN: ['RECOVERY_PENDING', 'FAILED'],
  RECOVERY_PENDING: ['RECOVERED', 'SUCCESS', 'UNRESOLVABLE', 'FAILED'],
  RECOVERED: [], // Terminal state
  UNRESOLVABLE: [], // Terminal state
};

function isValidTransition(from: OperationStatus, to: OperationStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

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
 * StateMachine.observeExecution_DEPRECATED_USE_POST_SETTLEMENT_ENGINE() is DEPRECATED — it must NOT be used as an
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
  signer: PaymentSigner;
  adapters: Map<string, PaymentAdapter>;
  capabilitySources?: CapabilitySource[];
  /** Canonical V2 settlement adapter. Required for production payment submission. */
  settlementAdapter?: SettlementAdapter;
  /** Canonical reconciliation engine. Required for settlement verification. */
  reconciliationEngine?: ReconciliationEngine;
  /**
   * R2.1-FIX-5: REQUIRED atomic settlement → execution handoff.
   * Production MUST provide PostgresExecutionStore implementing this contract.
   * If unavailable, settlement → execution handoff will fail closed.
   */
  atomicSettlementHandoff: AtomicSettlementHandoff;
}

export class Secretariat {
  private readonly config: SecretariatConfig;
  private readonly capabilityResolver: SellerCapabilityResolver;

  constructor(config: SecretariatConfig) {
    this.config = config;
    this.capabilityResolver = new SellerCapabilityResolver(config.capabilitySources ?? []);
  }

  // ==========================================================================
  // MAIN ENTRY POINT: Execute an operation
  // ==========================================================================

  async execute(request: ExecuteRequest): Promise<ExecutionResult> {
    const requestId = request.requestId ?? generateRequestId();

    // B8-001: Durable idempotency — lookup existing operation before creating new one.
    // The DB unique constraint on (client_id, request_id) is the final arbiter for races.
    if (request.clientId) {
      const store = this.config.evidenceStore as EvidenceStore & Partial<{
        getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null>;
      }>;
      if (typeof store.getOperationByClientAndRequestId === "function") {
        const existing = await store.getOperationByClientAndRequestId(request.clientId, requestId);
        if (existing) {
          // Return existing operation result — do not create duplicate
          return this.buildResult(existing);
        }
      }
    }

    const operationId = generateOperationId();

    // Create initial operation
    const operation: Operation = this.createOperation(operationId, requestId, request);

    // Persist initial state.
    // If a concurrent request created the same (clientId, requestId) between our lookup
    // and this insert, the DB unique constraint will reject this insert.
    // We catch that and resolve to the already-created operation.
    try {
      await this.persistOperation(operation);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505" && request.clientId) {
        // Unique constraint violation — another worker won the race.
        // Resolve to the existing canonical operation.
        const store = this.config.evidenceStore as EvidenceStore & Partial<{
          getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null>;
        }>;
        if (typeof store.getOperationByClientAndRequestId === "function") {
          const resolved = await store.getOperationByClientAndRequestId(request.clientId, requestId);
          if (resolved) {
            return this.buildResult(resolved);
          }
        }
      }
      // Re-throw if not a uniqueness race or resolution failed
      throw err;
    }

    try {
      // Step 1: Discovery
      await this.discoveryPhase(operation);

      // Step 2: Check if payment required
      if (operation.currentState === 'PAYMENT_REQUIRED') {
        // Step 3: Policy validation
        const policyValid = await this.validatePolicy(operation);
        if (!policyValid) {
          return await this.failOperation(operation, 'POLICY_REJECTED', 'Payment policy validation failed');
        }

        // Step 4: Payment authorization
        await this.authorizePayment(operation);

        // Step 5: Payment submission
        await this.submitPayment(operation);

        // Step 6: Settlement observation
        await this.observeSettlement(operation);
      }

      // Step 7: Durable settlement + execution obligation handoff
      // INV-9: Every SETTLED transition must leave a durable recoverable execution obligation.
      // StateMachine does NOT execute seller work — it only persists the handoff.
      // PostSettlementEngine owns execution lifecycle exclusively.
      if (operation.currentState === 'SETTLED' || operation.currentState === 'EXECUTION_PENDING') {
        await this.persistSettlementAndExecutionObligation(operation);
      }

      // Step 8: Delivery
      if (operation.currentState === 'EXECUTION_CONFIRMED') {
        await this.deliver(operation);
      }

      // Return final result
      return this.buildResult(operation);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return await this.failOperation(operation, 'FAILED', errorMessage);
    }
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
      // Make initial request to discover if payment is required
      const response = await fetch(operation.target, {
        method: operation.method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
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

    // Check max price
    if (parseFloat(requirement.amount) > parseFloat(policy.maxPrice)) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Amount exceeds maxPrice',
        required: requirement.amount,
        maxAllowed: policy.maxPrice,
      });
      return false;
    }

    // Check allowed networks
    if (!policy.allowedNetworks.includes(requirement.network)) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Network not allowed',
        required: requirement.network,
        allowed: policy.allowedNetworks,
      });
      return false;
    }

    // Check allowed assets
    if (!policy.allowedAssets.includes(requirement.asset)) {
      this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
        reason: 'Asset not allowed',
        required: requirement.asset,
        allowed: policy.allowedAssets,
      });
      return false;
    }

    // Check allowed sellers (if specified)
    if (policy.allowedSellers && !policy.allowedSellers.includes(requirement.payee)) {
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

    const requirement = await this.getPaymentRequirementFromEvidence(operation);
    if (!requirement) {
      throw new Error('No payment requirement found for authorization');
    }

    // Get adapter for the network
    const adapter = this.getAdapterForNetwork(requirement.network);
    
    // Create signing context
    const context: SigningContext = {
      operationId: operation.operationId,
      requirement,
    };

    // Sign payment using external signer
    const authorization = await adapter.createAuthorization(requirement, this.config.signer, context);

    // B8.2-B.1: Create canonical DurablePaymentIntent and persist BEFORE any settlement.
    // Local PaymentIntent is retained as transient orchestration data only — NOT authoritative.
    const durableStore = this.config.evidenceStore as EvidenceStore & Partial<DurableEvidenceStore>;

    if (typeof durableStore.createPaymentIntent === "function") {
      // Check for existing DPI (idempotency — do not create duplicate economic operation)
      const existingIntent = typeof durableStore.getPaymentIntentByOperationId === "function"
        ? await durableStore.getPaymentIntentByOperationId(operation.operationId)
        : null;

      if (!existingIntent) {
        const ts = now();
        const durableIntent: DurablePaymentIntent = {
          paymentIntentId: generatePaymentIntentId(),
          operationId: operation.operationId,
          requestId: operation.requestId,
          clientId: operation.clientId,
          authorizer: "",  // Not available from legacy PaymentAuthorization; populated by V2 signer path
          payTo: requirement.payee,
          value: requirement.amount,
          asset: requirement.asset,
          network: requirement.network,
          nonce: context.nonce ?? "",
          validAfter: 0,
          validBefore: requirement.deadline ?? 0,
          paymentPayload: authorization.signature,
          // TODO(B8.2-C/signer-block): paymentPayloadHash deferred. No existing hash utility found.
      // Requires keccak256(viem) over canonical serialized PaymentPayload bytes.
      paymentPayloadHash: "",
          settlementState: "AUTHORIZED",
          createdAt: ts,
          updatedAt: ts,
        };

        await durableStore.createPaymentIntent(durableIntent);
      }
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

    // 2. Retrieve authorization from evidence (created in authorizePayment)
    const authorization = await this.getAuthorizationFromEvidence(operation);
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

    // 4. Submit via canonical SettlementAdapter
    const settlementAdapter = this.config.settlementAdapter;
    if (!settlementAdapter) {
      throw new Error('No settlementAdapter configured — required for V2 payment submission');
    }

    const result = await settlementAdapter.submit(dpi, v2Payload);

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

  // ==========================================================================
  // PHASE 6: EXECUTION OBSERVATION
  // This is a SEPARATE axis from payment state
  // Payment can be SETTLED while execution is UNKNOWN
  // ==========================================================================

  private async observeExecution_DEPRECATED_USE_POST_SETTLEMENT_ENGINE(operation: Operation): Promise<void> {
    this.transitionState(operation, 'EXECUTION_PENDING');

    try {
      // Attempt to get execution result
      const response = await fetch(operation.target, {
        method: operation.method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
      });

      if (response.ok) {
        const body = await response.json().catch(() => null);
        
        operation.resultData = body;
        operation.executionState = 'CONFIRMED';
        operation.executionEvidence = {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          timestamp: now(),
          source: 'HTTP_RESPONSE',
        };

        this.transitionState(operation, 'EXECUTION_CONFIRMED');
        operation.timestamps.executionConfirmedAt = now();

        this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_CONFIRMED', {
          statusCode: response.status,
        });
      } else {
        // Execution failed or unknown
        this.transitionState(operation, 'EXECUTION_UNKNOWN');
        operation.executionState = 'UNKNOWN';

        this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_UNKNOWN', {
          statusCode: response.status,
          statusText: response.statusText,
        });

        // Trigger recovery based on seller capabilities
        await this.handleRecovery(operation);
      }
    } catch (error) {
      // Network error - execution unknown
      this.transitionState(operation, 'EXECUTION_UNKNOWN');
      operation.executionState = 'UNKNOWN';

      this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_NETWORK_ERROR', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Trigger recovery based on seller capabilities
      await this.handleRecovery(operation);
    }
  }

  // ==========================================================================
  // PHASE 7: RECOVERY
  // Based on seller capabilities - NO blind retry
  // CRITICAL GUARD: Block retry if payment is settled but delivery is unknown
  // and seller capability is NONE
  // ==========================================================================

  private async handleRecovery(operation: Operation): Promise<void> {
    // CRITICAL: Only block if payment is actually settled but delivery is unknown
    if (
      operation.paymentState === 'SETTLED' &&
      operation.deliveryState === 'UNKNOWN' &&
      operation.sellerCapability?.recoveryCapability === 'NONE'
    ) {
      this.recordEvidence(operation, 'RECOVERY', 'GUARD_BLOCKED_RETRY', {
        reason: 'Seller capability is NONE. Blind retry forbidden after settlement.',
        paymentState: operation.paymentState,
        deliveryState: operation.deliveryState,
      });
      this.transitionState(operation, 'UNRESOLVABLE');
      operation.error = 'Settlement confirmed but execution unknown with no recovery path';
      return; // STOP execution flow
    }

    if (!operation.sellerCapability) {
      this.recordEvidence(operation, 'RECOVERY', 'NO_CAPABILITIES_KNOWN', {});
      this.transitionState(operation, 'UNRESOLVABLE');
      operation.error = 'No seller capabilities known - cannot recover';
      return;
    }

    const capability = operation.sellerCapability.recoveryCapability;
    this.recordEvidence(operation, 'RECOVERY', 'RECOVERY_ATTEMPT_STARTED', {
      capability,
    });

    this.transitionState(operation, 'RECOVERY_PENDING');

    switch (capability) {
      case 'RESULT_RETRIEVAL':
        await this.recoverViaResultRetrieval(operation);
        break;

      case 'EXECUTION_IDEMPOTENT':
        await this.recoverViaIdempotentRetry(operation);
        break;

      case 'SIGNED_RECEIPT':
        await this.recoverViaSignedReceipt(operation);
        break;

      case 'NONE':
      default:
        this.recordEvidence(operation, 'RECOVERY', 'NO_RECOVERY_PATH', {
          capability,
        });
        this.transitionState(operation, 'UNRESOLVABLE');
        operation.error = 'No recovery path available';
        break;
    }
  }

  private async recoverViaResultRetrieval(operation: Operation): Promise<void> {
    const endpoint = operation.sellerCapability?.resultRetrievalEndpoint;
    if (!endpoint) {
      this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVAL_NO_ENDPOINT', {});
      this.transitionState(operation, 'UNRESOLVABLE');
      operation.error = 'No result retrieval endpoint available';
      return;
    }

    try {
      const url = `${endpoint}/${operation.operationId}`;
      const response = await fetch(url, { method: 'GET' });

      if (response.ok) {
        const body = await response.json().catch(() => null);
        
        operation.resultData = body;
        operation.executionState = 'CONFIRMED';
        operation.executionEvidence = {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          timestamp: now(),
          source: 'RESULT_RETRIEVAL',
        };

        this.transitionState(operation, 'RECOVERED');
        operation.timestamps.completedAt = now();

        this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVED', {
          endpoint: url,
        });
      } else {
        this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVAL_FAILED', {
          statusCode: response.status,
        });
        this.transitionState(operation, 'UNRESOLVABLE');
        operation.error = 'Result retrieval failed';
      }
    } catch (error) {
      this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVAL_ERROR', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.transitionState(operation, 'UNRESOLVABLE');
      operation.error = 'Result retrieval error';
    }
  }

  private async recoverViaIdempotentRetry(operation: Operation): Promise<void> {
    const headerName = operation.sellerCapability?.idempotencyHeader ?? 'Idempotency-Key';
    
    try {
      const response = await fetch(operation.target, {
        method: operation.method,
        headers: {
          'Content-Type': 'application/json',
          [headerName]: operation.operationId,
        },
        body: operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
      });

      if (response.ok) {
        const body = await response.json().catch(() => null);
        
        operation.resultData = body;
        operation.executionState = 'CONFIRMED';
        operation.executionEvidence = {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          timestamp: now(),
          source: 'HTTP_RESPONSE',
        };

        this.transitionState(operation, 'SUCCESS');
        operation.timestamps.completedAt = now();

        this.recordEvidence(operation, 'RECOVERY', 'IDEMPOTENT_RETRY_SUCCESS', {
          idempotencyKey: operation.operationId,
        });
      } else {
        this.recordEvidence(operation, 'RECOVERY', 'IDEMPOTENT_RETRY_FAILED', {
          statusCode: response.status,
        });
        this.transitionState(operation, 'UNRESOLVABLE');
        operation.error = 'Idempotent retry failed';
      }
    } catch (error) {
      this.recordEvidence(operation, 'RECOVERY', 'IDEMPOTENT_RETRY_ERROR', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.transitionState(operation, 'UNRESOLVABLE');
      operation.error = 'Idempotent retry error';
    }
  }

  private async recoverViaSignedReceipt(operation: Operation): Promise<void> {
    // TODO: Implement signed receipt verification
    this.recordEvidence(operation, 'RECOVERY', 'SIGNED_RECEIPT_NOT_IMPLEMENTED', {});
    this.transitionState(operation, 'UNRESOLVABLE');
    operation.error = 'Signed receipt verification not implemented in V0';
  }

  // ==========================================================================
  // PHASE 8: DELIVERY
  // ==========================================================================

  private async deliver(operation: Operation): Promise<void> {
    operation.deliveryState = 'DELIVERED';
    operation.timestamps.deliveredAt = now();

    this.recordEvidence(operation, 'DELIVERY', 'DELIVERY_COMPLETED', {});

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
    operation.error = error;
    operation.timestamps.failedAt = now();
    operation.timestamps.updatedAt = now();

    this.recordEvidence(operation, 'FINAL', 'OPERATION_FAILED', {
      status,
      error,
    });

    await this.persistOperation(operation);
    return this.buildResult(operation);
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
    };

    operation.evidence.push(record);
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  private async persistOperation(operation: Operation): Promise<void> {
    await this.config.evidenceStore.saveOperation(operation);
    
    // Also append latest evidence
    if (operation.evidence.length > 0) {
      const latestEvidence = operation.evidence[operation.evidence.length - 1];
      await this.config.evidenceStore.append(latestEvidence);
    }
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
  private async persistSettlementAndExecutionObligation(operation: Operation): Promise<void> {
    const now = Date.now();
    const jobId = `rj-${now}-${Math.random().toString(36).slice(2)}`;
    const attemptId = `att-${now}-${Math.random().toString(36).slice(2)}`;

    const job: RecoveryJob = {
      jobId,
      operationId: operation.operationId,
      jobType: "EXECUTION",
      status: "PENDING",
      priority: 0,
      maxAttempts: 3,
      currentAttempt: 0,
      metadata: { capability: "EXECUTION_IDEMPOTENT", requestBody: operation.requestPayload },
      createdAt: now,
      updatedAt: now,
    };

    const attempt: ExecutionAttempt = {
      attemptId,
      operationId: operation.operationId,
      executionId: operation.operationId, // INV-10: executionId = operationId
      attemptNumber: 1,
      status: "PENDING",
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

  private mapToFinalStatus(state: OperationStatus): 'SUCCESS' | 'FAILED' | 'RECOVERED' | 'UNRESOLVABLE' {
    switch (state) {
      case 'SUCCESS':
      case 'DELIVERED':
      case 'EXECUTION_CONFIRMED':
        return 'SUCCESS';
      case 'RECOVERED':
        return 'RECOVERED';
      case 'UNRESOLVABLE':
        return 'UNRESOLVABLE';
      default:
        return 'FAILED';
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

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

  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return await this.config.evidenceStore.getEvidence(operationId);
  }
}
