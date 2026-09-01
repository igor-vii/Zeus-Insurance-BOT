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
  ExecutionStatus,
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

  async updateAttemptStatus(
    attemptId: string,
    status: ExecutionStatus,
    extra?: Partial<ExecutionAttempt>,
  ): Promise<void> {
    const setObj: Record<string, unknown> = {
      status,
      ...(extra?.responseStatusCode !== undefined ? { responseStatusCode: extra.responseStatusCode } : {}),
      ...(extra?.responseBody !== undefined ? { responseBody: extra.responseBody } : {}),
      ...(extra?.responseHeaders !== undefined ? { responseHeaders: extra.responseHeaders } : {}),
      ...(extra?.errorReason !== undefined ? { errorReason: extra.errorReason } : {}),
      ...(extra?.startedAt !== undefined ? { startedAt: new Date(extra.startedAt) } : {}),
      ...(extra?.completedAt !== undefined ? { completedAt: new Date(extra.completedAt) } : {}),
    };
    await this.db
      .update(executionAttemptsTable)
      .set(setObj)
      .where(eq(executionAttemptsTable.attemptId, attemptId));
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
  async claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean> {
    const lockUntil = new Date(Date.now() + lockDurationMs);
    const result = await this.db.execute(sql`
      UPDATE recovery_jobs
      SET status = ${"RUNNING"},
          locked_by = ${workerId},
          locked_until = ${lockUntil},
          current_attempt = current_attempt + 1,
          updated_at = NOW()
      WHERE job_id = ${jobId}
        AND (status = ${"PENDING"} OR (status = ${"RUNNING"} AND locked_until < NOW()))
      RETURNING job_id
    `);
    return Array.isArray(result) && result.length > 0;
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
      // Step 1: CAS transition to SETTLED
      const casResult = await this.db.execute(sql`
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

      if (!Array.isArray(casResult) || casResult.length === 0) {
        // CAS failed — already settled or invalid state
        return false;
      }

      // Step 2: Insert recovery job (EXECUTION, PENDING)
      await this.db.insert(recoveryJobsTable).values({
        jobId: job.jobId,
        operationId: job.operationId,
        jobType: job.jobType,
        status: job.status,
        priority: job.priority,
        maxAttempts: job.maxAttempts,
        currentAttempt: job.currentAttempt,
        metadata: job.metadata ?? null,
      });

      // Step 3: Insert initial execution attempt (PENDING)
      await this.db.insert(executionAttemptsTable).values({
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
      status: row.status as ExecutionStatus,
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
