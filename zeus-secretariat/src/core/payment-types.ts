/**
 * Zeus Secretariat V0 - Payment Types for Signer Boundary
 * 
 * These types define the strict boundary between Secretariat core
 * and external payment signers.
 */

/**
 * PaymentAuthorizationRequest - The ONLY data sent to a PaymentSigner.
 * 
 * All fields are required and validated BEFORE signing.
 * After signing, these parameters become immutable.
 */
export interface PaymentAuthorizationRequest {
  /**
   * Main immutable identifier.
   * Invariant: One economic operation = one operationId.
   */
  readonly operationId: string;

  /**
   * Payment scheme (e.g., 'x402', 'EIP-3009')
   */
  readonly scheme: string;

  /**
   * Blockchain network (e.g., 'base-sepolia', 'base-mainnet')
   */
  readonly network: string;

  /**
   * Asset to pay with (e.g., 'USDC', 'ETH')
   */
  readonly asset: string;

  /**
   * Payer address (who is paying)
   */
  readonly payer: string;

  /**
   * Payee address (who receives payment)
   */
  readonly payTo: string;

  /**
   * Amount to pay (as string to preserve precision)
   */
  readonly amount: string;

  /**
   * Unique nonce for this authorization.
   * Must be cryptographically random and unique per operation.
   * Format: 0x + 64 hex characters (bytes32-compatible for EIP-3009)
   */
  readonly nonce: string;

  /**
   * Validity window start (Unix timestamp in seconds)
   */
  readonly validAfter: number;

  /**
   * Validity window end (Unix timestamp in seconds)
   * Must be > validAfter
   */
  readonly validBefore: number;

  /**
   * Request creation timestamp (ISO 8601)
   */
  readonly createdAt: string;
}

/**
 * PaymentSignatureResult - Result from a successful signing operation.
 * 
 * CRITICAL: Secretariat MUST verify binding before accepting:
 * - result.operationId === request.operationId
 * - result.payer === request.payer
 * - result.nonce === request.nonce
 */
export interface PaymentSignatureResult {
  /**
   * Operation ID this signature is bound to.
   * MUST match the request.operationId.
   */
  readonly operationId: string;

  /**
   * Type of signer that created this signature.
   * Examples: 'LOCAL_EOA', 'WALLET_CONNECT', 'KMS', 'HSM'
   */
  readonly signerType: string;

  /**
   * Payer address that signed the authorization.
   * MUST match the request.payer.
   */
  readonly payer: string;

  /**
   * Nonce used in the signature.
   * MUST match the request.nonce.
   */
  readonly nonce: string;

  /**
   * The actual signature (scheme-specific encoding).
   * For EIP-3009: ECDSA signature bytes as hex string.
   */
  readonly signature: string;

  /**
   * Timestamp when signature was created (ISO 8601).
   */
  readonly signedAt: string;
}

/**
 * SignedPaymentAuthorization - Immutable record of a completed signing.
 * 
 * This combines the request and result for persistence and future use.
 * The BasePaymentAdapter will convert this to x402 PaymentPayload.
 */
export interface SignedPaymentAuthorization {
  /**
   * Original authorization request (immutable).
   */
  readonly request: PaymentAuthorizationRequest;

  /**
   * Signature result (immutable).
   */
  readonly signatureResult: PaymentSignatureResult;
}

/**
 * Payment Authorization State - tracks the lifecycle of signing.
 * 
 * This is separate from top-level operation state.
 */
export type PaymentAuthorizationState =
  | 'NOT_CREATED'
  | 'INTENT_CREATED'
  | 'SIGNING'
  | 'SIGNED'
  | 'SIGNATURE_UNKNOWN'
  | 'FAILED';

/**
 * NonceGenerator interface for creating unique nonces.
 */
export interface NonceGenerator {
  /**
   * Generate a cryptographically secure nonce.
   * Format: 0x + 64 hex characters (bytes32-compatible).
   */
  generate(): string;
}

/**
 * NonceRegistry interface for preventing nonce reuse.
 */
export interface NonceRegistry {
  /**
   * Reserve a nonce for a specific operation.
   * Throws NonceAlreadyUsedError if nonce is already reserved.
   * 
   * @param operationId - Operation this nonce is bound to
   * @param nonce - The nonce value to reserve
   */
  reserveNonce(operationId: string, nonce: string): Promise<void>;

  /**
   * Check if a nonce is already reserved.
   */
  isNonceReserved(nonce: string): Promise<boolean>;

  /**
   * Get the operation ID associated with a nonce.
   */
  getOperationForNonce(nonce: string): Promise<string | null>;
}
