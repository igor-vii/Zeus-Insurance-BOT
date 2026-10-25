/**
 * Zeus Secretariat V0 - Mock Payment Signer for Testing
 *
 * Allows testing of:
 * - Success scenarios
 * - Failure scenarios
 * - Binding mismatch scenarios
 */
import { PaymentSigningError, } from '../core/payment-errors.js';
export class MockPaymentSigner {
    config;
    signerType = 'MOCK';
    constructor(config) {
        this.config = config;
    }
    async getAddress() {
        return this.config.payerAddress;
    }
    async signPayment(request) {
        // Simulate failure
        if (this.config.shouldFail) {
            throw new PaymentSigningError(this.config.failureMessage ?? 'Mock signer failure');
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
    static success(payerAddress) {
        return new MockPaymentSigner({
            payerAddress,
            shouldFail: false,
        });
    }
    static failure(payerAddress, message) {
        return new MockPaymentSigner({
            payerAddress,
            shouldFail: true,
            failureMessage: message,
        });
    }
    static bindingMismatch(payerAddress, options) {
        return new MockPaymentSigner({
            payerAddress,
            ...options,
        });
    }
}
//# sourceMappingURL=mock-payment-signer.js.map