/**
 * Zeus Secretariat V0 - Payment Signer Interface
 * 
 * Architectural Principle:
 * Secretariat does NOT store private keys as part of core architecture.
 * Each authorization is bound to exactly one operation.
 * Payment parameters are immutable after signing.
 */

import { PaymentAuthorizationRequest, PaymentSignatureResult } from './payment-types';

/**
 * PaymentSigner boundary interface.
 * 
 * The signer receives ONLY a validated PaymentAuthorizationRequest
 * and returns a PaymentSignatureResult.
 * 
 * The signer MUST NOT know about:
 * - evidence
 * - seller capability
 * - retry count
 * - insurance
 * - risk score
 * - HTTP response
 */
export interface PaymentSigner {
  /**
   * Stable identifier of signer implementation.
   * Examples: 'LOCAL_EOA', 'WALLET_CONNECT', 'KMS', 'HSM'
   */
  readonly signerType: string;

  /**
   * Returns payer address/account controlled by this signer.
   */
  getAddress(): Promise<string>;

  /**
   * Signs exactly one validated payment authorization.
   * 
   * @param request - PaymentAuthorizationRequest with all required fields
   * @returns PaymentSignatureResult with verified binding
   * 
   * CRITICAL INVARIANTS:
   * 1. result.operationId === request.operationId
   * 2. result.payer === request.payer
   * 3. result.nonce === request.nonce
   * 4. Signing happens ONLY after policy validation
   * 5. Nonce must be unique and reserved before signing
   */
  signPayment(
    request: PaymentAuthorizationRequest
  ): Promise<PaymentSignatureResult>;
}
