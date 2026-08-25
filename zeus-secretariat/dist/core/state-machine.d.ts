/**
 * Zeus Secretariat V0 - State Machine Implementation
 *
 * Core invariant: After payment is submitted, we CANNOT blindly retry.
 * We must first determine settlement status before any recovery action.
 */
import { Operation, EvidenceRecord, ExecuteRequest, ExecutionResult, EvidenceStore, PaymentSigner, PaymentAdapter } from './types';
export interface SecretariatConfig {
    evidenceStore: EvidenceStore;
    signer: PaymentSigner;
    adapters: Map<string, PaymentAdapter>;
}
export declare class Secretariat {
    private readonly config;
    constructor(config: SecretariatConfig);
    execute(request: ExecuteRequest): Promise<ExecutionResult>;
    private createOperation;
    private discoveryPhase;
    private handlePaymentRequired;
    private handleDirectSuccess;
    private validatePolicy;
    private authorizePayment;
    private submitPayment;
    private observeSettlement;
    private observeExecution;
    private handleRecovery;
    private recoverViaResultRetrieval;
    private recoverViaIdempotentRetry;
    private recoverViaSignedReceipt;
    private deliver;
    private failOperation;
    private transitionState;
    private recordEvidence;
    private persistOperation;
    private buildResult;
    private mapToFinalStatus;
    private getAdapterForNetwork;
    private parsePaymentRequirement;
    private discoverSellerCapabilities;
    private getPaymentRequirementFromEvidence;
    private getAuthorizationFromEvidence;
    private getSubmissionResultFromEvidence;
    getOperation(operationId: string): Promise<Operation | null>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
}
//# sourceMappingURL=state-machine.d.ts.map