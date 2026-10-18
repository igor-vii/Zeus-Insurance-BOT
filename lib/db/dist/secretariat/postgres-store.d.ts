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
     * Repair C3: stable, record-derived logical identity.
     *
     * Identity = operationId | sequence | phase | event | timestamp | payload-hash.
     *  - Stable across retries and process restarts: every component is taken
     *    from the immutable EvidenceRecord itself (sequence is assigned once at
     *    recordEvidence() time), never from Date.now() or randomness.
     *  - Distinct legitimate records never collide: each new record gets a new
     *    per-operation sequence; legacy records without a sequence fall back to
     *    (phase|event|timestamp|payload-hash), which distinguishes same-event
     *    occurrences by timestamp/payload while keeping an identical replay of
     *    one record idempotent.
     */
    static evidenceIdentity(record: EvidenceRecord): string;
    /**
     * Repair C3: durable, idempotent, atomic evidence append.
     *
     * Guarantees:
     *  1. PRE-INTENT SAFE — evidence recorded before a payment intent exists is
     *     stored durably in reconciliation_observations with payment_intent_id =
     *     NULL (migration 0009 relaxes the FK column). It is never discarded.
     *  2. ATOMIC — when an intent exists, the observation insert AND the
     *     payment_intents.reconciliation_observations JSONB update happen inside
     *     ONE transaction. A failure between them rolls back both; no partial
     *     committed state is possible.
     *  3. IDEMPOTENT — insertion uses ON CONFLICT (observation_id) DO NOTHING on
     *     the stable record-derived identity, and the JSONB append is guarded by
     *     a containment predicate. Re-appending the same logical record after an
     *     ambiguous write creates NO duplicate rows and NO duplicate JSONB entry.
     *  4. DISTINCT RECORDS PRESERVED — different records have different
     *     identities (sequence differs), so they are never deduplicated away.
     */
    append(record: EvidenceRecord): Promise<void>;
    /**
     * Repair C3: chronological retrieval merging BOTH representations:
     *  - intent-side JSONB history (authoritative full record payloads), and
     *  - reconciliation_observations evidence-log rows (covers pre-intent
     *    evidence and operations whose intent lacks JSONB entries).
     * Deduped by stable identity; ordered by sequence (legacy fallback:
     * timestamp), producing deterministic chronological order that preserves
     * pre-intent evidence ahead of intent-side evidence.
     */
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
    /**
     * A1-persistence: durable Operation save (fixes A1 Finding #3).
     *
     * Persists what CAN be persisted on existing columns:
     *   1. request semantics (target/method/paymentPolicy) on payment_intents
     *      (existing Repair C1 behavior, preserved).
     *   2. the LAST evidence record (typically the newest STATE_TRANSITION) is
     *      appended to reconciliation_observations via the existing atomic JSONB
     *      append pattern — this makes currentState reconstructible after restart.
     *
     * Explicitly does NOT update non-existent columns (execution_state,
     * delivery_state, current_state) and does NOT add columns/tables.
     */
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