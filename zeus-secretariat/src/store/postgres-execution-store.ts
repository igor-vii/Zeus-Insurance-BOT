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

import { eq, and, sql, asc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  executionAttemptsTable,
  recoveryJobsTable,
} from "@workspace/db/schema";
import type {
  ExecutionAttempt,
  ExecutionObligationStatus,
  RecoveryJob,
  RecoveryJobStatus,
} from "../core/post-settlement-engine";

// ---------------------------------------------------------------------------
// Row types matching Drizzle schema output
// ---------------------------------------------------------------------------

interface ExecutionAttemptRow {
  attemptId: string;
  operationId: string;
  executionId: string;
  attemptNumber: number;
  status: string;
  requestUrl: string | null;
  requestMethod: string | null;
  requestBody: unknown;
  responseStatusCode: number | null;
  responseBody: unknown;
  responseHeaders: unknown;
  errorReason: string | null;
  idempotencyKey: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

interface RecoveryJobRow {
  jobId: string;
  operationId: string;
  jobType: string;
  status: string;
  priority: number;
  maxAttempts: number;
  currentAttempt: number;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastError: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// PostgresExecutionStore
// ---------------------------------------------------------------------------

export class PostgresExecutionStore {
  // =========================================================================
  // ExecutionAttempt operations
  // =========================================================================

  private readonly db: NodePgDatabase;

  /**
   * @param db - Drizzle database instance. Pass the shared @workspace/db instance
   *             to ensure single connection pool across all consumers.
   */
  constructor(db: NodePgDatabase) {
    this.db = db;
  }

  async saveAttempt(attempt: ExecutionAttempt): Promise<void> {
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

  async getAttemptById(attemptId: string): Promise<ExecutionAttempt | null> {
    const rows = await this.db
      .select()
      .from(executionAttemptsTable)
      .where(eq(executionAttemptsTable.attemptId, attemptId))
      .limit(1);
    if (rows.length === 0) return null;
    return this.rowToAttempt(rows[0] as ExecutionAttemptRow);
  }

  async getAttemptsByOperation(operationId: string): Promise<ExecutionAttempt[]> {
    const rows = await this.db
      .select()
      .from(executionAttemptsTable)
      .where(eq(executionAttemptsTable.operationId, operationId))
      .orderBy(asc(executionAttemptsTable.attemptNumber));
    return rows.map((r: any) => this.rowToAttempt(r as ExecutionAttemptRow));
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
  async updateAttemptStatus(
    attemptId: string,
    status: ExecutionObligationStatus,
    fenceGeneration: number,
    extra?: Partial<ExecutionAttempt>,
  ): Promise<boolean> {
    const setObj: Record<string, unknown> = {
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
    const casResult = await this.db.execute(sql`
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
    `);

    const rows = Array.isArray(casResult) ? casResult : (casResult as any).rows;
    return !!(rows && rows.length > 0);
  }

  /**
   * R2.2 Repair #9: Transition attempt to ATTEMPTED before seller call.
   * Durably distinguishes "not yet started" from "seller call may be in flight".
   * Uses same fencing + monotonicity guards as updateAttemptStatus.
   */
  async markAttemptInProgress(
    attemptId: string,
    fenceGeneration: number,
  ): Promise<boolean> {
    const casResult = await this.db.execute(sql`
      UPDATE execution_attempts ea
      SET status = ${"ATTEMPTED"},
          started_at = NOW()
      FROM recovery_jobs rj
      WHERE ea.attempt_id = ${attemptId}
        AND rj.operation_id = ea.operation_id
        AND rj.fence_generation = ${fenceGeneration}
        AND ea.status = ${"PENDING"}
    `);
    const rows = Array.isArray(casResult) ? casResult : (casResult as any).rows;
    return !!(rows && rows.length > 0);
  }

  // =========================================================================
  // RecoveryJob operations
  // =========================================================================

  async saveJob(job: RecoveryJob): Promise<void> {
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

  async getJob(jobId: string): Promise<RecoveryJob | null> {
    const rows = await this.db
      .select()
      .from(recoveryJobsTable)
      .where(eq(recoveryJobsTable.jobId, jobId))
      .limit(1);
    if (rows.length === 0) return null;
    return this.rowToJob(rows[0] as RecoveryJobRow);
  }

  /**
   * Returns jobs that are PENDING or have stale locks (RUNNING but lock expired).
   * Ordered by priority DESC, then createdAt ASC for fairness.
   */
  async getPendingJobs(): Promise<RecoveryJob[]> {
    const rows = await this.db.execute(sql`
      SELECT * FROM recovery_jobs
      WHERE status = ${"PENDING"}
         OR (status = ${"RUNNING"} AND locked_until < NOW())
      ORDER BY priority DESC, created_at ASC
      LIMIT 100
    `);
    return (Array.isArray(rows) ? rows : []).map((r: any) => this.rowToJob(r as RecoveryJobRow));
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
  async claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<number | null> {
    const lockUntil = new Date(Date.now() + lockDurationMs);
    const casResult = await this.db.execute(sql`
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
    const rows = Array.isArray(casResult) ? casResult : (casResult as any).rows;
    if (!rows || rows.length === 0) {
      return null;
    }
    return rows[0].fence_generation as number;
  }

  async updateJobStatus(
    jobId: string,
    status: RecoveryJobStatus,
    extra?: Partial<RecoveryJob>,
  ): Promise<void> {
    const setObj: Record<string, unknown> = {
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
    await this.db
      .update(recoveryJobsTable)
      .set(setObj)
      .where(eq(recoveryJobsTable.jobId, jobId));
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
  async settleAndCreateExecutionObligation(
    paymentIntentId: string,
    operationId: string,
    settledEvidenceBundle: unknown,
    job: RecoveryJob,
    attempt: ExecutionAttempt,
  ): Promise<boolean> {
    try {
      // R2.1-FIX-3: All mutations in a single DB transaction.
      // If CAS succeeds but job/attempt insert fails, entire transaction rolls back.
      const result = await this.db.transaction(async (tx) => {
        // Step 1: CAS transition to SETTLED
        const casResult = await tx.execute(sql`
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
        const casRows = Array.isArray(casResult) ? casResult : (casResult as any).rows;
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
    } catch (err: unknown) {
      // On unique violation (duplicate job/attempt), the obligation already exists
      const pgErr = err as { code?: string };
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

  private rowToAttempt(row: ExecutionAttemptRow): ExecutionAttempt {
    return {
      attemptId: row.attemptId,
      operationId: row.operationId,
      executionId: row.executionId,
      attemptNumber: row.attemptNumber,
      status: row.status as ExecutionObligationStatus,
      requestUrl: row.requestUrl ?? undefined,
      requestMethod: row.requestMethod ?? undefined,
      requestBody: row.requestBody ?? undefined,
      responseStatusCode: row.responseStatusCode ?? undefined,
      responseBody: row.responseBody ?? undefined,
      responseHeaders: (row.responseHeaders as Record<string, string>) ?? undefined,
      errorReason: row.errorReason ?? undefined,
      idempotencyKey: row.idempotencyKey ?? undefined,
      startedAt: row.startedAt?.getTime(),
      completedAt: row.completedAt?.getTime(),
      createdAt: row.createdAt.getTime(),
    };
  }

  private rowToJob(row: RecoveryJobRow): RecoveryJob {
    return {
      jobId: row.jobId,
      operationId: row.operationId,
      jobType: row.jobType as RecoveryJob["jobType"],
      status: row.status as RecoveryJobStatus,
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
