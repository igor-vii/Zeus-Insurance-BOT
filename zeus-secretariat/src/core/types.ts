/**
 * Zeus Secretariat V0 - Core Domain Types
 * 
 * Architectural Principle:
 * Build an independent Zeus Secretariat. Reuse proven x402 implementation patterns where useful,
 * but do not import Syra's architecture, dependencies, retry semantics, or economic assumptions.
 * The Secretariat owns the operation state machine, payment intent lifecycle, settlement observation,
 * execution observation, recovery policy, and durable evidence.
 */

// ============================================================================
// OPERATION STATE MACHINE
// ============================================================================

export type OperationStatus =
  | 'CREATED'
  | 'DISCOVERING'
  | 'PAYMENT_REQUIRED'
  | 'AUTHORIZED'
  | 'PAYMENT_SUBMITTED'
  | 'SETTLEMENT_PENDING'
  | 'SETTLEMENT_UNKNOWN'
  | 'SETTLED'
  | 'EXECUTION_PENDING'
  | 'EXECUTION_CONFIRMED'
  | 'DELIVERED'
  | 'SUCCESS'
  | 'FAILED'
  | 'POLICY_REJECTED'
  | 'SETTLEMENT_FAILED'
  | 'EXECUTION_UNKNOWN'
  | 'RECOVERY_PENDING'
  | 'RECOVERED'
  | 'UNRESOLVABLE';

export type PaymentStatus =
  | 'NOT_STARTED'
  | 'AUTHORIZED'
  | 'SUBMITTED'
  | 'SETTLED'
  | 'FAILED'
  | 'UNKNOWN';

export type ExecutionStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'UNKNOWN';

// ============================================================================
// CORE DOMAIN OBJECTS
// ============================================================================

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

// ============================================================================
// PAYMENT POLICY
// ============================================================================

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

// ============================================================================
// SELLER CAPABILITIES
// ============================================================================

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

export type RecoveryCapability =
  | 'NONE'
  | 'EXECUTION_IDEMPOTENT'
  | 'RESULT_RETRIEVAL'
  | 'SIGNED_RECEIPT';

// ============================================================================
// PAYMENT INTENT
// ============================================================================



// ============================================================================
// PAYMENT REQUIREMENT & AUTHORIZATION
// ============================================================================

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

// ============================================================================
// SIGNER ABSTRACTION
// Secretariat does NOT know where private keys are stored
// ============================================================================

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
  signPayment(
    requirement: PaymentRequirement,
    context: SigningContext
  ): Promise<PaymentAuthorization>;
}

// ============================================================================
// SETTLEMENT & EXECUTION EVIDENCE
// ============================================================================

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

// ============================================================================
// EVIDENCE RECORD
// Every critical transition creates an immutable evidence record
// ============================================================================

export type EvidencePhase =
  | 'DISCOVERY'
  | 'POLICY'
  | 'PAYMENT'
  | 'SETTLEMENT'
  | 'EXECUTION'
  | 'DELIVERY'
  | 'RECOVERY'
  | 'FINAL';

export interface EvidenceRecord {
  readonly operationId: string;
  readonly phase: EvidencePhase;
  readonly timestamp: number;
  readonly event: string;
  readonly payload: unknown;
}

// ============================================================================
// FINAL RESULT
// ============================================================================

export interface ExecutionResult<T = unknown> {
  /**
   * Operation identifier
   */
  operationId: string;
  
  /**
   * Final status
   */
  status: 'SUCCESS' | 'FAILED' | 'RECOVERED' | 'UNRESOLVABLE';
  
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
}

// ============================================================================
// DURABLE EVIDENCE STORE INTERFACE
// Cannot use in-memory array as sole storage
// ============================================================================

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

// ============================================================================
// PAYMENT ADAPTER INTERFACE
// Core doesn't know specific networks (Solana, Base, X Layer, etc.)
// Adapter knows the specific network
// ============================================================================

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
  createAuthorization(
    requirement: PaymentRequirement,
    signer: PaymentSigner,
    context: SigningContext
  ): Promise<PaymentAuthorization>;
  
  /**
   * Submit payment
   */
  submit(
    requirement: PaymentRequirement,
    authorization: PaymentAuthorization
  ): Promise<PaymentSubmissionResult>;
  
  /**
   * Observe settlement
   */
  observeSettlement(
    requirement: PaymentRequirement,
    submissionResult: PaymentSubmissionResult
  ): Promise<SettlementObservation>;
}

export interface PaymentSubmissionResult {
  success: boolean;
  transactionHash?: string;
  errorMessage?: string;
  rawData?: unknown;
}

// ============================================================================
// REQUEST CONTEXT
// ============================================================================

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
}

// ============================================================================
// RECONCILIATION PROTOCOL V0.1 — CANONICAL TYPES
// Frozen spec: zeus-secretariat/docs/RECONCILIATION_PROTOCOL_SPEC_V0.1.md
// ============================================================================

/**
 * §2: Canonical economic settlement states.
 * UNKNOWN is internal-only; API/UI uses PAYMENT_RECONCILING etc.
 * FAILED is NOT a valid settlement state — use RECONCILING instead.
 */
export type SettlementState =
  | "AUTHORIZED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "SETTLEMENT_PENDING"
  | "RECONCILING"
  | "SETTLED"
  | "NOT_SETTLED"
  | "UNRESOLVED_MANUAL";

/**
 * §3: Economic safety invariant — the ONLY state that permits a new payment.
 * This is enforced at DB level via allowNewPayment() guard.
 */
export function allowNewPayment(state: SettlementState): boolean {
  return state === "NOT_SETTLED";
}

/** All states that BLOCK new payment creation. */
export const PAYMENT_BLOCKED_STATES: readonly SettlementState[] = [
  "AUTHORIZED",
  "SUBMITTING",
  "SUBMITTED",
  "SETTLEMENT_PENDING",
  "RECONCILING",
  "SETTLED",
  "UNRESOLVED_MANUAL",
] as const;

/**
 * §2: API/UI labels for settlement states.
 */
export type PaymentDisplayState =
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_SUBMITTING"
  | "PAYMENT_SUBMITTED"
  | "PAYMENT_SETTLEMENT_PENDING"
  | "PAYMENT_RECONCILING"
  | "PAYMENT_SETTLED"
  | "PAYMENT_NOT_SETTLED"
  | "PAYMENT_UNRESOLVED_MANUAL";

export function toDisplayState(state: SettlementState): PaymentDisplayState {
  const map: Record<SettlementState, PaymentDisplayState> = {
    AUTHORIZED: "PAYMENT_AUTHORIZED",
    SUBMITTING: "PAYMENT_SUBMITTING",
    SUBMITTED: "PAYMENT_SUBMITTED",
    SETTLEMENT_PENDING: "PAYMENT_SETTLEMENT_PENDING",
    RECONCILING: "PAYMENT_RECONCILING",
    SETTLED: "PAYMENT_SETTLED",
    NOT_SETTLED: "PAYMENT_NOT_SETTLED",
    UNRESOLVED_MANUAL: "PAYMENT_UNRESOLVED_MANUAL",
  };
  return map[state];
}

/**
 * §4: Durable Payment Intent — persisted BEFORE /settle network I/O.
 */
export interface DurablePaymentIntent {
  readonly paymentIntentId: string;
  readonly operationId: string;
  readonly requestId?: string;
  readonly clientId?: string;

  // Authorization fields
  readonly authorizer: string;       // from address
  readonly payTo: string;            // to address
  readonly value: string;            // USDC amount (decimal string)
  readonly asset: string;            // token contract address
  readonly network: string;          // e.g., "base-sepolia"

  // EIP-3009 authorization fields
  readonly nonce: string;            // hex nonce
  readonly validAfter: number;       // epoch seconds
  readonly validBefore: number;      // epoch seconds

  // Signed payload
  readonly paymentPayload: string;   // base64-encoded signed authorization
  readonly paymentPayloadHash: string; // keccak256 of paymentPayload

  // Lifecycle
  settlementState: SettlementState;
  txHash?: string;
  facilitatorHttpStatus?: number;
  facilitatorResponseBody?: unknown;
  errorReason?: string;
  submitAttemptAt?: number;
  settledAt?: number;
  notSettledAt?: number;

  // Evidence
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
  readonly authorizationState: boolean | null; // null = RPC error
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
    readonly status: 1; // must be success
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
}

/**
 * §14-15: Individual RPC observation for NOT_SETTLED proof.
 */
export interface RpcObservationForNotSettled {
  readonly providerId: string;       // e.g., "alchemy-base-sepolia"
  readonly underlyingProvider: string; // e.g., "alchemy" — for independence check
  readonly observedAt: number;
  readonly blockNumber: number;
  readonly chainHead: number;
  readonly authorizationState: false; // must be false for NOT_SETTLED
  readonly stalenessBlocks: number;   // chainHead - blockNumber
  readonly error?: string;
}

/**
 * §14-15: RPC provider configuration with independence tracking.
 */
export interface RpcProviderConfig {
  readonly providerId: string;
  readonly underlyingProvider: string; // "alchemy" | "infura" | "ankr" | etc.
  readonly rpcUrl: string;
  readonly maxStalenessBlocks: number; // how many blocks behind is acceptable
}

/**
 * §16: Reconciliation schedule configuration.
 */
export interface ReconciliationScheduleConfig {
  readonly probes: readonly number[]; // delays in ms: [2000, 10000, 30000, 120000]
  readonly periodicIntervalMs: number; // after initial probes: retry interval
  readonly safetyBufferAfterExpiryMs: number; // e.g., 120000 (2 min after validBefore)
}

export const DEFAULT_RECONCILIATION_SCHEDULE: ReconciliationScheduleConfig = {
  probes: [2_000, 10_000, 30_000, 120_000] as const,
  periodicIntervalMs: 60_000,
  safetyBufferAfterExpiryMs: 120_000,
};

/**
 * §24: Confirmation/finality policy.
 */
export interface FinalityPolicy {
  readonly requiredConfirmations: number;
  readonly reorgIncidentThreshold: number; // if reorg depth exceeds this → INCIDENT
}

export const DEFAULT_FINALITY_POLICY: FinalityPolicy = {
  requiredConfirmations: 12,
  reorgIncidentThreshold: 6,
};

// ---------------------------------------------------------------------------
// Legacy aliases for backward compatibility with Phases 2.1-2.4
// ---------------------------------------------------------------------------

/** @deprecated Use SettlementState instead */

/** @deprecated Use DurablePaymentIntent instead */

export type NonceStatus =
  | "RESERVED"
  | "SIGNED"
  | "SUBMITTED"
  | "SETTLED";

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
  updatePaymentIntentAuthorization?: (
    paymentIntentId: string,
    fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">,
  ) => Promise<void>;
  updatePaymentIntentStatus(
    intentId: string,
    status: SettlementState,
    extra?: Partial<Pick<DurablePaymentIntent, "txHash" | "facilitatorHttpStatus" | "facilitatorResponseBody" | "errorReason">>,
  ): Promise<void>;
  reserveNonce(nonce: string, operationId: string, payer: string): Promise<void>;
  getNonce(nonce: string): Promise<NonceRecord | null>;
  markNonceSigned(nonce: string): Promise<void>;
  markNonceSubmitted(nonce: string): Promise<void>;
  markNonceSettled(nonce: string): Promise<void>;
  createIntentWithNonce(intent: DurablePaymentIntent, payer: string): Promise<void>;

  // P0: Atomic terminal transition (CAS)
  compareAndSetState(
    intentId: string,
    expectedState: SettlementState,
    newState: SettlementState,
    extra?: Partial<DurablePaymentIntent>,
  ): Promise<boolean>;

  // P0-1: REQUIRED — atomic transition AUTHORIZED -> SUBMITTING before network I/O
  // No optional chaining allowed. This is a hard contract requirement.
  transitionToSubmitting(paymentIntentId: string): Promise<boolean>;

  // P0-1: REQUIRED — record facilitator response atomically (SUBMITTING -> next state)
  recordSubmissionResult(
    paymentIntentId: string,
    newState: SettlementState,
    txHash?: string,
    facilitatorHttpStatus?: number,
    facilitatorResponseBody?: unknown,
  ): Promise<boolean>;

  // P0-6: REQUIRED — lookup by paymentIntentId (not just operationId)
  getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null>;

  // P0-6: REQUIRED — find all non-terminal intents for batch reconciliation
  getNonTerminalIntents(): Promise<DurablePaymentIntent[]>;

  // P0: Economic safety guard
  canCreateNewPayment(operationId: string): Promise<boolean>;

  // P0: Reconciliation observations
  appendReconciliationObservation(observation: ReconciliationObservation): Promise<void>;
  getReconciliationObservations(paymentIntentId: string): Promise<ReconciliationObservation[]>;

  // P0: Evidence bundles
  saveSettledEvidenceBundle(intentId: string, bundle: SettledEvidenceBundle): Promise<void>;
  saveNotSettledEvidenceBundle(intentId: string, bundle: NotSettledEvidenceBundle): Promise<void>;

  // B8-001: Durable idempotency lookup
  getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null>;

  // B.3-B2-FIX: Reconciliation job lifecycle (lease-safe atomic operations)
  createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string>;
  getDueReconciliationJobs(): Promise<Array<{ jobId: string; paymentIntentId: string; probeCount: number }>>;
  claimReconciliationJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean>;
  completeReconciliationJob(jobId: string, workerId: string): Promise<boolean>;
  rescheduleReconciliationJob(jobId: string, workerId: string, nextProbeAt: Date): Promise<boolean>;
  failReconciliationJob(jobId: string, workerId: string, error: string): Promise<boolean>;

  // B.3-B2-WIRING: Sync canonical probe count from job to DPI before reconcile
  updatePaymentIntentProbeCount(paymentIntentId: string, probeCount: number): Promise<void>;
}

// ============================================================================
// ATOMIC SETTLEMENT → EXECUTION HANDOFF CONTRACT (R2.1-FIX-5)
// ============================================================================


// ============================================================================
// PAYMENT SUBMISSION STORE INTERFACE (P0 - no as any, no optional methods)
// ============================================================================

/**
 * Explicit contract for payment submission safety transitions.
 * All methods are REQUIRED. No optional chaining. No as any.
 * Implementations MUST provide atomic DB-level guarantees.
 */
export interface PaymentSubmissionStore extends DurableEvidenceStore {
  /** P0-1: Atomically transition AUTHORIZED -> SUBMITTING before network I/O */
  transitionToSubmitting(paymentIntentId: string): Promise<boolean>;

  /** P0-1: Record facilitator response result after network I/O */
  recordSubmissionResult(
    paymentIntentId: string,
    newState: SettlementState,
    txHash?: string,
    facilitatorHttpStatus?: number,
    facilitatorResponseBody?: unknown,
  ): Promise<boolean>;

  /** P0-6: Find all non-terminal intents for batch reconciliation */
  getNonTerminalIntents(): Promise<DurablePaymentIntent[]>;

  /** Lookup by paymentIntentId (not operationId) */
  getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null>;
}

