/**
 * Zeus Secretariat V0 - In-Memory Evidence Store (MVP Implementation)
 *
 * For production, replace with PostgreSQL/SQLite implementation.
 * This is a minimal implementation for testing and development.
 */
import { EvidenceStore, EvidenceRecord, Operation, OperationStatus, DurablePaymentIntent, SettlementState, NonceRecord } from '../core/types.js';
export declare class InMemoryEvidenceStore implements EvidenceStore {
    private readonly operations;
    private readonly evidence;
    private readonly intents;
    private readonly nonces;
    private findIntentByOperationId;
    createPaymentIntent(intent: DurablePaymentIntent): Promise<void>;
    getPaymentIntentByOperationId(operationId: string): Promise<DurablePaymentIntent | null>;
    getPaymentIntentByRequestId(requestId: string): Promise<DurablePaymentIntent | null>;
    /** R0 repair: required by ReconciliationEngine.getIntentById(). */
    getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null>;
    updatePaymentIntentAuthorization(paymentIntentId: string, fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">): Promise<void>;
    updatePaymentIntentStatus(paymentIntentId: string, status: SettlementState, extra?: Partial<Pick<DurablePaymentIntent, "txHash" | "facilitatorHttpStatus" | "facilitatorResponseBody" | "errorReason">>): Promise<void>;
    compareAndSetState(paymentIntentId: string, expectedState: SettlementState, newState: SettlementState): Promise<boolean>;
    reserveNonce(nonce: string, operationId: string, payer: string): Promise<void>;
    getNonce(nonce: string): Promise<NonceRecord | null>;
    markNonceSigned(nonce: string): Promise<void>;
    markNonceSubmitted(nonce: string): Promise<void>;
    markNonceSettled(nonce: string): Promise<void>;
    createIntentWithNonce(intent: DurablePaymentIntent, payer: string): Promise<void>;
    saveSettledEvidenceBundle(paymentIntentId: string, bundle: unknown): Promise<void>;
    saveNotSettledEvidenceBundle(paymentIntentId: string, bundle: unknown): Promise<void>;
    getSettledBundle(paymentIntentId: string): unknown;
    private readonly reconObservations;
    appendReconciliationObservation(obs: any): Promise<void>;
    getReconciliationObservations(paymentIntentId: string): Promise<any[]>;
    private readonly reconJobs;
    createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string>;
    /** R0 repair: scanner for PostSettlementEngine.ensureExecutionObligations().
     *  Returns SETTLED intents; the engine filters out ones that already have
     *  execution attempts (the in-memory store cannot see the execution store). */
    getSettledIntentsWithoutObligation(limit?: number): Promise<DurablePaymentIntent[]>;
    append(record: EvidenceRecord): Promise<void>;
    getOperation(operationId: string): Promise<Operation | null>;
    getOperationByRequestId(requestId: string): Promise<Operation | null>;
    saveOperation(operation: Operation): Promise<void>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
    getOperationsByStatus(status: OperationStatus): Promise<Operation[]>;
    /**
     * Clear all data - useful for testing
     */
    clear(): void;
    /**
     * Get all operations - useful for debugging
     */
    getAllOperations(): Operation[];
}
//# sourceMappingURL=in-memory-store.d.ts.map