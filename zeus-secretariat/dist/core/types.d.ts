/**
 * Zeus Secretariat V0 - Core Domain Types
 *
 * Architectural Principle:
 * Build an independent Zeus Secretariat. Reuse proven x402 implementation patterns where useful,
 * but do not import Syra's architecture, dependencies, retry semantics, or economic assumptions.
 * The Secretariat owns the operation state machine, payment intent lifecycle, settlement observation,
 * execution observation, recovery policy, and durable evidence.
 */
export type OperationStatus = 'CREATED' | 'DISCOVERING' | 'PAYMENT_REQUIRED' | 'AWAITING_SIGNATURE' | 'AUTHORIZED' | 'PAYMENT_SUBMITTED' | 'SETTLEMENT_PENDING' | 'SETTLEMENT_UNKNOWN' | 'SETTLED' | 'EXECUTION_PENDING' | 'EXECUTION_CONFIRMED' | 'DELIVERED' | 'SUCCESS' | 'FAILED' | 'POLICY_REJECTED' | 'SETTLEMENT_FAILED' | 'EXECUTION_UNKNOWN' | 'RECOVERY_PENDING' | 'RECOVERED' | 'UNRESOLVABLE';
export type PaymentStatus = 'NOT_STARTED' | 'AUTHORIZED' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'UNKNOWN';
export type ExecutionStatus = 'NOT_STARTED' | 'PENDING' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
export interface Operation {
    /**
     * Main immutable identifier.
     * Invariant: One economic operation = one operationId.
     * Any retry/recovery refers to the SAME operation.
     */
    readonly operationId: string;
    /**
     * Original request identifier from the agent/client.
     * Serves as the canonical idempotency key when combined with clientId.
     */
    readonly requestId: string;
    /**
     * Client identity for durable idempotency.
     * Propagated from ExecuteRequest.clientId. Nullable for backward compatibility.
     */
    readonly clientId?: string;
    /**
     * Target endpoint to execute
     */
    readonly target: string;
    /**
     * HTTP method
     */
    readonly method: string;
    /**
     * Request payload (if any)
     */
    readonly requestPayload?: unknown;
    /**
     * Payment policy constraints
     */
    readonly paymentPolicy: PaymentPolicy;
    /**
     * Seller capabilities discovered during DISCOVERY phase
     */
    sellerCapability?: SellerCapabilities;
    /**
     * Current states
     */
    paymentState: PaymentStatus;
    executionState: ExecutionStatus;
    deliveryState: 'NOT_STARTED' | 'PENDING' | 'DELIVERED' | 'FAILED' | 'UNKNOWN';
    /**
     * Current overall state
     */
    currentState: OperationStatus;
    /**
     * Timestamps for each state transition
     */
    readonly timestamps: {
        createdAt: number;
        updatedAt: number;
        discoveryStartedAt?: number;
        paymentRequiredAt?: number;
        authorizedAt?: number;
        paymentSubmittedAt?: number;
        settledAt?: number;
        executionConfirmedAt?: number;
        deliveredAt?: number;
        completedAt?: number;
        failedAt?: number;
    };
    /**
     * Evidence records for this operation
     */
    readonly evidence: EvidenceRecord[];
    /**
     * Final result data (if available)
     */
    resultData?: unknown;
    /**
     * Settlement proof (if available)
     */
    settlementProof?: SettlementProof;
    /**
     * Execution evidence (if available)
     */
    executionEvidence?: ExecutionEvidence;
    /**
     * Error message (if failed)
     */
    error?: string;
}
export interface PaymentPolicy {
    /**
     * Maximum acceptable price for this operation
     */
    maxPrice: string;
    /**
     * Allowed blockchain networks
     */
    allowedNetworks: string[];
    /**
     * Allowed payment assets/tokens
     */
    allowedAssets: string[];
    /**
     * Allowed sellers (optional whitelist)
     */
    allowedSellers?: string[];
    /**
     * Authorization mode:
     * - "explicit": requires explicit user approval for each payment
     * - "policy-bound": automatic approval if within policy bounds
     */
    authorizationMode: 'explicit' | 'policy-bound';
}
export interface SellerCapabilities {
    /**
     * Recovery capability - NOT just "IDEMPOTENT"
     * Payment idempotency does not prove execution idempotency.
     */
    recoveryCapability: RecoveryCapability;
    /**
     * Result retrieval endpoint (if RESULT_RETRIEVAL is supported)
     */
    resultRetrievalEndpoint?: string;
    /**
     * Idempotency key header name (if EXECUTION_IDEMPOTENT)
     */
    idempotencyHeader?: string;
}
export type RecoveryCapability = 'NONE' | 'EXECUTION_IDEMPOTENT' | 'RESULT_RETRIEVAL' | 'SIGNED_RECEIPT';
export interface PaymentRequirement {
    /**
     * Required payment amount
     */
    amount: string;
    /**
     * Asset/token to pay with
     */
    asset: string;
    /**
     * Blockchain network
     */
    network: string;
    /**
     * Payee/seller address
     */
    payee: string;
    /**
     * Optional payment deadline
     */
    deadline?: number;
    /**
     * Additional payment scheme-specific fields
     */
    [key: string]: unknown;
}
export interface PaymentAuthorization {
    /**
     * Signature or authorization token
     */
    signature: string;
    /**
     * Authorization scheme
     */
    scheme: string;
    /**
     * Timestamp of authorization
     */
    timestamp: number;
    /**
     * Context used for signing
     */
    context: SigningContext;
    /**
     * Canonical EIP-3009 binding fields. Legacy adapters may omit these while
     * the compatibility path is in use; the production V2 path validates them
     * before accepting the authorization.
     */
    authorizer?: string;
    payTo?: string;
    value?: string;
    validAfter?: number;
    validBefore?: number;
}
export interface SigningContext {
    operationId: string;
    requirement: PaymentRequirement;
    nonce?: string;
}
export interface PaymentSigner {
    /**
     * Address controlled by the signer. Required by the canonical V2 path so
     * the durable intent can be bound before requesting a signature.
     */
    getAddress?: () => Promise<string>;
    /**
     * Sign a payment requirement
     * @param requirement - Payment requirement to sign
     * @param context - Signing context
     * @returns Payment authorization
     */
    signPayment(requirement: PaymentRequirement, context: SigningContext): Promise<PaymentAuthorization>;
}
export interface SettlementProof {
    /**
     * Transaction hash (if on-chain)
     */
    transactionHash?: string;
    /**
     * Block number/height (if applicable)
     */
    blockNumber?: number;
    /**
     * Settlement timestamp
     */
    timestamp: number;
    /**
     * Amount settled
     */
    amount: string;
    /**
     * Asset settled
     */
    asset: string;
    /**
     * Source of proof (RPC, payment facilitator, etc.)
     */
    source: string;
    /**
     * Raw proof data
     */
    rawData?: unknown;
}
export interface ExecutionEvidence {
    /**
     * HTTP status code
     */
    statusCode: number;
    /**
     * Response headers
     */
    headers?: Record<string, string>;
    /**
     * Response body
     */
    body?: unknown;
    /**
     * Execution timestamp
     */
    timestamp: number;
    /**
     * Source of evidence
     */
    source: 'HTTP_RESPONSE' | 'RESULT_RETRIEVAL' | 'SIGNED_RECEIPT';
    /**
     * Raw response data
     */
    rawData?: unknown;
}
export type EvidencePhase = 'DISCOVERY' | 'POLICY' | 'PAYMENT' | 'SETTLEMENT' | 'EXECUTION' | 'DELIVERY' | 'RECOVERY' | 'FINAL';
export interface EvidenceRecord {
    readonly operationId: string;
    readonly phase: EvidencePhase;
    readonly timestamp: number;
    readonly event: string;
    readonly payload: unknown;
    /**
     * Repair C3: Deterministic per-operation sequence (0-based). Assigned by
     * recordEvidence() at creation time and preserved through persistence +
     * reconstruction. Provides a stable chronological ordering key that does
     * not depend on wall-clock collisions, and is part of the logical identity
     * used for idempotent evidence appends.
     */
    readonly sequence?: number;
}
/**
 * Final status of an ExecutionResult.
 *
 * R7-A7 (external audit 2026-10-26): the union previously had no in-progress
 * value, so mapToFinalStatus() reported every non-terminal state
 * (SETTLEMENT_PENDING, PAYMENT_SUBMITTED, EXECUTION_PENDING, …) as 'FAILED' —
 * an outright lie for an operation whose payment may still settle. 'PENDING'
 * is the honest answer for anything not yet terminal.
 */
export type ExecutionResultStatus = 'SUCCESS' | 'FAILED' | 'RECOVERED' | 'UNRESOLVABLE' | 'PENDING';
export interface ExecutionResult<T = unknown> {
    /**
     * Operation identifier
     */
    operationId: string;
    /**
     * Final status
     */
    status: ExecutionResultStatus;
    /**
     * Payment status
     */
    paymentStatus: PaymentStatus;
    /**
     * Execution status
     */
    executionStatus: ExecutionStatus;
    /**
     * Result data (if successful)
     */
    data?: T;
    /**
     * Settlement proof (if available)
     */
    settlementProof?: SettlementProof;
    /**
     * Execution evidence (if available)
     */
    executionEvidence?: ExecutionEvidence;
    /**
     * All evidence records
     */
    evidence: EvidenceRecord[];
    /**
     * Error message (if failed)
     */
    error?: string;
    /**
     * Repair C3: Set when evidence persistence ultimately fails after the
     * bounded retry policy. The ORIGINAL business error remains in `error`;
     * this field carries the persistence failure so both are visible.
     */
    persistenceError?: {
        code: 'EVIDENCE_PERSISTENCE_FAILED';
        message: string;
        pendingEvidenceCount: number;
        attempts: number;
    };
}
export interface EvidenceStore {
    /**
     * Append an evidence record
     */
    append(record: EvidenceRecord): Promise<void>;
    /**
     * Get operation by ID
     */
    getOperation(operationId: string): Promise<Operation | null>;
    /**
     * Save/update operation
     */
    saveOperation(operation: Operation): Promise<void>;
    /**
     * Get all evidence for an operation
     */
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
    /**
     * Get operations by status (for recovery after restart)
     */
    getOperationsByStatus(status: OperationStatus): Promise<Operation[]>;
}
export interface SettlementObservation {
    settled: boolean;
    transactionHash?: string;
    blockNumber?: number;
    timestamp?: number;
    amount?: string;
    asset?: string;
    confirmations?: number;
    rawData?: unknown;
}
export interface PaymentAdapter {
    /**
     * Network this adapter handles
     */
    readonly network: string;
    /**
     * Create payment authorization
     */
    createAuthorization(requirement: PaymentRequirement, signer: PaymentSigner, context: SigningContext): Promise<PaymentAuthorization>;
    /**
     * Submit payment
     */
    submit(requirement: PaymentRequirement, authorization: PaymentAuthorization): Promise<PaymentSubmissionResult>;
    /**
     * Observe settlement
     */
    observeSettlement(requirement: PaymentRequirement, submissionResult: PaymentSubmissionResult): Promise<SettlementObservation>;
}
export interface PaymentSubmissionResult {
    success: boolean;
    transactionHash?: string;
    errorMessage?: string;
    rawData?: unknown;
}
export interface ExecuteRequest {
    /**
     * Target URL to execute
     */
    target: string;
    /**
     * HTTP method
     */
    method: string;
    /**
     * Request payload (if any)
     */
    payload?: unknown;
    /**
     * Payment policy constraints
     */
    policy: PaymentPolicy;
    /**
     * Optional request ID (generated if not provided).
     * Serves as the canonical idempotency key when combined with clientId.
     */
    requestId?: string;
    /**
     * Optional client identity for durable idempotency.
     * When provided with requestId, enables (clientId, requestId) deduplication.
     * Must represent the actual authenticated caller — never generated internally.
     */
    clientId?: string;
    /**
     * Address that will externally sign a non-custodial payment payload.
     * Stage A persists this binding and never derives it from a server signer.
     */
    authorizer?: string;
}
/**
 * §2: Canonical economic settlement states.
 * UNKNOWN is internal-only; API/UI uses PAYMENT_RECONCILING etc.
 * FAILED is NOT a valid settlement state — use RECONCILING instead.
 */
export type SettlementState = "PENDING_SIGNATURE" | "AUTHORIZED" | "SUBMITTING" | "SUBMITTED" | "SETTLEMENT_PENDING" | "RECONCILING" | "SETTLED" | "NOT_SETTLED" | "UNRESOLVED_MANUAL";
/**
 * §3: Economic safety invariant — the ONLY state that permits a new payment.
 * This is enforced at DB level via allowNewPayment() guard.
 */
export declare function allowNewPayment(state: SettlementState): boolean;
/** §19/§21: Terminal economic states. Once reached, a state transition out is
 *  forbidden for ANY worker (fencing/monotonicity). */
export declare const TERMINAL_SETTLEMENT_STATES: readonly SettlementState[];
/** §19/§21: true if `state` is terminal (irreversible). */
export declare function isTerminalSettlementState(state: SettlementState): boolean;
/** All states that BLOCK new payment creation. */
export declare const PAYMENT_BLOCKED_STATES: readonly SettlementState[];
/**
 * §2: API/UI labels for settlement states.
 */
export type PaymentDisplayState = "PAYMENT_PENDING_SIGNATURE" | "PAYMENT_AUTHORIZED" | "PAYMENT_SUBMITTING" | "PAYMENT_SUBMITTED" | "PAYMENT_SETTLEMENT_PENDING" | "PAYMENT_RECONCILING" | "PAYMENT_SETTLED" | "PAYMENT_NOT_SETTLED" | "PAYMENT_UNRESOLVED_MANUAL";
export declare function toDisplayState(state: SettlementState): PaymentDisplayState;
/**
 * §4: Durable Payment Intent — persisted BEFORE /settle network I/O.
 */
export interface DurablePaymentIntent {
    readonly paymentIntentId: string;
    readonly operationId: string;
    readonly requestId?: string;
    readonly clientId?: string;
    readonly authorizer: string;
    /** Canonical alias of `authorizer` (state-machine: authorizer = signed.payer).
     *  Surfaced by durable stores on round-trip so consumers can read it back. */
    readonly payer?: string;
    readonly payTo: string;
    readonly value: string;
    readonly asset: string;
    readonly network: string;
    readonly nonce: string;
    readonly validAfter: number;
    readonly validBefore: number;
    readonly paymentPayload: string;
    readonly paymentPayloadHash: string;
    settlementState: SettlementState;
    txHash?: string;
    facilitatorHttpStatus?: number;
    facilitatorResponseBody?: unknown;
    errorReason?: string;
    submitAttemptAt?: number;
    settledAt?: number;
    notSettledAt?: number;
    reconciliationObservations?: ReconciliationObservation[];
    settledEvidenceBundle?: SettledEvidenceBundle;
    notSettledEvidenceBundle?: NotSettledEvidenceBundle;
    probeCount?: number;
    nextProbeAt?: number;
    readonly createdAt: number;
    updatedAt: number;
}
/**
 * §22: Reconciliation observation — persisted per probe attempt.
 */
export interface ReconciliationObservation {
    readonly attemptId: string;
    readonly paymentIntentId: string;
    readonly timestamp: number;
    readonly rpcProviderId: string;
    readonly headBlock: number;
    readonly authorizationState: boolean | null;
    readonly validBefore: number;
    readonly result: "STILL_UNKNOWN" | "SETTLED_FOUND" | "NOT_SETTLED_CONFIRMED" | "RPC_ERROR" | "STALE_HEAD";
    readonly error?: string;
}
/**
 * §7 + §22: SETTLED evidence bundle — minimum proof for economic settlement.
 */
export interface SettledEvidenceBundle {
    readonly authorizationUsed: {
        readonly transactionHash: string;
        readonly blockNumber: number;
        readonly logIndex: number;
    };
    readonly receipt: {
        readonly status: 1;
        readonly blockNumber: number;
        readonly gasUsed: string;
    };
    readonly transfer: {
        readonly from: string;
        readonly to: string;
        readonly value: string;
        readonly tokenContract: string;
    };
    readonly confirmations: number;
    readonly finalityReached: boolean;
    readonly rpcObservations: ReconciliationObservation[];
}
/**
 * §11 + §23: NOT_SETTLED evidence bundle — strict positive proof.
 *
 * F-002 (external audit Blocker): `scanComplete: true` and
 * `authorizationUsedScanResult: "SCAN_COMPLETE_EMPTY"` may ONLY be written
 * after an actual AuthorizationUsed log scan executed on every independent
 * provider BEFORE the terminal CAS. The optional `authorizationUsedScan`
 * field carries the per-provider scan observations that back the claim, so
 * the bundle is self-evidencing instead of self-asserting.
 */
export interface NotSettledEvidenceBundle {
    readonly authorizer: string;
    readonly nonce: string;
    readonly validBefore: number;
    readonly expiryConfirmedAt: number;
    readonly authorizationStateFalse: true;
    readonly rpcObservations: readonly RpcObservationForNotSettled[];
    readonly scanComplete: boolean;
    readonly authorizationUsedScanResult: "NOT_FOUND" | "SCAN_COMPLETE_EMPTY";
    readonly authorizationUsedScan?: AuthorizationUsedScanSummary;
}
/**
 * F-002: Honest per-provider AuthorizationUsed scan observation.
 * `scanned: true` means the provider ACTUALLY executed the log query over
 * [fromBlock, toBlock] — never inferred, never defaulted, never assumed.
 */
export interface AuthorizationUsedScanObservation {
    readonly providerId: string;
    readonly underlyingProvider: string;
    /** true only when this provider executed the full-range log scan */
    readonly scanned: boolean;
    /** event found by this provider; null when the scan ran and found nothing */
    readonly event: {
        transactionHash: string;
        blockNumber: number;
        logIndex: number;
    } | null;
    readonly fromBlock: number;
    readonly toBlock: number;
    /** provider chain head at scan time — freshness witness for the empty result */
    readonly chainHead: number;
    readonly error?: string;
    readonly observedAt: number;
}
/** F-002: Outcome of the multi-provider AuthorizationUsed scan. */
export type AuthorizationUsedScanOutcome = "SCAN_COMPLETE_EMPTY" | "EVENT_FOUND" | "DISAGREEMENT" | "INCOMPLETE";
/** F-002: Scan summary persisted inside NotSettledEvidenceBundle. */
export interface AuthorizationUsedScanSummary {
    readonly outcome: AuthorizationUsedScanOutcome;
    readonly observations: readonly AuthorizationUsedScanObservation[];
}
/**
 * §14-15: Individual RPC observation for NOT_SETTLED proof.
 */
export interface RpcObservationForNotSettled {
    readonly providerId: string;
    readonly underlyingProvider: string;
    readonly observedAt: number;
    readonly blockNumber: number;
    readonly chainHead: number;
    readonly authorizationState: false;
    readonly stalenessBlocks: number;
    readonly error?: string;
}
/**
 * §14-15: RPC provider configuration with independence tracking.
 */
export interface RpcProviderConfig {
    readonly providerId: string;
    readonly underlyingProvider: string;
    readonly rpcUrl: string;
    readonly maxStalenessBlocks: number;
    /** Expected EVM chain ID. A provider returning another chain is invalid. */
    readonly chainId?: number;
}
/**
 * §16: Reconciliation schedule configuration.
 */
export interface ReconciliationScheduleConfig {
    readonly probes: readonly number[];
    readonly periodicIntervalMs: number;
    readonly safetyBufferAfterExpiryMs: number;
}
export declare const DEFAULT_RECONCILIATION_SCHEDULE: ReconciliationScheduleConfig;
/**
 * §24: Confirmation/finality policy.
 */
export interface FinalityPolicy {
    readonly requiredConfirmations: number;
    readonly reorgIncidentThreshold: number;
}
export declare const DEFAULT_FINALITY_POLICY: FinalityPolicy;
/** @deprecated Use SettlementState instead */
/** @deprecated Use DurablePaymentIntent instead */
export type NonceStatus = "RESERVED" | "SIGNED" | "SUBMITTED" | "SETTLED";
export interface NonceRecord {
    readonly nonce: string;
    readonly operationId: string;
    status: NonceStatus;
    payer: string;
    createdAt: number;
    updatedAt: number;
}
export interface DurableEvidenceStore {
    append(record: EvidenceRecord): Promise<void>;
    getOperation(operationId: string): Promise<Operation | null>;
    saveOperation(operation: Operation): Promise<void>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
    getOperationsByStatus(status: OperationStatus): Promise<Operation[]>;
    createPaymentIntent(intent: DurablePaymentIntent): Promise<void>;
    getPaymentIntentByOperationId(operationId: string): Promise<DurablePaymentIntent | null>;
    getPaymentIntentByRequestId?(requestId: string): Promise<DurablePaymentIntent | null>;
    /** R0 repair: optional scanner for PostSettlementEngine.ensureExecutionObligations().
     *  Returns SETTLED intents that have no durable EXECUTION obligation. */
    getSettledIntentsWithoutObligation?(limit?: number): Promise<DurablePaymentIntent[]>;
    updatePaymentIntentAuthorization?: (paymentIntentId: string, fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">) => Promise<void>;
    updatePaymentIntentStatus(intentId: string, status: SettlementState, extra?: Partial<Pick<DurablePaymentIntent, "txHash" | "facilitatorHttpStatus" | "facilitatorResponseBody" | "errorReason">>): Promise<void>;
    /**
     * F-108/F-109 (external audit 2026-10-26, Major + Minor): CAS-guarded
     * ATOMIC payment-intent authorization. Replaces the racy
     * updatePaymentIntentAuthorization() + updatePaymentIntentStatus() pair
     * whose two blind writes allowed (a) a concurrent Stage B caller to
     * silently OVERWRITE the signed payload (last-writer-wins after a
     * TOCTOU on PENDING_SIGNATURE) and (b) a blind status write to REGRESS an
     * intent a concurrent submission had already advanced (SUBMITTING →
     * AUTHORIZED), re-opening the submission window. One conditional statement
     * binds payload + AUTHORIZED atomically; the blind pair is legacy-only.
     *
     * Contract (mirrored by every implementation):
     *   true   — this call performed the PENDING_SIGNATURE → AUTHORIZED
     *            transition and durably bound the payload;
     *   false  — CAS lost BUT the intent already carries the IDENTICAL
     *            payload hash (idempotent concurrent replay; never an error —
     *            the concurrent winner owns the pipeline);
     *   throws INTENT_NOT_FOUND                      — no such intent;
     *   throws PAYMENT_INTENT_AUTHORIZATION_CONFLICT — a DIFFERENT payload is
     *            durably bound (or the intent is terminal with a different
     *            payload). Callers MUST fail closed: the payload is never
     *            overwritten.
     */
    authorizePaymentIntent?(paymentIntentId: string, fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">, expectedState?: SettlementState): Promise<boolean>;
    reserveNonce(nonce: string, operationId: string, payer: string): Promise<void>;
    getNonce(nonce: string): Promise<NonceRecord | null>;
    markNonceSigned(nonce: string): Promise<void>;
    markNonceSubmitted(nonce: string): Promise<void>;
    markNonceSettled(nonce: string): Promise<void>;
    createIntentWithNonce(intent: DurablePaymentIntent, payer: string): Promise<void>;
    compareAndSetState(intentId: string, expectedState: SettlementState, newState: SettlementState, extra?: Partial<DurablePaymentIntent>): Promise<boolean>;
    transitionToSubmitting(paymentIntentId: string): Promise<boolean>;
    recordSubmissionResult(paymentIntentId: string, newState: SettlementState, txHash?: string, facilitatorHttpStatus?: number, facilitatorResponseBody?: unknown): Promise<boolean>;
    getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null>;
    getNonTerminalIntents(): Promise<DurablePaymentIntent[]>;
    canCreateNewPayment(operationId: string): Promise<boolean>;
    appendReconciliationObservation(observation: ReconciliationObservation): Promise<void>;
    getReconciliationObservations(paymentIntentId: string): Promise<ReconciliationObservation[]>;
    saveSettledEvidenceBundle(intentId: string, bundle: SettledEvidenceBundle): Promise<void>;
    saveNotSettledEvidenceBundle(intentId: string, bundle: NotSettledEvidenceBundle): Promise<void>;
    getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null>;
    getOperationByRequestId?(requestId: string, clientId?: string): Promise<Operation | null>;
    createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string>;
    getDueReconciliationJobs(limit?: number): Promise<Array<{
        jobId: string;
        paymentIntentId: string;
        probeCount: number;
    }>>;
    claimReconciliationJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean>;
    getReconciliationJobById?(jobId: string): Promise<{
        jobId: string;
        paymentIntentId: string;
        probeCount: number;
        status: string;
    } | null>;
    completeReconciliationJob(jobId: string, workerId: string): Promise<boolean>;
    rescheduleReconciliationJob(jobId: string, workerId: string, nextProbeAt: Date): Promise<boolean>;
    failReconciliationJob(jobId: string, workerId: string, error: string): Promise<boolean>;
    updatePaymentIntentProbeCount(paymentIntentId: string, probeCount: number): Promise<void>;
}
/**
 * Explicit contract for payment submission safety transitions.
 * All methods are REQUIRED. No optional chaining. No as any.
 * Implementations MUST provide atomic DB-level guarantees.
 */
export interface PaymentSubmissionStore extends DurableEvidenceStore {
    /** P0-1: Atomically transition AUTHORIZED -> SUBMITTING before network I/O */
    transitionToSubmitting(paymentIntentId: string): Promise<boolean>;
    /** P0-1: Record facilitator response result after network I/O */
    recordSubmissionResult(paymentIntentId: string, newState: SettlementState, txHash?: string, facilitatorHttpStatus?: number, facilitatorResponseBody?: unknown): Promise<boolean>;
    /** P0-6: Find all non-terminal intents for batch reconciliation */
    getNonTerminalIntents(): Promise<DurablePaymentIntent[]>;
    /** Lookup by paymentIntentId (not operationId) */
    getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null>;
}
//# sourceMappingURL=types.d.ts.map