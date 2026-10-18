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
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ExecutionAttempt, ExecutionObligationStatus, RecoveryJob, RecoveryJobStatus } from "zeus-secretariat";
export declare class PostgresExecutionStore {
    private readonly db;
    /**
     * @param db - Drizzle database instance. Pass the shared @workspace/db instance
     *             to ensure single connection pool across all consumers.
     */
    constructor(db: NodePgDatabase);
    saveAttempt(attempt: ExecutionAttempt): Promise<void>;
    getAttemptById(attemptId: string): Promise<ExecutionAttempt | null>;
    getAttemptsByOperation(operationId: string): Promise<ExecutionAttempt[]>;
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
    updateAttemptStatus(attemptId: string, status: ExecutionObligationStatus, fenceGeneration: number, extra?: Partial<ExecutionAttempt>): Promise<boolean>;
    /**
     * Atomically recover an ATTEMPTED execution when this worker still owns the
     * current fence. The recovery_jobs row is locked first, followed by the
     * original execution_attempts row. This lock order must match every other
     * recovery mutation.
     */
    createRecoveryAttemptIfOwner(jobId: string, originalAttemptId: string, fenceGeneration: number, retryAttempt: ExecutionAttempt, errorReason: string): Promise<boolean>;
    /**
     * Atomically hand an ATTEMPTED execution off to result retrieval while this
     * worker still owns the current fence.
     */
    createRecoveryJobIfOwner(jobId: string, originalAttemptId: string, fenceGeneration: number, retrievalJob: RecoveryJob, errorReason: string): Promise<boolean>;
    /**
     * R2.2 Repair #3D: Atomically resolve ATTEMPTED → UNRESOLVABLE for NONE capability.
     * Single transaction: verify fence → transition attempt → close job as UNRESOLVABLE.
     */
    /**
     * R2.2 Repair #3D-corrected: Atomically resolve ATTEMPTED → UNRESOLVABLE.
     * Uses rowCount for UPDATE verification and binds attempt to job via operation_id.
     */
    resolveAttemptUnresolvableIfOwner(jobId: string, attemptId: string, fenceGeneration: number, attemptErrorReason: string, jobLastError: string): Promise<boolean>;
    /**
     * R2.2 Repair #9: Transition attempt to ATTEMPTED before seller call.
     * Durably distinguishes "not yet started" from "seller call may be in flight".
     * Uses same fencing + monotonicity guards as updateAttemptStatus.
     */
    markAttemptInProgress(attemptId: string, fenceGeneration: number): Promise<boolean>;
    saveJob(job: RecoveryJob): Promise<void>;
    getJob(jobId: string): Promise<RecoveryJob | null>;
    /**
     * Returns jobs that are PENDING or have stale locks (RUNNING but lock expired).
     * Ordered by priority DESC, then createdAt ASC for fairness.
     */
    getPendingJobs(): Promise<RecoveryJob[]>;
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
    claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<number | null>;
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
    updateJobStatus(jobId: string, status: RecoveryJobStatus, fenceGeneration: number, extra?: Partial<RecoveryJob>): Promise<boolean>;
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
    settleAndCreateExecutionObligation(paymentIntentId: string, operationId: string, settledEvidenceBundle: unknown, job: RecoveryJob, attempt: ExecutionAttempt): Promise<boolean>;
    private rowToAttempt;
    private rowToJob;
}
//# sourceMappingURL=postgres-execution-store.d.ts.map