/**
 * Zeus Secretariat V0 — PostgreSQL Execution Store
 *
 * Backed by existing Drizzle schemas:
 *   - execution_attempts (execution-recovery.ts)
 *   - recovery_jobs (execution-recovery.ts)
 *
 * Implements the same interface contract as InMemoryExecutionStore.
 * Uses atomic SQL UPDATE...RETURNING for claimJob() cross-process safety.
 *
 * Semantic boundary: This store owns seller execution/recovery persistence.
 * It MUST NOT be used for reconciliation (which uses reconciliation_jobs).
 */
import { eq, sql, asc } from "drizzle-orm";
import { executionAttemptsTable, recoveryJobsTable, } from "@workspace/db/schema";
// ---------------------------------------------------------------------------
// PostgresExecutionStore
// ---------------------------------------------------------------------------
export class PostgresExecutionStore {
    // =========================================================================
    // ExecutionAttempt operations
    // =========================================================================
    db;
    /**
     * @param db - Drizzle database instance. Pass the shared @workspace/db instance
     *             to ensure single connection pool across all consumers.
     */
    constructor(db) {
        this.db = db;
    }
    async saveAttempt(attempt) {
        await this.db.insert(executionAttemptsTable).values({
            attemptId: attempt.attemptId,
            operationId: attempt.operationId,
            executionId: attempt.executionId,
            attemptNumber: attempt.attemptNumber,
            status: attempt.status,
            requestUrl: attempt.requestUrl ?? null,
            requestMethod: attempt.requestMethod ?? null,
            requestBody: attempt.requestBody ?? null,
            responseStatusCode: attempt.responseStatusCode ?? null,
            responseBody: attempt.responseBody ?? null,
            responseHeaders: attempt.responseHeaders ?? null,
            errorReason: attempt.errorReason ?? null,
            idempotencyKey: attempt.idempotencyKey ?? null,
            startedAt: attempt.startedAt ? new Date(attempt.startedAt) : null,
            completedAt: attempt.completedAt ? new Date(attempt.completedAt) : null,
        });
    }
    async getAttemptById(attemptId) {
        const rows = await this.db
            .select()
            .from(executionAttemptsTable)
            .where(eq(executionAttemptsTable.attemptId, attemptId))
            .limit(1);
        if (rows.length === 0)
            return null;
        return this.rowToAttempt(rows[0]);
    }
    async getAttemptsByOperation(operationId) {
        const rows = await this.db
            .select()
            .from(executionAttemptsTable)
            .where(eq(executionAttemptsTable.operationId, operationId))
            .orderBy(asc(executionAttemptsTable.attemptNumber));
        return rows.map((r) => this.rowToAttempt(r));
    }
    /**
     * R2.2 Repair #9: Update attempt status with fencing + terminal monotonicity.
     *
     * Fencing: Requires current fence_generation from the owning recovery job.
     * Stale workers presenting an old generation are rejected (returns false).
     *
     * Terminal monotonicity: Once an attempt reaches a terminal state
     * (SUCCESS, HTTP_FAILURE, DELIVERY_UNKNOWN, UNRESOLVABLE), no further
     * transitions are permitted.
     *
     * Returns true if the update was applied, false if rejected.
     */
    async updateAttemptStatus(attemptId, status, fenceGeneration, extra) {
        const setObj = {
            status,
            ...(extra?.responseStatusCode !== undefined ? { responseStatusCode: extra.responseStatusCode } : {}),
            ...(extra?.responseBody !== undefined ? { responseBody: extra.responseBody } : {}),
            ...(extra?.responseHeaders !== undefined ? { responseHeaders: extra.responseHeaders } : {}),
            ...(extra?.errorReason !== undefined ? { errorReason: extra.errorReason } : {}),
            ...(extra?.startedAt !== undefined ? { startedAt: new Date(extra.startedAt) } : {}),
            ...(extra?.completedAt !== undefined ? { completedAt: new Date(extra.completedAt) } : {}),
        };
        // Atomic update with fence check + terminal monotonicity guard.
        // Joins recovery_jobs via operation_id to verify current ownership generation.
        // Excludes all terminal states to enforce irreversibility.
        const casResult = await this.db.execute(sql `
      UPDATE execution_attempts ea
      SET status = ${status},
          response_status_code = COALESCE(${setObj.responseStatusCode ?? null}, ea.response_status_code),
          response_body = COALESCE(${JSON.stringify(setObj.responseBody ?? null)}::jsonb, ea.response_body),
          response_headers = COALESCE(${JSON.stringify(setObj.responseHeaders ?? null)}::jsonb, ea.response_headers),
          error_reason = COALESCE(${setObj.errorReason ?? null}, ea.error_reason),
          started_at = COALESCE(${setObj.startedAt ?? null}, ea.started_at),
          completed_at = COALESCE(${setObj.completedAt ?? null}, ea.completed_at)
      FROM recovery_jobs rj
      WHERE ea.attempt_id = ${attemptId}
        AND rj.operation_id = ea.operation_id
        AND rj.fence_generation = ${fenceGeneration}
        AND ea.status NOT IN (${"SUCCESS"}, ${"HTTP_FAILURE"}, ${"DELIVERY_UNKNOWN"}, ${"UNRESOLVABLE"})
       RETURNING ea.attempt_id
    `);
        const rows = Array.isArray(casResult) ? casResult : casResult.rows;
        return !!(rows && rows.length > 0);
    }
    /**
     * Atomically recover an ATTEMPTED execution when this worker still owns the
     * current fence. The recovery_jobs row is locked first, followed by the
     * original execution_attempts row. This lock order must match every other
     * recovery mutation.
     */
    async createRecoveryAttemptIfOwner(jobId, originalAttemptId, fenceGeneration, retryAttempt, errorReason) {
        return this.db.transaction(async (tx) => {
            const jobResult = await tx.execute(sql `
        SELECT job_id, operation_id, status, fence_generation
        FROM recovery_jobs
        WHERE job_id = ${jobId}
        FOR UPDATE
      `);
            const jobRows = Array.isArray(jobResult) ? jobResult : jobResult.rows;
            const job = jobRows?.[0];
            if (!job ||
                job.status !== "RUNNING" ||
                Number(job.fence_generation) !== fenceGeneration) {
                return false;
            }
            const attemptResult = await tx.execute(sql `
        SELECT attempt_id, operation_id, status
        FROM execution_attempts
        WHERE attempt_id = ${originalAttemptId}
        FOR UPDATE
      `);
            const attemptRows = Array.isArray(attemptResult) ? attemptResult : attemptResult.rows;
            const original = attemptRows?.[0];
            if (!original ||
                original.operation_id !== job.operation_id ||
                (original.status !== "ATTEMPTED" && original.status !== "DELIVERY_UNKNOWN")) {
                return false;
            }
            if (original.status === "ATTEMPTED") {
                await tx.execute(sql `
          UPDATE execution_attempts
          SET status = ${"DELIVERY_UNKNOWN"},
              error_reason = ${errorReason},
              completed_at = NOW()
          WHERE attempt_id = ${originalAttemptId}
        `);
            }
            await tx.insert(executionAttemptsTable).values({
                attemptId: retryAttempt.attemptId,
                operationId: retryAttempt.operationId,
                executionId: retryAttempt.executionId,
                attemptNumber: retryAttempt.attemptNumber,
                status: retryAttempt.status,
                requestUrl: retryAttempt.requestUrl ?? null,
                requestMethod: retryAttempt.requestMethod ?? null,
                requestBody: retryAttempt.requestBody ?? null,
                responseStatusCode: retryAttempt.responseStatusCode ?? null,
                responseBody: retryAttempt.responseBody ?? null,
                responseHeaders: retryAttempt.responseHeaders ?? null,
                errorReason: retryAttempt.errorReason ?? null,
                idempotencyKey: retryAttempt.idempotencyKey ?? null,
                startedAt: retryAttempt.startedAt ? new Date(retryAttempt.startedAt) : null,
                completedAt: retryAttempt.completedAt ? new Date(retryAttempt.completedAt) : null,
                createdAt: new Date(retryAttempt.createdAt),
            });
            await tx.execute(sql `
        UPDATE recovery_jobs
        SET status = ${"PENDING"},
            locked_by = NULL,
            locked_until = NULL,
            last_error = ${errorReason},
            updated_at = NOW()
        WHERE job_id = ${jobId}
          AND status = ${"RUNNING"}
          AND fence_generation = ${fenceGeneration}
      `);
            return true;
        });
    }
    /**
     * Atomically hand an ATTEMPTED execution off to result retrieval while this
     * worker still owns the current fence.
     */
    async createRecoveryJobIfOwner(jobId, originalAttemptId, fenceGeneration, retrievalJob, errorReason) {
        return this.db.transaction(async (tx) => {
            const jobResult = await tx.execute(sql `
        SELECT job_id, operation_id, status, fence_generation
        FROM recovery_jobs
        WHERE job_id = ${jobId}
        FOR UPDATE
      `);
            const jobRows = Array.isArray(jobResult) ? jobResult : jobResult.rows;
            const job = jobRows?.[0];
            if (!job ||
                job.status !== "RUNNING" ||
                Number(job.fence_generation) !== fenceGeneration) {
                return false;
            }
            const attemptResult = await tx.execute(sql `
        SELECT attempt_id, operation_id, status
        FROM execution_attempts
        WHERE attempt_id = ${originalAttemptId}
        FOR UPDATE
      `);
            const attemptRows = Array.isArray(attemptResult) ? attemptResult : attemptResult.rows;
            const original = attemptRows?.[0];
            if (!original ||
                original.operation_id !== job.operation_id ||
                (original.status !== "ATTEMPTED" && original.status !== "DELIVERY_UNKNOWN")) {
                return false;
            }
            if (original.status === "ATTEMPTED") {
                await tx.execute(sql `
          UPDATE execution_attempts
          SET status = ${"DELIVERY_UNKNOWN"},
              error_reason = ${errorReason},
              completed_at = NOW()
          WHERE attempt_id = ${originalAttemptId}
        `);
            }
            await tx.insert(recoveryJobsTable).values({
                jobId: retrievalJob.jobId,
                operationId: retrievalJob.operationId,
                jobType: retrievalJob.jobType,
                status: retrievalJob.status,
                priority: retrievalJob.priority,
                maxAttempts: retrievalJob.maxAttempts,
                currentAttempt: retrievalJob.currentAttempt,
                lockedBy: retrievalJob.lockedBy ?? null,
                lockedUntil: retrievalJob.lockedUntil ? new Date(retrievalJob.lockedUntil) : null,
                lastError: retrievalJob.lastError ?? null,
                metadata: retrievalJob.metadata ?? null,
                createdAt: new Date(retrievalJob.createdAt),
                updatedAt: new Date(retrievalJob.updatedAt),
            });
            await tx.execute(sql `
        UPDATE recovery_jobs
        SET status = ${"COMPLETED"},
            locked_by = NULL,
            locked_until = NULL,
            last_error = ${errorReason},
            updated_at = NOW()
        WHERE job_id = ${jobId}
          AND status = ${"RUNNING"}
          AND fence_generation = ${fenceGeneration}
      `);
            return true;
        });
    }
    /**
     * R2.2 Repair #3D: Atomically resolve ATTEMPTED → UNRESOLVABLE for NONE capability.
     * Single transaction: verify fence → transition attempt → close job as UNRESOLVABLE.
     */
    /**
     * R2.2 Repair #3D-corrected: Atomically resolve ATTEMPTED → UNRESOLVABLE.
     * Uses rowCount for UPDATE verification and binds attempt to job via operation_id.
     */
    async resolveAttemptUnresolvableIfOwner(jobId, attemptId, fenceGeneration, attemptErrorReason, jobLastError) {
        try {
            const result = await this.db.transaction(async (tx) => {
                // Step 1: Lock the job row and verify current fence ownership
                const lockResult = await tx.execute(sql `
          SELECT job_id, operation_id FROM recovery_jobs
          WHERE job_id = ${jobId}
            AND fence_generation = ${fenceGeneration}
          FOR UPDATE
        `);
                const lockRows = Array.isArray(lockResult) ? lockResult : lockResult.rows;
                if (!lockRows || lockRows.length === 0)
                    return false;
                const jobOperationId = lockRows[0].operation_id;
                // Step 2: Transition attempt to UNRESOLVABLE with operation_id binding.
                // The WHERE clause ensures the attempt belongs to the same operation as the job.
                // Uses RETURNING to verify exactly one row was affected (rowCount equivalent).
                const attemptResult = await tx.execute(sql `
          UPDATE execution_attempts
          SET status = ${"UNRESOLVABLE"},
              error_reason = ${attemptErrorReason}
          WHERE attempt_id = ${attemptId}
            AND operation_id = ${jobOperationId}
            AND status NOT IN (${"SUCCESS"}, ${"HTTP_FAILURE"}, ${"DELIVERY_UNKNOWN"}, ${"UNRESOLVABLE"})
          RETURNING attempt_id
        `);
                const attemptRows = Array.isArray(attemptResult) ? attemptResult : attemptResult.rows;
                if (!attemptRows || attemptRows.length !== 1)
                    return false;
                // Step 3: Close job as UNRESOLVABLE
                await tx.execute(sql `
          UPDATE recovery_jobs
          SET status = ${"UNRESOLVABLE"},
              last_error = ${jobLastError},
              updated_at = NOW()
          WHERE job_id = ${jobId}
        `);
                return true;
            });
            return result ?? false;
        }
        catch (err) {
            const pgErr = err;
            if (pgErr.code === "23505")
                return false;
            throw err;
        }
    }
    /**
     * R2.2 Repair #9: Transition attempt to ATTEMPTED before seller call.
     * Durably distinguishes "not yet started" from "seller call may be in flight".
     * Uses same fencing + monotonicity guards as updateAttemptStatus.
     */
    async markAttemptInProgress(attemptId, fenceGeneration) {
        const casResult = await this.db.execute(sql `
      UPDATE execution_attempts ea
      SET status = ${"ATTEMPTED"},
          started_at = NOW()
      FROM recovery_jobs rj
      WHERE ea.attempt_id = ${attemptId}
        AND rj.operation_id = ea.operation_id
        AND rj.fence_generation = ${fenceGeneration}
        AND ea.status = ${"PENDING"}
       RETURNING ea.attempt_id
    `);
        const rows = Array.isArray(casResult) ? casResult : casResult.rows;
        return !!(rows && rows.length > 0);
    }
    // =========================================================================
    // RecoveryJob operations
    // =========================================================================
    async saveJob(job) {
        await this.db.insert(recoveryJobsTable).values({
            jobId: job.jobId,
            operationId: job.operationId,
            jobType: job.jobType,
            status: job.status,
            priority: job.priority,
            maxAttempts: job.maxAttempts,
            currentAttempt: job.currentAttempt,
            lockedBy: job.lockedBy ?? null,
            lockedUntil: job.lockedUntil ? new Date(job.lockedUntil) : null,
            lastError: job.lastError ?? null,
            metadata: job.metadata ?? null,
        });
    }
    async getJob(jobId) {
        const rows = await this.db
            .select()
            .from(recoveryJobsTable)
            .where(eq(recoveryJobsTable.jobId, jobId))
            .limit(1);
        if (rows.length === 0)
            return null;
        return this.rowToJob(rows[0]);
    }
    /**
     * Returns jobs that are PENDING or have stale locks (RUNNING but lock expired).
     * Ordered by priority DESC, then createdAt ASC for fairness.
     */
    async getPendingJobs() {
        const rows = await this.db.execute(sql `
      SELECT * FROM recovery_jobs
      WHERE status = ${"PENDING"}
         OR (status = ${"RUNNING"} AND locked_until < NOW())
      ORDER BY priority DESC, created_at ASC
      LIMIT 100
    `);
        return (Array.isArray(rows) ? rows : []).map((r) => this.rowToJob(r));
    }
    /**
     * Atomic job claim using UPDATE...RETURNING.
     * Only one worker/process can successfully claim a given job.
     * Stale RUNNING jobs (locked_until < NOW()) are reclaimable.
     */
    /**
     * R2.2 Repair #9: Atomically claim a recovery job with fencing generation.
     * Returns the new fence generation on success, or null if claim failed.
     * The fence generation is monotonically incremented on each claim and must
     * be presented when committing state transitions to prevent stale workers.
     */
    async claimJob(jobId, workerId, lockDurationMs) {
        const lockUntil = new Date(Date.now() + lockDurationMs);
        const casResult = await this.db.execute(sql `
      UPDATE recovery_jobs
      SET status = ${"RUNNING"},
          locked_by = ${workerId},
          locked_until = ${lockUntil},
          current_attempt = current_attempt + 1,
          fence_generation = fence_generation + 1,
          updated_at = NOW()
      WHERE job_id = ${jobId}
        AND (status = ${"PENDING"} OR (status = ${"RUNNING"} AND locked_until < NOW()))
      RETURNING fence_generation
    `);
        // Drizzle node-postgres returns { rows: [...] } or plain array depending on version
        const rows = Array.isArray(casResult) ? casResult : casResult.rows;
        if (!rows || rows.length === 0) {
            return null;
        }
        return rows[0].fence_generation;
    }
    /**
     * R2.2 Repair #1: Fenced job status update with terminal monotonicity.
     *
     * Stale-worker protection: Requires current fenceGeneration. A worker that
     * has lost its lease (and been superseded by a newer claim) cannot modify
     * the job state. The WHERE clause joins on fence_generation to enforce this.
     *
     * Terminal monotonicity: Once a job reaches COMPLETED, FAILED, or UNRESOLVABLE,
     * no further transitions are permitted. The WHERE clause excludes terminal states.
     *
     * Returns true if the update was applied, false if rejected.
     */
    async updateJobStatus(jobId, status, fenceGeneration, extra) {
        const setObj = {
            status,
            updatedAt: new Date(),
            ...(extra?.lastError !== undefined ? { lastError: extra.lastError } : {}),
            ...(extra?.lockedBy !== undefined ? { lockedBy: extra.lockedBy } : {}),
            ...(extra?.lockedUntil !== undefined ? { lockedUntil: new Date(extra.lockedUntil) } : {}),
        };
        // Clear lock when job completes or becomes unresolvable
        if (status === "COMPLETED" || status === "FAILED" || status === "UNRESOLVABLE") {
            setObj.lockedBy = null;
            setObj.lockedUntil = null;
        }
        // Atomic fenced update with terminal monotonicity guard.
        // Worker must present current fenceGeneration. Terminal states are irreversible.
        const casResult = await this.db.execute(sql `
      UPDATE recovery_jobs
      SET status = ${status},
          updated_at = NOW(),
          last_error = COALESCE(${setObj.lastError ?? null}, last_error),
          locked_by = CASE
            WHEN ${status} IN (${"COMPLETED"}, ${"FAILED"}, ${"UNRESOLVABLE"}) THEN NULL
            ELSE COALESCE(${setObj.lockedBy ?? null}, locked_by)
          END,
          locked_until = CASE
            WHEN ${status} IN (${"COMPLETED"}, ${"FAILED"}, ${"UNRESOLVABLE"}) THEN NULL
            ELSE COALESCE(${setObj.lockedUntil ?? null}, locked_until)
          END
      WHERE job_id = ${jobId}
        AND fence_generation = ${fenceGeneration}
        AND status NOT IN (${"COMPLETED"}, ${"FAILED"}, ${"UNRESOLVABLE"})
    `);
        const rows = Array.isArray(casResult) ? casResult : casResult.rows;
        return !!(rows && rows.length > 0);
    }
    // =========================================================================
    // Atomic settlement + execution obligation (TASK 3)
    // =========================================================================
    /**
     * Atomically persist SETTLED payment state + execution obligation.
     *
     * This is the durable handoff boundary:
     *   payment_intents.settlement_state = SETTLED
     *   AND recovery_jobs(EXECUTION, PENDING)
     *   AND execution_attempts(PENDING)
     * become durable in a single transaction.
     *
     * If any step fails, all are rolled back.
     * CAS on payment_intents prevents duplicate settlement.
     */
    /**
     * R2.1-FIX-3: Transactional settlement → execution handoff.
     * All mutations (CAS on payment_intents + job insert + attempt insert)
     * happen in a single DB transaction. If any step fails, all are rolled back.
     */
    async settleAndCreateExecutionObligation(paymentIntentId, operationId, settledEvidenceBundle, job, attempt) {
        try {
            // R2.1-FIX-3: All mutations in a single DB transaction.
            // If CAS succeeds but job/attempt insert fails, entire transaction rolls back.
            const result = await this.db.transaction(async (tx) => {
                // Step 1: CAS transition to SETTLED
                const casResult = await tx.execute(sql `
          UPDATE payment_intents
          SET settlement_state = ${"SETTLED"},
              settled_evidence_bundle = ${JSON.stringify(settledEvidenceBundle)}::jsonb,
              version = version + 1,
              settled_at = NOW(),
              updated_at = NOW()
          WHERE payment_intent_id = ${paymentIntentId}
            AND settlement_state IN (${"SETTLEMENT_PENDING"}, ${"RECONCILING"}, ${"SUBMITTED"})
          RETURNING payment_intent_id
        `);
                // R2.1-FIX-5-REPAIR-3K: Drizzle tx.execute() with node-postgres returns
                // { rows: Row[] } object, NOT a plain array. Inspect .rows for CAS result.
                const casRows = Array.isArray(casResult) ? casResult : casResult.rows;
                if (!casRows || casRows.length === 0) {
                    return false;
                }
                // Step 2: Insert recovery job (within same transaction)
                await tx.insert(recoveryJobsTable).values({
                    jobId: job.jobId,
                    operationId: job.operationId,
                    jobType: job.jobType,
                    status: job.status,
                    priority: job.priority,
                    maxAttempts: job.maxAttempts,
                    currentAttempt: job.currentAttempt,
                    metadata: job.metadata ?? null,
                });
                // Step 3: Insert initial execution attempt (within same transaction)
                await tx.insert(executionAttemptsTable).values({
                    attemptId: attempt.attemptId,
                    operationId: attempt.operationId,
                    executionId: attempt.executionId,
                    attemptNumber: attempt.attemptNumber,
                    status: attempt.status,
                    requestUrl: attempt.requestUrl ?? null,
                    requestMethod: attempt.requestMethod ?? null,
                    requestBody: attempt.requestBody ?? null,
                    idempotencyKey: attempt.idempotencyKey ?? null,
                });
                return true;
            });
            return result ?? false;
        }
        catch (err) {
            // On unique violation (duplicate job/attempt), the obligation already exists
            const pgErr = err;
            if (pgErr.code === "23505") {
                // Duplicate — obligation already persisted by another worker
                return true;
            }
            throw err;
        }
    }
    // =========================================================================
    // Helpers
    // =========================================================================
    rowToAttempt(row) {
        return {
            attemptId: row.attemptId,
            operationId: row.operationId,
            executionId: row.executionId,
            attemptNumber: row.attemptNumber,
            status: row.status,
            requestUrl: row.requestUrl ?? undefined,
            requestMethod: row.requestMethod ?? undefined,
            requestBody: row.requestBody ?? undefined,
            responseStatusCode: row.responseStatusCode ?? undefined,
            responseBody: row.responseBody ?? undefined,
            responseHeaders: row.responseHeaders ?? undefined,
            errorReason: row.errorReason ?? undefined,
            idempotencyKey: row.idempotencyKey ?? undefined,
            startedAt: row.startedAt?.getTime(),
            completedAt: row.completedAt?.getTime(),
            createdAt: row.createdAt.getTime(),
        };
    }
    rowToJob(row) {
        return {
            jobId: row.jobId,
            operationId: row.operationId,
            jobType: row.jobType,
            status: row.status,
            priority: row.priority,
            maxAttempts: row.maxAttempts,
            currentAttempt: row.currentAttempt,
            lockedBy: row.lockedBy ?? undefined,
            lockedUntil: row.lockedUntil?.getTime(),
            lastError: row.lastError ?? undefined,
            metadata: row.metadata ?? undefined,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
        };
    }
}
