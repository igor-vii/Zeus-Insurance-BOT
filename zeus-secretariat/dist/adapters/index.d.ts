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
//# sourceMappingURL=index.d.ts.map