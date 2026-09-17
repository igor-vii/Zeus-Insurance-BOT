/**
 * Zeus Secretariat V0 - Payment Adapters
 *
 * Adapters are network-specific implementations.
 * Core does not know about Solana, Base, X Layer, etc.
 * Adapter knows the specific network.
 */
export class MockPaymentAdapter {
    network;
    simulateSettlement;
    settlementDelay;
    failProbability;
    constructor(config) {
        this.network = config.network;
        this.simulateSettlement = config.simulateSettlement ?? true;
        this.settlementDelay = config.settlementDelay ?? 100;
        this.failProbability = config.failProbability ?? 0;
    }
    async createAuthorization(requirement, signer, context) {
        // Delegate to external signer
        return await signer.signPayment(requirement, context);
    }
    async submit(requirement, authorization) {
        // Simulate submission failure based on probability
        if (Math.random() < this.failProbability) {
            return {
                success: false,
                errorMessage: 'Simulated submission failure',
            };
        }
        // Generate mock transaction hash
        const txHash = `0x${Math.random().toString(16).substring(2, 66)}`;
        return {
            success: true,
            transactionHash: txHash,
            rawData: {
                network: this.network,
                amount: requirement.amount,
                asset: requirement.asset,
                payee: requirement.payee,
            },
        };
    }
    async observeSettlement(requirement, submissionResult) {
        if (!this.simulateSettlement) {
            return {
                settled: false,
            };
        }
        // Simulate settlement delay
        await new Promise(resolve => setTimeout(resolve, this.settlementDelay));
        // Simulate settlement failure based on probability
        if (Math.random() < this.failProbability) {
            return {
                settled: false,
                transactionHash: submissionResult.transactionHash,
            };
        }
        return {
            settled: true,
            transactionHash: submissionResult.transactionHash,
            blockNumber: Math.floor(Math.random() * 1000000),
            timestamp: Date.now(),
            amount: requirement.amount,
            asset: requirement.asset,
            confirmations: 12,
        };
    }
}
// Export signers
export { MockPaymentSigner, MockSignerFactory } from './mock-payment-signer.js';
export { LocalEoaPaymentSigner, createLocalEoaSignerFromEnv } from './local-eoa-signer.js';
export { PaymentSigningError, NonceAlreadyUsedError, SignerBindingError, InvalidAuthorizationError, SignatureUnknownError, PolicyNotValidatedError, } from '../core/payment-errors.js';
export { CryptoNonceGenerator, InMemoryNonceRegistry, } from '../core/nonce-generator.js';
// Phase 2.3: Real Facilitator Settlement
export { X402FacilitatorClient, MockX402FacilitatorClient, encodePaymentSignature, } from "./x402-facilitator-client.js";
// Phase 2.4: Post-Settlement Execution
export { HttpSellerExecutionAdapter, MockSellerExecutionAdapter, } from "./seller-execution-adapter.js";
//# sourceMappingURL=index.js.map