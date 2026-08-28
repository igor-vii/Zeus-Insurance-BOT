/**
 * Zeus Secretariat V0 - Mock Payment Signer for Testing
 * 
 * Allows testing of:
 * - Success scenarios
 * - Failure scenarios
 * - Binding mismatch scenarios
 */

import { PaymentSigner } from '../core/payment-signer';
import {
  PaymentAuthorizationRequest,
  PaymentSignatureResult,
} from '../core/payment-types';
import {
  SignerBindingError,
  PaymentSigningError,
} from '../core/payment-errors';

export interface MockSignerConfig {
  /**
   * Payer address to return from getAddress().
   */
  payerAddress: string;

  /**
   * If true, signer will throw an error on signPayment.
   */
  shouldFail?: boolean;

  /**
   * Error message to throw if shouldFail is true.
   */
  failureMessage?: string;

  /**
   * If set, signer will return a mismatched nonce.
   */
  mismatchedNonce?: string;

  /**
   * If set, signer will return a mismatched operationId.
   */
  mismatchedOperationId?: string;

  /**
   * If set, signer will return a mismatched payer.
   */
  mismatchedPayer?: string;
}

export class MockPaymentSigner implements PaymentSigner {
  readonly signerType = 'MOCK';

  constructor(private config: MockSignerConfig) {}

  async getAddress(): Promise<string> {
    return this.config.payerAddress;
  }

  async signPayment(
    request: PaymentAuthorizationRequest
  ): Promise<PaymentSignatureResult> {
    // Simulate failure
    if (this.config.shouldFail) {
      throw new PaymentSigningError(
        this.config.failureMessage ?? 'Mock signer failure'
      );
    }

    // Check for binding mismatches (simulating buggy signer)
    const resultNonce = this.config.mismatchedNonce ?? request.nonce;
    const resultOperationId = this.config.mismatchedOperationId ?? request.operationId;
    const resultPayer = this.config.mismatchedPayer ?? request.payer;

    return {
      operationId: resultOperationId,
      signerType: this.signerType,
      payer: resultPayer,
      nonce: resultNonce,
      signature: `0x_mock_signature_${request.operationId}`,
      signedAt: new Date().toISOString(),
    };
  }
}

/**
 * Factory for creating mock signers with specific behaviors.
 */
export class MockSignerFactory {
  static success(payerAddress: string): MockPaymentSigner {
    return new MockPaymentSigner({
      payerAddress,
      shouldFail: false,
    });
  }

  static failure(payerAddress: string, message?: string): MockPaymentSigner {
    return new MockPaymentSigner({
      payerAddress,
      shouldFail: true,
      failureMessage: message,
    });
  }

  static bindingMismatch(
    payerAddress: string,
    options: {
      mismatchedNonce?: string;
      mismatchedOperationId?: string;
      mismatchedPayer?: string;
    }
  ): MockPaymentSigner {
    return new MockPaymentSigner({
      payerAddress,
      ...options,
    });
  }
}
