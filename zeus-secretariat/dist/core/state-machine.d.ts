/**
 * Zeus Secretariat V0 - State Machine Implementation
 *
 * Core invariant: After payment is submitted, we CANNOT blindly retry.
 * We must first determine settlement status before any recovery action.
 */
import { Operation, EvidenceRecord, ExecuteRequest, ExecutionResult, EvidenceStore, DurableEvidenceStore, DurablePaymentIntent, PaymentSigner, PaymentAdapter, PaymentRequirement } from './types';
import type { SettlementAdapter, PaymentPayload } from '../adapters/x402-facilitator-client';
import type { ReconciliationEngine } from './reconciliation-engine';
import type { AtomicSettlementHandoff } from './post-settlement-engine';
import { CapabilitySource } from './capability-resolver';
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
    constructor(config: SecretariatConfig);
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
    private findExistingOperation;
    private getDurableIntent;
    private createPendingPaymentIntent;
    private buildAwaitingSignatureResult;
    private requirementFromIntent;
    private validateExternalPaymentPayload;
    private getAdapterForNetwork;
    private acceptToRequirement;
    private getPaymentRequirementFromEvidence;
    private getAuthorizationFromEvidence;
    private getSubmissionResultFromEvidence;
    getOperation(operationId: string): Promise<Operation | null>;
    getOperationByRequestId(requestId: string): Promise<Operation | null>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
}
//# sourceMappingURL=state-machine.d.ts.map