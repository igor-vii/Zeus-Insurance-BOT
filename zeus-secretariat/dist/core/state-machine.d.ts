/**
 * Zeus Secretariat V0 - State Machine Implementation
 *
 * Core invariant: After payment is submitted, we CANNOT blindly retry.
 * We must first determine settlement status before any recovery action.
 */
import { Operation, EvidenceRecord, ExecuteRequest, ExecutionResult, EvidenceStore, DurableEvidenceStore, DurablePaymentIntent, PaymentSigner, PaymentAdapter, PaymentRequirement } from './types.js';
import type { SettlementAdapter, PaymentPayload } from '../adapters/x402-facilitator-client.js';
import type { ReconciliationEngine } from './reconciliation-engine.js';
import type { AtomicSettlementHandoff } from './post-settlement-engine.js';
import { CapabilitySource } from './capability-resolver.js';
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
    signer?: PaymentSigner;
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
export type CreateRequestResult = {
    status: 'AWAITING_PAYMENT_SIGNATURE';
    requestId: string;
    operationId: string;
    paymentRequired: PaymentRequirement;
    paymentIntent: Pick<DurablePaymentIntent, 'paymentIntentId' | 'authorizer' | 'payTo' | 'value' | 'asset' | 'network' | 'nonce' | 'validAfter' | 'validBefore' | 'settlementState'>;
} | {
    status: 'COMPLETED' | 'REJECTED';
    result: ExecutionResult;
};
export declare class Secretariat {
    private readonly config;
    private readonly capabilityResolver;
    /**
     * Repair C3: durable-outbox cursor per operation.
     * Maps operationId -> count of evidence records confirmed durably persisted
     * (in sequence order). The cursor only advances on CONFIRMED appends, so a
     * failed append leaves the record pending for the next flush. A failed call
     * does NOT prove the DB made no change - the store's append() is idempotent
     * via stable logical identity (see PostgresEvidenceStore), so re-appending
     * an ambiguous record cannot create duplicates.
     */
    private readonly persistedEvidenceCount;
    constructor(config: SecretariatConfig);
    /** Total attempts per evidence flush (bounded; never infinite). */
    private evidenceFlushAttempts;
    execute(request: ExecuteRequest): Promise<ExecutionResult>;
    /**
     * Stage A of the non-custodial payment boundary.
     *
     * This path discovers and validates the request, persists the operation and
     * DPI, and stops before a signer, signature, or facilitator call is used.
     */
    createRequest(request: ExecuteRequest): Promise<CreateRequestResult>;
    /**
     * Stage B of the non-custodial payment boundary.
     *
     * The supplied payload is checked against the persisted DPI before the
     * existing facilitator/reconciliation flow is resumed.
     */
    submitSignedPayment(requestId: string, externallySignedPaymentPayload: PaymentPayload): Promise<ExecutionResult>;
    /**
     * F-05 fix: resume a submission whose durable intent reached AUTHORIZED but
     * whose facilitator submission never durably completed (crash or failure
     * between authorization persistence and submitPayment). The signed payload
     * hash was already verified against the durable intent by the caller; the
     * on-chain AuthorizationUsed nonce remains the double-settle guard.
     */
    private resumeAuthorizedSubmission;
    private createOperation;
    private discoveryPhase;
    private handlePaymentRequired;
    private handleDirectSuccess;
    private validatePolicy;
    private authorizePayment;
    private submitPayment;
    private observeSettlement;
    private observeExecution_DEPRECATED_USE_POST_SETTLEMENT_ENGINE;
    private handleRecovery;
    private recoverViaResultRetrieval;
    private recoverViaIdempotentRetry;
    private recoverViaSignedReceipt;
    private deliver;
    private failOperation;
    private transitionState;
    private recordEvidence;
    private persistOperation;
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
    private flushPendingEvidence;
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
    private persistSettlementAndExecutionObligation;
    private buildResult;
    private mapToFinalStatus;
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
    private prepareStageA;
    /**
     * F-07 fix: a clientId-derived logical id (`cid:${clientId}`) must only
     * resolve to an operation with the SAME paid contract. A different
     * target/method under the same derived id is a client bug — reject with a
     * dedicated, actionable error instead of silently reusing the old
     * operation (which would execute the WRONG request after payment).
     */
    private assertNoLogicalRequestCollision;
    private findExistingOperation;
    /**
     * Repair C3: after restart/reload, seed the durable-outbox cursor from the
     * evidence that is ACTUALLY persisted in the store (not the in-memory
     * operation copy). Records already durable are never re-appended blindly;
     * only the suffix beyond the durable prefix is flushed. If the durable read
     * itself fails, fall back to cursor=full-length ONLY for stores whose
     * append is idempotent... safer default: cursor=0 so nothing is lost; the
     * idempotent store-side identity prevents duplicates either way.
     */
    private seedEvidenceCursor;
    private getDurableIntent;
    private createPendingPaymentIntent;
    private buildAwaitingSignatureResult;
    private requirementFromIntent;
    private validateExternalPaymentPayload;
    private getAdapterForNetwork;
    private acceptToRequirement;
    private getPaymentRequirementFromEvidence;
    private getAuthorizationFromEvidence;
    /**
     * F-05 fix: reconstruct the authorization from the DURABLE signed payload
     * persisted on the payment intent (updatePaymentIntentAuthorization). Used
     * when the PAYMENT_AUTHORIZED evidence record was lost to a crash window.
     */
    private authorizationFromDurableIntent;
    private getSubmissionResultFromEvidence;
    getOperation(operationId: string): Promise<Operation | null>;
    getOperationByRequestId(requestId: string): Promise<Operation | null>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
}
//# sourceMappingURL=state-machine.d.ts.map