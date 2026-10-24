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
export declare class MockSettlementAdapter {
    private store?;
    readonly network: string;
    failProbability: number;
    private counter;
    readonly submissions: Array<{
        intent: any;
        payload: any;
        txHash: string;
    }>;
    /**
     * @param store optional durable store — when provided, submit() persists
     *   SETTLEMENT_PENDING + txHash and marks the nonce SUBMITTED, mirroring
     *   X402FacilitatorClient behavior (the reconciliation engine needs the
     *   durable txHash to take the txHash-first path).
     */
    constructor(store?: any | undefined, network?: string);
    submit(intent: any, payload: any): Promise<{
        status: string;
        txHash?: string;
        reason?: string;
        rawResponse?: unknown;
    }>;
    /** Deterministic settled receipt for a recorded submission (§7/§8 shapes). */
    buildSettledReceipt(txHash: string): {
        confirmed: boolean;
        status: "success";
        blockNumber: number;
        confirmations: number;
        logs: {
            address: any;
            topics: string[];
            data: string;
            logIndex: number;
        }[];
    } | null;
}
export type { PaymentSigner } from '../core/payment-signer.js';
export type { PaymentAuthorizationRequest, PaymentSignatureResult, SignedPaymentAuthorization, PaymentAuthorizationState, NonceGenerator, NonceRegistry, } from '../core/payment-types.js';
export { PaymentSigningError, NonceAlreadyUsedError, SignerBindingError, InvalidAuthorizationError, SignatureUnknownError, PolicyNotValidatedError, } from '../core/payment-errors.js';
export { CryptoNonceGenerator, InMemoryNonceRegistry, } from '../core/nonce-generator.js';
export { X402FacilitatorClient, MockX402FacilitatorClient, type FacilitatorConfig, type PaymentPayload, encodePaymentSignature, type SubmitResult, type SettlementAdapter, type MockFacilitatorBehavior, } from "./x402-facilitator-client.js";
export { HttpSellerExecutionAdapter, MockSellerExecutionAdapter, type SellerExecutionAdapter, type SellerExecutionRequest, type SellerExecutionResult, type MockSellerBehavior, } from "./seller-execution-adapter.js";
//# sourceMappingURL=index.d.ts.map