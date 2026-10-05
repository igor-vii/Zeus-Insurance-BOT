/**
 * Zeus Secretariat V0 - Mock Payment Signer for Testing
 *
 * Allows testing of:
 * - Success scenarios
 * - Failure scenarios
 * - Binding mismatch scenarios
 */
import { PaymentSigner } from '../core/payment-signer.js';
import { PaymentAuthorizationRequest, PaymentSignatureResult } from '../core/payment-types.js';
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
export declare class MockPaymentSigner implements PaymentSigner {
    private config;
    readonly signerType = "MOCK";
    constructor(config: MockSignerConfig);
    getAddress(): Promise<string>;
    signPayment(request: PaymentAuthorizationRequest): Promise<PaymentSignatureResult>;
}
/**
 * Factory for creating mock signers with specific behaviors.
 */
export declare class MockSignerFactory {
    static success(payerAddress: string): MockPaymentSigner;
    static failure(payerAddress: string, message?: string): MockPaymentSigner;
    static bindingMismatch(payerAddress: string, options: {
        mismatchedNonce?: string;
        mismatchedOperationId?: string;
        mismatchedPayer?: string;
    }): MockPaymentSigner;
}
//# sourceMappingURL=mock-payment-signer.d.ts.map