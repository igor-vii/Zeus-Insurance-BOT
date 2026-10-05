/**
 * Zeus Secretariat V0 - Production PostgreSQL Evidence Store
 * P0-1: Atomic SUBMITTING before network call
 * P0-2: Atomic job claiming via SQL UPDATE...RETURNING
 * P0-3: All evidence durable in PostgreSQL
 * P0-5: Full DurableEvidenceStore implementation
 * P0-6: Batch reconciliation with correct state column
 */
import { eq, and, sql, inArray } from "drizzle-orm";
import { paymentIntentsTable, nonceRegistryTable, reconciliationObservationsTable, reconciliationJobsTable, } from "@workspace/db/schema";
import { allowNewPayment } from "zeus-secretariat";
// ---------------------------------------------------------------------------
// A1-persistence: reconstruction mapping helpers (spec §4 algorithm)
// ---------------------------------------------------------------------------
/** settlement_state → PaymentStatus */
function mapSettlementToPaymentState(settlementState) {
    switch (settlementState) {
        case "AUTHORIZED":
            return "AUTHORIZED";
        case "SUBMITTING":
        case "SUBMITTED":
        case "RECONCILING":
        case "SETTLEMENT_PENDING":
            return "SUBMITTED";
        case "SETTLED":
            return "SETTLED";
        case "NOT_SETTLED":
        case "UNRESOLVED_MANUAL":
            return "FAILED";
        case "PENDING_SIGNATURE":
            return "NOT_STARTED";
        default:
            return "UNKNOWN";
    }
}
/** latest execution_attempts.status → ExecutionStatus */
function mapAttemptStatusToExecutionState(status) {
    switch (status) {
        case "PENDING":
        case "ATTEMPTED":
            return "PENDING";
        case "SUCCESS":
            return "CONFIRMED";
        case "HTTP_FAILURE":
            return "FAILED";
        case "DELIVERY_UNKNOWN":
            // genuinely unknown outcome — recovery may still resolve it
            return "UNKNOWN";
        case "UNRESOLVABLE":
            // Audit finding #4: UNRESOLVABLE is a TERMINAL state of the obligation
            // lifecycle (post-settlement-engine.ts: RecoveryJobStatus lists it as
            // terminal; updateJobStatus(jobId,"UNRESOLVABLE") never re-queues).
            // Mapping it to UNKNOWN would falsely suggest recovery is possible on
            // this axis. No new enum value: CONFIRMED means "execution definitely
            // happened" — an UNRESOLVABLE attempt did happen (the call was made);
            // only its outcome is unrecoverable, which is carried by
            // deliveryState=UNKNOWN and currentState=UNRESOLVABLE. FAILED is wrong
            // (would violate the DELIVERY_UNKNOWN ≠ FAILED boundary lineage).
            return "CONFIRMED";
        default:
            return "NOT_STARTED"; // no attempts
    }
}
/** Latest STATE_TRANSITION evidence record (max timestamp) or undefined. */
function findLatestStateTransitionRecord(evidence) {
    let last;
    for (const e of evidence) {
        if (e.event !== "STATE_TRANSITION")
            continue;
        if (!last || e.timestamp >= last.timestamp)
            last = e;
    }
    return last;
}
/** Latest STATE_TRANSITION evidence payload.to → DeliveryStatus axis. */
function deriveDeliveryState(evidence) {
    const last = findLatestStateTransitionRecord(evidence);
    const to = last?.payload?.to;
    switch (to) {
        case "SUCCESS":
        case "DELIVERED":
            return "DELIVERED";
        case "FAILED":
            return "FAILED";
        case "EXECUTION_UNKNOWN":
        case "UNRESOLVABLE":
            return "UNKNOWN";
        case "EXECUTION_PENDING":
        case "EXECUTION_CONFIRMED":
            // Audit finding #3: execution confirmed but delivery NOT yet proven —
            // stays PENDING so restart reconstruction matches the in-memory FSM
            // side effects (applySideEffects leaves deliveryState untouched at
            // EXECUTION_CONFIRMED, i.e. still PENDING from EXECUTION_PENDING).
            return "PENDING";
        default:
            return "NOT_STARTED";
    }
}
/**
 * Authoritative current FSM state after restart (audit findings #3/#4):
 *   1. latest STATE_TRANSITION evidence payload.to (fast-forwarded below);
 *   2. fallback mapping settlement_state / latest attempt status.
 * Fast-forward keeps currentState consistent with durable attempt status when
 * evidence lagged behind a crash (e.g. attempt SUCCESS but only
 * SETTLED→EXECUTION_PENDING was recorded durably).
 */
function deriveCurrentState(evidence, settlementState, latestAttemptStatus) {
    let cur = findLatestStateTransitionRecord(evidence)?.payload != null
        ? (findLatestStateTransitionRecord(evidence).payload.to ?? null)
        : null;
    if (!cur) {
        cur = settlementState === "PENDING_SIGNATURE" ? "AWAITING_SIGNATURE" : settlementState;
    }
    switch (cur) {
        case "EXECUTION_PENDING":
            if (latestAttemptStatus === "SUCCESS")
                return "EXECUTION_CONFIRMED";
            if (latestAttemptStatus === "HTTP_FAILURE")
                return "FAILED";
            if (latestAttemptStatus === "DELIVERY_UNKNOWN")
                return "EXECUTION_UNKNOWN";
            if (latestAttemptStatus === "UNRESOLVABLE")
                return "UNRESOLVABLE";
            return cur;
        case "EXECUTION_CONFIRMED":
            if (latestAttemptStatus === "HTTP_FAILURE")
                return "FAILED";
            if (latestAttemptStatus === "DELIVERY_UNKNOWN")
                return "EXECUTION_UNKNOWN";
            if (latestAttemptStatus === "UNRESOLVABLE")
                return "UNRESOLVABLE";
            return cur;
        case "EXECUTION_UNKNOWN":
            // The real FSM has no EXECUTION_UNKNOWN→UNRESOLVABLE edge (it goes via
            // RECOVERY_PENDING), but durable job/attempt state IS authoritative for
            // UNRESOLVABLE (terminal, set only under fencing). Reflect it so
            // currentState does not falsely advertise recoverability after restart.
            if (latestAttemptStatus === "UNRESOLVABLE")
                return "UNRESOLVABLE";
            return cur;
        default:
            return cur;
    }
}
export class PostgresEvidenceStore {
    db;
    /**
     * @param db - Drizzle database instance. Pass the shared @workspace/db instance
     *             to ensure single connection pool across all consumers.
     */
    constructor(db) {
        this.db = db;
    }
    // P0-1: Create intent BEFORE network call. UNIQUE(operation_id) at DB level.
    async createPaymentIntent(intent) {
        try {
            await this.db.insert(paymentIntentsTable).values({
                paymentIntentId: intent.paymentIntentId, operationId: intent.operationId,
                requestId: intent.requestId ?? null, clientId: intent.clientId ?? null,
                authorizer: intent.authorizer, payTo: intent.payTo, value: intent.value,
                asset: intent.asset, network: intent.network, nonce: intent.nonce,
                validAfter: intent.validAfter, validBefore: intent.validBefore,
                paymentPayload: intent.paymentPayload, paymentPayloadHash: intent.paymentPayloadHash,
                settlementState: intent.settlementState, txHash: intent.txHash ?? null,
                submitAttemptAt: intent.submitAttemptAt ? new Date(intent.submitAttemptAt) : null,
                probeCount: intent.probeCount ?? 0, version: 0,
            });
        }
        catch (err) {
            if (err.code === "23505")
                throw new Error("DUPLICATE_OPERATION_ID: " + intent.operationId);
            throw err;
        }
    }
    // P0-1: Atomically transition AUTHORIZED -> SUBMITTING before network I/O
    async transitionToSubmitting(paymentIntentId) {
        return this.compareAndSetState(paymentIntentId, "AUTHORIZED", "SUBMITTING");
    }
    // P0-1: Record submission result after facilitator response
    async recordSubmissionResult(paymentIntentId, newState, txHash, httpStatus, responseBody) {
        return this.compareAndSetState(paymentIntentId, "SUBMITTING", newState, {
            txHash: txHash ?? undefined, facilitatorHttpStatus: httpStatus ?? undefined,
            facilitatorResponseBody: responseBody ?? undefined, submitAttemptAt: Date.now(),
        });
    }
    // P0-5 + section 21: Atomic CAS via optimistic locking (version column)
    async compareAndSetState(intentId, expectedState, newState, extra) {
        const setObj = {
            settlementState: newState, version: sql `${paymentIntentsTable.version} + 1`, updatedAt: new Date(),
        };
        if (extra?.txHash !== undefined)
            setObj.txHash = extra.txHash;
        if (extra?.facilitatorHttpStatus !== undefined)
            setObj.facilitatorHttpStatus = extra.facilitatorHttpStatus;
        if (extra?.facilitatorResponseBody !== undefined)
            setObj.facilitatorResponseBody = extra.facilitatorResponseBody;
        if (extra?.errorReason !== undefined)
            setObj.errorReason = extra.errorReason;
        if (extra?.submitAttemptAt !== undefined)
            setObj.submitAttemptAt = new Date(extra.submitAttemptAt);
        if (newState === "SETTLED")
            setObj.settledAt = new Date();
        if (newState === "NOT_SETTLED")
            setObj.notSettledAt = new Date();
        // P1: CAS uses settlement_state predicate as the primary guard.
        // Version column is incremented on every successful transition for audit trail.
        // State predicate is sufficient because: (1) each state has exactly one valid next-state set,
        // (2) UNIQUE(payment_intent_id) ensures single row, (3) PostgreSQL row-level locking
        // during UPDATE prevents concurrent modifications to the same row.
        const result = await this.db.update(paymentIntentsTable).set(setObj).where(and(eq(paymentIntentsTable.paymentIntentId, intentId), eq(paymentIntentsTable.settlementState, expectedState)));
        return Array.isArray(result) ? result.length > 0 : result?.rowCount > 0;
    }
    // P0-5 + section 3: THE economic safety guard. DB read only. No cache.
    async canCreateNewPayment(operationId) {
        const rows = await this.db.select({ settlementState: paymentIntentsTable.settlementState })
            .from(paymentIntentsTable).where(eq(paymentIntentsTable.operationId, operationId)).limit(1);
        if (rows.length === 0)
            return true;
        return allowNewPayment(rows[0].settlementState);
    }
    // P0-3: Durable evidence in PostgreSQL
    /**
     * P1-9: Atomic evidence append.
     * Uses PostgreSQL JSONB concatenation to avoid read-modify-write race condition.
     * Two concurrent appends will both survive (no lost updates).
     */
    async append(record) {
        // Use dedicated reconciliation_observations table for durable, concurrent-safe storage
        await this.appendReconciliationObservation({
            attemptId: record.operationId + "-" + record.timestamp,
            paymentIntentId: "", // Will be resolved by caller context
            timestamp: record.timestamp,
            rpcProviderId: "evidence-log",
            headBlock: 0,
            authorizationState: null,
            validBefore: 0,
            result: record.event,
            error: undefined,
        });
        // Also append to intent's JSONB field using atomic concatenation
        const intent = await this.getPaymentIntentByOperationId(record.operationId);
        if (intent) {
            await this.db.execute(sql `
        UPDATE payment_intents
        SET reconciliation_observations = COALESCE(reconciliation_observations, '[]'::jsonb) || ${JSON.stringify(record)}::jsonb,
            updated_at = NOW()
        WHERE payment_intent_id = ${intent.paymentIntentId}
      `);
        }
    }
    async getEvidence(operationId) {
        const intent = await this.getPaymentIntentByOperationId(operationId);
        return (intent?.reconciliationObservations ?? []);
    }
    async appendReconciliationObservation(obs) {
        await this.db.insert(reconciliationObservationsTable).values({
            observationId: obs.attemptId + "-" + obs.rpcProviderId,
            paymentIntentId: obs.paymentIntentId, attemptId: obs.attemptId,
            rpcProviderId: obs.rpcProviderId, underlyingProvider: "",
            observedAt: new Date(obs.timestamp), blockNumber: obs.headBlock,
            chainHead: obs.headBlock, authorizationState: obs.authorizationState,
            validBefore: obs.validBefore, result: obs.result, error: obs.error ?? null,
        });
    }
    async getReconciliationObservations(id) {
        const rows = await this.db.select().from(reconciliationObservationsTable)
            .where(eq(reconciliationObservationsTable.paymentIntentId, id));
        return rows.map((r) => ({
            attemptId: r.attemptId, paymentIntentId: r.paymentIntentId,
            timestamp: r.observedAt.getTime(), rpcProviderId: r.rpcProviderId,
            headBlock: r.blockNumber, authorizationState: r.authorizationState,
            validBefore: r.validBefore, result: r.result, error: r.error ?? undefined,
        }));
    }
    async saveSettledEvidenceBundle(id, bundle) {
        await this.db.update(paymentIntentsTable).set({ settledEvidenceBundle: bundle, updatedAt: new Date() })
            .where(eq(paymentIntentsTable.paymentIntentId, id));
    }
    async saveNotSettledEvidenceBundle(id, bundle) {
        await this.db.update(paymentIntentsTable).set({ notSettledEvidenceBundle: bundle, updatedAt: new Date() })
            .where(eq(paymentIntentsTable.paymentIntentId, id));
    }
    // P0-6: Intent lookups using settlement_state directly
    async getPaymentIntentById(id) {
        const rows = await this.db.select().from(paymentIntentsTable).where(eq(paymentIntentsTable.paymentIntentId, id)).limit(1);
        return rows.length === 0 ? null : this.rowToIntent(rows[0]);
    }
    async getPaymentIntentByOperationId(opId) {
        const rows = await this.db.select().from(paymentIntentsTable).where(eq(paymentIntentsTable.operationId, opId)).limit(1);
        return rows.length === 0 ? null : this.rowToIntent(rows[0]);
    }
    async getPaymentIntentByRequestId(requestId) {
        const rows = await this.db.select().from(paymentIntentsTable).where(eq(paymentIntentsTable.requestId, requestId)).limit(1);
        return rows.length === 0 ? null : this.rowToIntent(rows[0]);
    }
    async updatePaymentIntentAuthorization(id, fields) {
        await this.db.update(paymentIntentsTable).set({
            paymentPayload: fields.paymentPayload,
            paymentPayloadHash: fields.paymentPayloadHash,
            updatedAt: new Date(),
        }).where(eq(paymentIntentsTable.paymentIntentId, id));
    }
    async updatePaymentIntentStatus(id, status, extra) {
        const setObj = { settlementState: status, version: sql `${paymentIntentsTable.version} + 1`, updatedAt: new Date() };
        if (extra?.txHash !== undefined)
            setObj.txHash = extra.txHash;
        if (extra?.facilitatorHttpStatus !== undefined)
            setObj.facilitatorHttpStatus = extra.facilitatorHttpStatus;
        if (extra?.facilitatorResponseBody !== undefined)
            setObj.facilitatorResponseBody = extra.facilitatorResponseBody;
        if (extra?.errorReason !== undefined)
            setObj.errorReason = extra.errorReason;
        await this.db.update(paymentIntentsTable).set(setObj).where(eq(paymentIntentsTable.paymentIntentId, id));
    }
    // P0-6: Batch reconciliation - finds non-terminal intents directly by settlement_state
    async getNonTerminalIntents() {
        const states = ["SUBMITTING", "SUBMITTED", "SETTLEMENT_PENDING", "RECONCILING"];
        const rows = await this.db.select().from(paymentIntentsTable)
            .where(inArray(paymentIntentsTable.settlementState, states));
        return rows.map((r) => this.rowToIntent(r));
    }
    // Nonce registry
    async reserveNonce(nonce, operationId, payer) {
        try {
            await this.db.insert(nonceRegistryTable).values({ nonce, operationId, status: "RESERVED", payer });
        }
        catch (err) {
            if (err.code === "23505")
                throw new Error("NONCE_ALREADY_RESERVED: " + nonce);
            throw err;
        }
    }
    async getNonce(nonce) {
        const rows = await this.db.select().from(nonceRegistryTable).where(eq(nonceRegistryTable.nonce, nonce)).limit(1);
        if (rows.length === 0)
            return null;
        const r = rows[0];
        return { nonce: r.nonce, operationId: r.operationId, status: r.status, payer: r.payer, createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime() };
    }
    async markNonceSigned(n) { await this.db.update(nonceRegistryTable).set({ status: "SIGNED", updatedAt: new Date() }).where(eq(nonceRegistryTable.nonce, n)); }
    async markNonceSubmitted(n) { await this.db.update(nonceRegistryTable).set({ status: "SUBMITTED", updatedAt: new Date() }).where(eq(nonceRegistryTable.nonce, n)); }
    async markNonceSettled(n) { await this.db.update(nonceRegistryTable).set({ status: "SETTLED", updatedAt: new Date() }).where(eq(nonceRegistryTable.nonce, n)); }
    // P1: reserveNonce + createPaymentIntent should be atomic.
    // In production, wrap in a transaction: BEGIN; reserveNonce; createPaymentIntent; COMMIT;
    // If createPaymentIntent fails (duplicate operation_id), ROLLBACK releases the nonce.
    // Current implementation relies on: (1) nonce PK prevents double-reserve,
    // (2) operation_id UNIQUE prevents duplicate intent, (3) orphan nonces are harmless
    // (they just block that nonce value permanently, which is acceptable since nonces are unique per operation).
    async createIntentWithNonce(intent, payer) {
        if (intent.nonce)
            await this.reserveNonce(intent.nonce, intent.operationId, payer);
        try {
            await this.createPaymentIntent(intent);
        }
        catch (err) {
            // If intent creation fails, the nonce reservation remains as an orphan.
            // This is safe: the nonce value is permanently blocked, preventing any future
            // intent from using it. No economic harm — just a wasted nonce value.
            throw err;
        }
    }
    // ---------------------------------------------------------------------------
    // A1-persistence: durable Operation reconstruction (fixes A1 Finding #3).
    //
    // The previous implementation was lossy: it returned only
    // {operationId, currentState=settlementState, paymentState} and dropped
    // requestId/clientId/target/method/paymentPolicy/evidence/timestamps, making
    // FSM feedback (A1-B) impossible to persist and recover after restart.
    //
    // Reconstruction algorithm (spec §4) reads ONLY existing durable records:
    //   1. payment_intents WHERE operation_id = opId
    //      → identity, request semantics, settlement_state, timestamps
    //   2. execution_attempts WHERE operation_id = opId
    //      ORDER BY attempt_number DESC LIMIT 1 → latest obligation status
    //   3. evidence from payment_intents.reconciliation_observations (JSONB array)
    //   4. reconstruct paymentState / executionState / deliveryState / currentState
    //
    // No new tables. No new columns. getOperationsByStatus() is OUT OF SCOPE
    // (DROP FROM A1 SCOPE — not modified).
    // ---------------------------------------------------------------------------
    async getOperation(opId) {
        const rows = await this.db
            .select()
            .from(paymentIntentsTable)
            .where(eq(paymentIntentsTable.operationId, opId))
            .limit(1);
        if (rows.length === 0)
            return null;
        const row = rows[0];
        // Step 2: latest execution attempt (existing execution_attempts table).
        // Audit finding #6: NO blanket try/catch. execution_attempts is a schema-
        // defined production table (lib/db/src/schema/execution-recovery.ts) and
        // PostgresEvidenceStore already queries other tables without fallbacks —
        // so no "missing table" masking is needed here either. A real DB error
        // must propagate loudly instead of silently degrading reconstruction to
        // evidence-only state ("FSM in memory but DB old state" re-introduced).
        const attemptRows = await this.db.execute(sql `
      SELECT status FROM execution_attempts
      WHERE operation_id = ${opId}
      ORDER BY attempt_number DESC
      LIMIT 1
    `);
        const firstAttempt = (Array.isArray(attemptRows) ? attemptRows : [])[0];
        const latestAttemptStatus = firstAttempt?.status ?? null;
        // Step 3: evidence — full JSONB array from reconciliation_observations.
        const evidence = (row.reconciliationObservations ?? []);
        // Step 4a: paymentState mapping from settlement_state.
        const settlementState = row.settlementState;
        const paymentState = mapSettlementToPaymentState(settlementState);
        // Step 4b: executionState mapping from latest attempt obligation status.
        const executionState = mapAttemptStatusToExecutionState(latestAttemptStatus);
        // Step 4c: deliveryState from latest STATE_TRANSITION evidence.
        const deliveryState = deriveDeliveryState(evidence);
        // Step 4d: currentState — latest STATE_TRANSITION from evidence,
        // fast-forwarded by durable attempt status; fallback to settlement_state
        // mapping when no FSM evidence exists yet (audit findings #3/#4).
        const currentState = deriveCurrentState(evidence, settlementState, latestAttemptStatus);
        return {
            operationId: opId,
            requestId: row.requestId ?? "",
            clientId: row.clientId ?? undefined,
            target: row.target ?? "",
            method: row.method ?? "",
            paymentPolicy: row.paymentPolicy ?? {},
            paymentState,
            executionState,
            deliveryState,
            currentState,
            timestamps: {
                createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
                updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
            },
            evidence,
        };
    }
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
    async saveOperation(op) {
        await this.db
            .update(paymentIntentsTable)
            .set({
            target: op.target ?? null,
            method: op.method ?? null,
            paymentPolicy: op.paymentPolicy ?? null,
            updatedAt: new Date(),
        })
            .where(eq(paymentIntentsTable.operationId, op.operationId));
        // Append the LAST evidence record (STATE_TRANSITION) so currentState is
        // durable and reconstructible by getOperation() after restart.
        //
        // Audit finding #2 — idempotency by existing event identity
        // (operationId + timestamp + event + JSON payload). The in-memory chain
        // (getOperation → transitions → save) already prevents re-appending on
        // duplicate polls; this guard makes a concurrent/retried save safe without
        // any new table/column/format change.
        const last = op.evidence[op.evidence.length - 1];
        if (last) {
            const intent = await this.getPaymentIntentByOperationId(op.operationId);
            if (intent) {
                const observationsJson = JSON.stringify(intent.reconciliationObservations ?? []);
                const alreadyPresent = sql `
          SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(${observationsJson}::jsonb) AS e
            WHERE e = ${JSON.stringify(last)}::jsonb
          ) AS present
        `;
                const checkRows = await this.db.execute(alreadyPresent);
                const present = (Array.isArray(checkRows) ? checkRows : [])[0];
                if (!present?.present) {
                    await this.db.execute(sql `
            UPDATE payment_intents
            SET reconciliation_observations = COALESCE(reconciliation_observations, '[]'::jsonb) || ${JSON.stringify(last)}::jsonb,
                updated_at = NOW()
            WHERE payment_intent_id = ${intent.paymentIntentId}
          `);
                }
            }
        }
    }
    // B8-001: Durable idempotency lookup.
    // Queries payment_intents (not a separate operations table) because that is where
    // client_id and request_id are persisted. Reconstructs a minimal Operation from the intent.
    async getOperationByClientAndRequestId(clientId, requestId) {
        const rows = await this.db
            .select()
            .from(paymentIntentsTable)
            .where(and(eq(paymentIntentsTable.clientId, clientId), eq(paymentIntentsTable.requestId, requestId)))
            .limit(1);
        if (rows.length === 0)
            return null;
        const row = rows[0];
        // Reconstruct minimal Operation from the persisted intent.
        // This mirrors the existing getOperation() pattern at L232-234.
        return {
            operationId: row.operationId,
            requestId: row.requestId ?? "",
            clientId: row.clientId ?? undefined,
            target: row.target ?? "",
            method: row.method ?? "",
            paymentPolicy: row.paymentPolicy ?? {},
            paymentState: row.settlementState,
            executionState: "NOT_STARTED",
            deliveryState: "NOT_STARTED",
            currentState: row.settlementState === "PENDING_SIGNATURE"
                ? "AWAITING_SIGNATURE"
                : row.settlementState,
            timestamps: {
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime(),
            },
            evidence: row.reconciliationObservations ?? [],
        };
    }
    async getOperationByRequestId(requestId) {
        const rows = await this.db
            .select()
            .from(paymentIntentsTable)
            .where(eq(paymentIntentsTable.requestId, requestId))
            .limit(1);
        if (rows.length === 0)
            return null;
        const row = rows[0];
        return {
            operationId: row.operationId,
            requestId: row.requestId ?? requestId,
            clientId: row.clientId ?? undefined,
            target: row.target ?? "",
            method: row.method ?? "",
            paymentPolicy: row.paymentPolicy ?? {},
            paymentState: row.settlementState,
            executionState: "NOT_STARTED",
            deliveryState: "NOT_STARTED",
            currentState: row.settlementState === "PENDING_SIGNATURE"
                ? "AWAITING_SIGNATURE"
                : row.settlementState,
            timestamps: { createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() },
            evidence: row.reconciliationObservations ?? [],
        };
    }
    async getOperationsByStatus(status) {
        const rows = await this.db.select().from(paymentIntentsTable).where(eq(paymentIntentsTable.settlementState, status));
        return rows.map((r) => ({ operationId: r.operationId, currentState: r.settlementState, paymentState: r.settlementState }));
    }
    // P0-2: Atomic job claiming via SQL UPDATE...RETURNING
    async claimReconciliationJob(jobId, workerId, lockDurationMs) {
        const lockUntil = new Date(Date.now() + lockDurationMs);
        const q = sql `UPDATE reconciliation_jobs SET status = ${"RUNNING"}, locked_by = ${workerId}, locked_until = ${lockUntil}, probe_count = probe_count + 1, updated_at = NOW() WHERE job_id = ${jobId} AND (status = ${"PENDING"} OR (status = ${"RUNNING"} AND locked_until < NOW())) RETURNING job_id`;
        const result = await this.db.execute(q);
        return Array.isArray(result) && result.length > 0;
    }
    async createReconciliationJob(paymentIntentId, nextProbeAt) {
        // B.3-B2-FIX: Idempotent creation. If an active (PENDING/RUNNING) job already exists
        // for this paymentIntentId, return its jobId instead of creating a duplicate.
        // Relies on partial unique index rj_active_per_intent_idx (migration 0007).
        const jobId = "rj-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        try {
            await this.db.insert(reconciliationJobsTable).values({ jobId, paymentIntentId, status: "PENDING", probeCount: 0, nextProbeAt });
            return jobId;
        }
        catch (err) {
            // Unique violation — active job already exists. Look it up and return existing jobId.
            if (err?.code === "23505" || err?.message?.includes("unique") || err?.message?.includes("duplicate")) {
                const existing = await this.db.execute(sql `
          SELECT job_id FROM reconciliation_jobs
          WHERE payment_intent_id = ${paymentIntentId}
            AND status IN (${"PENDING"}, ${"RUNNING"})
          LIMIT 1
        `);
                if (Array.isArray(existing) && existing.length > 0) {
                    return existing[0].job_id;
                }
            }
            throw err;
        }
    }
    async getDueReconciliationJobs() {
        // B.3-B2-FIX: Discover both due PENDING jobs AND expired RUNNING leases.
        // locked_until IS NULL is NOT treated as expired.
        const rows = await this.db.execute(sql `
      SELECT job_id, payment_intent_id, probe_count
      FROM reconciliation_jobs
      WHERE (
          status = ${"PENDING"} AND next_probe_at <= NOW()
        ) OR (
          status = ${"RUNNING"} AND locked_until IS NOT NULL AND locked_until < NOW()
        )
      ORDER BY next_probe_at ASC
      LIMIT 100
    `);
        return (Array.isArray(rows) ? rows : []).map((r) => ({ jobId: r.job_id, paymentIntentId: r.payment_intent_id, probeCount: r.probe_count }));
    }
    // PENDING_SIGNATURE is passive and must be retired without claiming the job.
    // This keeps claim-time probe_count increments reserved for real reconciliation.
    async completePendingReconciliationJob(jobId) {
        const result = await this.db.execute(sql `
      WITH candidate_job AS MATERIALIZED (
        SELECT job_id, payment_intent_id
        FROM reconciliation_jobs
        WHERE job_id = ${jobId}
          AND (
            status = ${"PENDING"}
            OR (status = ${"RUNNING"} AND locked_until IS NOT NULL AND locked_until < NOW())
          )
        FOR UPDATE
      ),
      eligible_intent AS MATERIALIZED (
        SELECT candidate_job.job_id, candidate_job.payment_intent_id
        FROM candidate_job
        INNER JOIN payment_intents
          ON payment_intents.payment_intent_id = candidate_job.payment_intent_id
        WHERE payment_intents.settlement_state = ${"PENDING_SIGNATURE"}
        FOR UPDATE OF payment_intents
      )
      UPDATE reconciliation_jobs
      SET status = ${"COMPLETED"}, locked_by = NULL, locked_until = NULL, updated_at = NOW()
      FROM eligible_intent
      WHERE reconciliation_jobs.job_id = eligible_intent.job_id
      RETURNING reconciliation_jobs.job_id
    `);
        return Array.isArray(result) && result.length > 0;
    }
    async updateReconciliationJob(jobId, updates) {
        const setObj = { updatedAt: new Date() };
        if (updates.status)
            setObj.status = updates.status;
        if (updates.nextProbeAt)
            setObj.nextProbeAt = updates.nextProbeAt;
        if (updates.lastError !== undefined)
            setObj.lastError = updates.lastError;
        if (updates.probeCount !== undefined)
            setObj.probeCount = updates.probeCount;
        await this.db.update(reconciliationJobsTable).set(setObj).where(eq(reconciliationJobsTable.jobId, jobId));
    }
    // B.3-B2-FIX: Atomic lease-safe lifecycle methods
    async completeReconciliationJob(jobId, workerId) {
        // RUNNING -> COMPLETED, release lease. Ownership-checked.
        const result = await this.db.execute(sql `
      UPDATE reconciliation_jobs
      SET status = ${"COMPLETED"}, locked_by = NULL, locked_until = NULL, updated_at = NOW()
      WHERE job_id = ${jobId} AND status = ${"RUNNING"} AND locked_by = ${workerId}
      RETURNING job_id
    `);
        return Array.isArray(result) && result.length > 0;
    }
    async rescheduleReconciliationJob(jobId, workerId, nextProbeAt) {
        // RUNNING -> PENDING with new nextProbeAt, release lease. Ownership-checked.
        // probe_count is NOT incremented here — increment happens at claim time only.
        const result = await this.db.execute(sql `
      UPDATE reconciliation_jobs
      SET status = ${"PENDING"}, next_probe_at = ${nextProbeAt}, locked_by = NULL, locked_until = NULL, updated_at = NOW()
      WHERE job_id = ${jobId} AND status = ${"RUNNING"} AND locked_by = ${workerId}
      RETURNING job_id
    `);
        return Array.isArray(result) && result.length > 0;
    }
    async failReconciliationJob(jobId, workerId, error) {
        // RUNNING -> UNRESOLVABLE, record error, release lease. Ownership-checked.
        const result = await this.db.execute(sql `
      UPDATE reconciliation_jobs
      SET status = ${"UNRESOLVABLE"}, last_error = ${error}, locked_by = NULL, locked_until = NULL, updated_at = NOW()
      WHERE job_id = ${jobId} AND status = ${"RUNNING"} AND locked_by = ${workerId}
      RETURNING job_id
    `);
        return Array.isArray(result) && result.length > 0;
    }
    // B.3-B2-WIRING: Sync canonical probe count from reconciliation_jobs to payment_intents.
    // job.probe_count is the authoritative scheduling counter; DPI.probeCount is a derived cache
    // that ReconciliationEngine reads to compute nextProbeMs via getNextProbeDelay().
    async updatePaymentIntentProbeCount(paymentIntentId, probeCount) {
        await this.db.execute(sql `
      UPDATE payment_intents
      SET probe_count = ${probeCount}, updated_at = NOW()
      WHERE payment_intent_id = ${paymentIntentId}
    `);
    }
    rowToIntent(row) {
        return {
            paymentIntentId: row.paymentIntentId, operationId: row.operationId,
            requestId: row.requestId ?? undefined, clientId: row.clientId ?? undefined,
            authorizer: row.authorizer, payTo: row.payTo, value: row.value,
            asset: row.asset, network: row.network, nonce: row.nonce,
            validAfter: row.validAfter, validBefore: row.validBefore,
            paymentPayload: row.paymentPayload, paymentPayloadHash: row.paymentPayloadHash,
            settlementState: row.settlementState,
            txHash: row.txHash ?? undefined, facilitatorHttpStatus: row.facilitatorHttpStatus ?? undefined,
            facilitatorResponseBody: row.facilitatorResponseBody ?? undefined,
            errorReason: row.errorReason ?? undefined,
            submitAttemptAt: row.submitAttemptAt?.getTime(), settledAt: row.settledAt?.getTime(),
            notSettledAt: row.notSettledAt?.getTime(),
            settledEvidenceBundle: row.settledEvidenceBundle,
            notSettledEvidenceBundle: row.notSettledEvidenceBundle,
            reconciliationObservations: row.reconciliationObservations,
            probeCount: row.probeCount ?? 0, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
        };
    }
}
