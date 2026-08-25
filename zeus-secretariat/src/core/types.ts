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
   * Original request identifier from the agent/client
   */
  readonly requestId: string;
  
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

export interface PaymentIntent {
  readonly operationId: string;
  readonly requirement: PaymentRequirement;
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  
  authorization?: PaymentAuthorization;
  readonly createdAt: number;
  
  status: PaymentIntentStatus;
  
  transactionHash?: string;
  submittedAt?: number;
  settledAt?: number;
  failedAt?: number;
}

export type PaymentIntentStatus =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'SUBMITTED'
  | 'SETTLED'
  | 'FAILED'
  | 'UNKNOWN';

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
   * Optional request ID (generated if not provided)
   */
  requestId?: string;
}
