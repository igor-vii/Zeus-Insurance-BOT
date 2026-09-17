/**
 * Zeus Secretariat V0 - Payment Adapters
 *
 * Adapters are network-specific implementations.
 * Core does not know about Solana, Base, X Layer, etc.
 * Adapter knows the specific network.
 */
export interface MockPaymentAdapterConfig {
    network: string;
    simulateSettlement?: boolean;
    settlementDelay?: number;
    failProbability?: number;
}
export declare class MockPaymentAdapter {
    readonly network: string;
    private readonly simulateSettlement;
    private readonly settlementDelay;
    private readonly failProbability;
    constructor(config: MockPaymentAdapterConfig);
    createAuthorization(requirement: any, signer: any, context: any): Promise<any>;
    submit(requirement: any, authorization: any): Promise<any>;
    observeSettlement(requirement: any, submissionResult: any): Promise<any>;
}
export { MockPaymentSigner, MockSignerFactory } from './mock-payment-signer.js';
export { LocalEoaPaymentSigner, createLocalEoaSignerFromEnv } from './local-eoa-signer.js';
export type { PaymentSigner } from '../core/payment-signer.js';
export type { PaymentAuthorizationRequest, PaymentSignatureResult, SignedPaymentAuthorization, PaymentAuthorizationState, NonceGenerator, NonceRegistry, } from '../core/payment-types.js';
export { PaymentSigningError, NonceAlreadyUsedError, SignerBindingError, InvalidAuthorizationError, SignatureUnknownError, PolicyNotValidatedError, } from '../core/payment-errors.js';
export { CryptoNonceGenerator, InMemoryNonceRegistry, } from '../core/nonce-generator.js';
export { X402FacilitatorClient, MockX402FacilitatorClient, type FacilitatorConfig, type PaymentPayload, encodePaymentSignature, type SubmitResult, type SettlementAdapter, type MockFacilitatorBehavior, } from "./x402-facilitator-client.js";
export { HttpSellerExecutionAdapter, MockSellerExecutionAdapter, type SellerExecutionAdapter, type SellerExecutionRequest, type SellerExecutionResult, type MockSellerBehavior, } from "./seller-execution-adapter.js";
//# sourceMappingURL=index.d.ts.map