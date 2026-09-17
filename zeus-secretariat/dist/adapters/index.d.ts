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
export { MockPaymentSigner, MockSignerFactory } from './mock-payment-signer';
export { LocalEoaPaymentSigner, createLocalEoaSignerFromEnv } from './local-eoa-signer';
export type { PaymentSigner } from '../core/payment-signer';
export type { PaymentAuthorizationRequest, PaymentSignatureResult, SignedPaymentAuthorization, PaymentAuthorizationState, NonceGenerator, NonceRegistry, } from '../core/payment-types';
export { PaymentSigningError, NonceAlreadyUsedError, SignerBindingError, InvalidAuthorizationError, SignatureUnknownError, PolicyNotValidatedError, } from '../core/payment-errors';
export { CryptoNonceGenerator, InMemoryNonceRegistry, } from '../core/nonce-generator';
export { X402FacilitatorClient, MockX402FacilitatorClient, type FacilitatorConfig, type PaymentPayload, encodePaymentSignature, type SubmitResult, type SettlementAdapter, type MockFacilitatorBehavior, } from "./x402-facilitator-client";
export { HttpSellerExecutionAdapter, MockSellerExecutionAdapter, type SellerExecutionAdapter, type SellerExecutionRequest, type SellerExecutionResult, type MockSellerBehavior, } from "./seller-execution-adapter";
//# sourceMappingURL=index.d.ts.map