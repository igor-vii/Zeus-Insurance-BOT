/**
 * Zeus Secretariat V0 - Production PostgreSQL Evidence Store
 * P0-1: Atomic SUBMITTING before network call
 * P0-2: Atomic job claiming via SQL UPDATE...RETURNING
 * P0-3: All evidence durable in PostgreSQL
 * P0-5: Full DurableEvidenceStore implementation
 * P0-6: Batch reconciliation with correct state column
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DurableEvidenceStore, DurablePaymentIntent, SettlementState, EvidenceRecord, Operation, OperationStatus, NonceRecord, ReconciliationObservation, SettledEvidenceBundle, NotSettledEvidenceBundle } from "zeus-secretariat";
export declare class PostgresEvidenceStore implements DurableEvidenceStore {
    private readonly db;
    /**
     * @param db - Drizzle database instance. Pass the shared @workspace/db instance
     *             to ensure single connection pool across all consumers.
     */
    constructor(db: NodePgDatabase);
    createPaymentIntent(intent: DurablePaymentIntent): Promise<void>;
    transitionToSubmitting(paymentIntentId: string): Promise<boolean>;
    recordSubmissionResult(paymentIntentId: string, newState: SettlementState, txHash?: string, httpStatus?: number, responseBody?: unknown): Promise<boolean>;
    compareAndSetState(intentId: string, expectedState: SettlementState, newState: SettlementState, extra?: Partial<DurablePaymentIntent>): Promise<boolean>;
    canCreateNewPayment(operationId: string): Promise<boolean>;
    /**
     * P1-9: Atomic evidence append.
     * Uses PostgreSQL JSONB concatenation to avoid read-modify-write race condition.
     * Two concurrent appends will both survive (no lost updates).
     */
    append(record: EvidenceRecord): Promise<void>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
    appendReconciliationObservation(obs: ReconciliationObservation): Promise<void>;
    getReconciliationObservations(id: string): Promise<ReconciliationObservation[]>;
    saveSettledEvidenceBundle(id: string, bundle: SettledEvidenceBundle): Promise<void>;
    saveNotSettledEvidenceBundle(id: string, bundle: NotSettledEvidenceBundle): Promise<void>;
    getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null>;
    getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null>;
    getPaymentIntentByRequestId(requestId: string): Promise<DurablePaymentIntent | null>;
    updatePaymentIntentAuthorization(id: string, fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">): Promise<void>;
    updatePaymentIntentStatus(id: string, status: SettlementState, extra?: any): Promise<void>;
    getNonTerminalIntents(): Promise<DurablePaymentIntent[]>;
    reserveNonce(nonce: string, operationId: string, payer: string): Promise<void>;
    getNonce(nonce: string): Promise<NonceRecord | null>;
    markNonceSigned(n: string): Promise<void>;
    markNonceSubmitted(n: string): Promise<void>;
    markNonceSettled(n: string): Promise<void>;
    createIntentWithNonce(intent: DurablePaymentIntent, payer: string): Promise<void>;
    getOperation(opId: string): Promise<Operation | null>;
    saveOperation(op: Operation): Promise<void>;
    getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null>;
    getOperationByRequestId(requestId: string): Promise<Operation | null>;
    getOperationsByStatus(status: OperationStatus): Promise<Operation[]>;
    claimReconciliationJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean>;
    createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string>;
    getDueReconciliationJobs(): Promise<Array<{
        jobId: string;
        paymentIntentId: string;
        probeCount: number;
    }>>;
    completePendingReconciliationJob(jobId: string): Promise<boolean>;
    updateReconciliationJob(jobId: string, updates: {
        status?: string;
        nextProbeAt?: Date;
        lastError?: string;
        probeCount?: number;
    }): Promise<void>;
    completeReconciliationJob(jobId: string, workerId: string): Promise<boolean>;
    rescheduleReconciliationJob(jobId: string, workerId: string, nextProbeAt: Date): Promise<boolean>;
    failReconciliationJob(jobId: string, workerId: string, error: string): Promise<boolean>;
    updatePaymentIntentProbeCount(paymentIntentId: string, probeCount: number): Promise<void>;
    private rowToIntent;
}
//# sourceMappingURL=postgres-store.d.ts.map