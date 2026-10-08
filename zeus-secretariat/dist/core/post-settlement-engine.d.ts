/**
 * Zeus Secretariat V0 — Phase 2.4: Post-Settlement Execution & Recovery Engine
 *
 * Orchestrates the flow after PAYMENT_SETTLED:
 *   SETTLED → EXECUTION_PENDING → EXECUTION_ATTEMPTED → SUCCESS / FAILED / DELIVERY_UNKNOWN
 *
 * Invariants enforced:
 *   INV-8:  Settlement before execution (checked at entry)
 *   INV-9:  Stable execution identity (idempotencyKey = operationId, persisted)
 *   INV-10: No blind retry when capability = NONE
 *   INV-11: Observation ≠ Execution (retrieval is read-only)
 *   INV-12: Crash-safe recovery (DB-backed job queue)
 *   INV-13: Evidence before interpretation (raw result stored first)
 */
import type { DurableEvidenceStore } from "./types.js";
import type { SellerExecutionAdapter, SellerExecutionResult } from "../adapters/seller-execution-adapter.js";
export type ExecutionCapability = "EXECUTION_IDEMPOTENT" | "RESULT_RETRIEVAL" | "NONE";
/**
 * Canonical execution obligation status for execution attempts and recovery jobs.
 * Distinct from operation-level ExecutionStatus in types.ts.
 */
export type ExecutionObligationStatus = "PENDING" | "ATTEMPTED" | "SUCCESS" | "HTTP_FAILURE" | "DELIVERY_UNKNOWN" | "UNRESOLVABLE";
export type RecoveryJobType = "EXECUTION" | "RETRY" | "RETRIEVAL" | "OBSERVATION";
export type RecoveryJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "UNRESOLVABLE";
export interface ExecutionAttempt {
    readonly attemptId: string;
    readonly operationId: string;
    readonly executionId: string;
    readonly attemptNumber: number;
    status: ExecutionObligationStatus;
    requestUrl?: string;
    requestMethod?: string;
    requestBody?: unknown;
    responseStatusCode?: number;
    responseBody?: unknown;
    responseHeaders?: Record<string, string>;
    errorReason?: string;
    idempotencyKey?: string;
    startedAt?: number;
    completedAt?: number;
    createdAt: number;
}
export interface RecoveryJob {
    readonly jobId: string;
    readonly operationId: string;
    readonly jobType: RecoveryJobType;
    status: RecoveryJobStatus;
    priority: number;
    maxAttempts: number;
    currentAttempt: number;
    lockedBy?: string;
    lockedUntil?: number;
    lastError?: string;
    metadata?: unknown;
    createdAt: number;
    updatedAt: number;
}
/**
 * Canonical execution store contract.
 * Implemented by both InMemoryExecutionStore and PostgresExecutionStore.
 * PostSettlementEngine depends on this interface, not a concrete class.
 */
export interface ExecutionStore {
    saveAttempt(attempt: ExecutionAttempt): Promise<void>;
    getAttemptById(attemptId: string): Promise<ExecutionAttempt | null>;
    getAttemptsByOperation(operationId: string): Promise<ExecutionAttempt[]>;
    /**
     * R2.2-R9: Requires fenceGeneration for stale-worker protection.
     * Terminal states (SUCCESS, HTTP_FAILURE, DELIVERY_UNKNOWN, UNRESOLVABLE) are irreversible.
     * Returns true if update succeeded, false if rejected (stale fence or terminal state).
     */
    updateAttemptStatus(attemptId: string, status: ExecutionObligationStatus, fenceGeneration: number, extra?: Partial<ExecutionAttempt>): Promise<boolean>;
    /**
     * Atomically mark the original attempted delivery as unknown, create a
     * retry attempt, and requeue the owning job when the fence is still held.
     */
    createRecoveryAttemptIfOwner(jobId: string, originalAttemptId: string, fenceGeneration: number, retryAttempt: ExecutionAttempt, errorReason: string): Promise<boolean>;
    /**
     * Atomically mark the original attempted delivery as unknown, create a
     * retrieval job, and complete the owning job when the fence is still held.
     */
    createRecoveryJobIfOwner(jobId: string, originalAttemptId: string, fenceGeneration: number, retrievalJob: RecoveryJob, errorReason: string): Promise<boolean>;
    /**
     * R2.2 Repair #3D: Atomically resolve ATTEMPTED → UNRESOLVABLE for NONE capability.
     * Verifies fence ownership, transitions attempt and job to UNRESOLVABLE in one operation.
     * Returns false if fence is stale — no state changes occur.
     */
    resolveAttemptUnresolvableIfOwner(jobId: string, attemptId: string, fenceGeneration: number, attemptErrorReason: string, jobLastError: string): Promise<boolean>;
    saveJob(job: RecoveryJob): Promise<void>;
    getJob(jobId: string): Promise<RecoveryJob | null>;
    getPendingJobs(): Promise<RecoveryJob[]>;
    /**
     * R2.2-R9: Returns fence generation on successful claim, null on failure.
     * Fence generation is atomically incremented with lease acquisition.
     */
    claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<number | null>;
    markAttemptInProgress(attemptId: string, fenceGeneration: number): Promise<boolean>;
    /**
     * R2.2 Repair #1: Fenced job status update.
     * Requires current fenceGeneration to prevent stale workers from modifying job state.
     * Terminal states (COMPLETED, FAILED, UNRESOLVABLE) are irreversible.
     * Returns true if update succeeded, false if rejected (stale fence or terminal).
     */
    updateJobStatus(jobId: string, status: RecoveryJobStatus, fenceGeneration: number, extra?: Partial<RecoveryJob>): Promise<boolean>;
}
/**
 * Typed contract for atomic settlement-to-execution handoff.
 * Implementations MUST persist ALL three mutations in a single DB transaction:
 *   1. payment_intents CAS (settlement_state → SETTLED)
 *   2. recovery_jobs INSERT
 *   3. execution_attempts INSERT
 * If any step fails, the entire transaction MUST roll back.
 * Returns true if CAS succeeded and all inserts completed.
 * Returns false if CAS failed (already settled).
 * Throws on infrastructure failure (caller must fail closed).
 */
export interface AtomicSettlementHandoff {
    settleAndCreateExecutionObligation(paymentIntentId: string, operationId: string, settledEvidenceBundle: unknown, job: RecoveryJob, attempt: ExecutionAttempt): Promise<boolean>;
}
export interface PostSettlementConfig {
    /** Worker ID for job locking (INV-AQ: concurrent worker safety) */
    readonly workerId: string;
    /** Lock duration in ms before a job can be reclaimed by another worker */
    readonly lockDurationMs?: number;
    /** Maximum execution attempts before marking UNRESOLVABLE */
    readonly maxExecutionAttempts?: number;
    /** Seller endpoint URL */
    readonly sellerUrl: string;
    /** Seller HTTP method */
    readonly sellerMethod?: string;
    /** Result retrieval endpoint (for RESULT_RETRIEVAL capability) */
    readonly resultRetrievalUrl?: string;
}
/**
 * @experimental NOT PRODUCTION. Phase 2.4 test/experimental only.
 * V0 production uses execution_attempts and reconciliation_jobs tables in PostgreSQL.
 * This class MUST NOT be used in canonical V0 execution path.
 * See docs/CANONICAL_V0_EXECUTION_PATH.md for the authoritative execution architecture.
 */
/** @experimental NOT FOR PRODUCTION - Phase 2.4 prototype only. Production uses PostgreSQL execution_attempts table. */
export declare class InMemoryExecutionStore {
    readonly attempts: Map<string, ExecutionAttempt>;
    readonly jobs: Map<string, RecoveryJob>;
    private readonly attemptsByOp;
    saveAttempt(attempt: ExecutionAttempt): Promise<void>;
    getAttemptsByOperation(operationId: string): Promise<ExecutionAttempt[]>;
    getAttemptById(attemptId: string): Promise<ExecutionAttempt | null>;
    updateAttemptStatus(attemptId: string, status: ExecutionObligationStatus, fenceGeneration: number, extra?: Partial<ExecutionAttempt>): Promise<boolean>;
    /**
     * In-memory parity for the PostgreSQL attempted-recovery transaction.
     * There are no awaits between the checks and mutations, so a concurrent
     * call cannot interleave on the JavaScript event loop.
     */
    createRecoveryAttemptIfOwner(jobId: string, originalAttemptId: string, fenceGeneration: number, retryAttempt: ExecutionAttempt, errorReason: string): Promise<boolean>;
    /**
     * In-memory parity for the PostgreSQL attempted-retrieval transaction.
     */
    createRecoveryJobIfOwner(jobId: string, originalAttemptId: string, fenceGeneration: number, retrievalJob: RecoveryJob, errorReason: string): Promise<boolean>;
    resolveAttemptUnresolvableIfOwner(jobId: string, attemptId: string, fenceGeneration: number, attemptErrorReason: string, jobLastError: string): Promise<boolean>;
    markAttemptInProgress(attemptId: string, fenceGeneration: number): Promise<boolean>;
    saveJob(job: RecoveryJob): Promise<void>;
    getJob(jobId: string): Promise<RecoveryJob | null>;
    getPendingJobs(): Promise<RecoveryJob[]>;
    /**
     * R2.2 Repair #9: Atomically claim a job with fencing generation.
     * Returns fence generation (monotonic per job) on success, null on failure.
     * Uses currentAttempt as fence generation for in-memory test compatibility.
     */
    claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<number | null>;
    /**
     * R2.2 Repair #1A: Fenced job status update with stale-worker protection.
     * Checks fenceGeneration against job.currentAttempt (monotonic per claim).
     * Terminal states are irreversible.
     */
    updateJobStatus(jobId: string, status: RecoveryJobStatus, fenceGeneration: number, extra?: Partial<RecoveryJob>): Promise<boolean>;
}
export declare class PostSettlementEngine {
    private readonly paymentStore;
    private readonly executionStore;
    private readonly sellerAdapter;
    private readonly config;
    constructor(paymentStore: DurableEvidenceStore, executionStore: ExecutionStore, sellerAdapter: SellerExecutionAdapter, config: PostSettlementConfig);
    /**
     * Entry point: called after settlement is confirmed.
     * Creates execution attempt + recovery job. Does NOT execute yet.
     *
     * INV-8: Verifies settlement status before proceeding.
     * INV-9: Uses operationId as stable idempotency key.
     */
    initiateExecution(operationId: string, capability: ExecutionCapability, requestBody?: unknown): Promise<{
        attemptId: string;
        jobId: string;
    }>;
    /**
     * Execute a single attempt. Called by worker after claiming a job.
     *
     * INV-10: If capability = NONE and status = DELIVERY_UNKNOWN → UNRESOLVABLE
     * INV-13: Raw result stored BEFORE state machine interpretation
     */
    /**
     * R2.2 Repair #9: Execute seller call with fencing protection.
     * Transitions attempt to ATTEMPTED (in-progress) BEFORE seller call
     * to durably distinguish "not started" from "call may be in flight".
     */
    executeAttempt(attemptId: string, fenceGeneration: number): Promise<SellerExecutionResult>;
    /**
     * Process a recovery job: claim, execute, handle result.
     *
     * INV-AQ: Atomic job claiming — only one worker processes each job.
     * INV-10: NONE capability + DELIVERY_UNKNOWN → UNRESOLVABLE (no blind retry)
     * INV-11: RETRIEVAL job type uses GET, not re-execution
     */
    processJob(jobId: string): Promise<{
        success: boolean;
        result?: SellerExecutionResult;
        finalStatus: ExecutionObligationStatus | RecoveryJobStatus;
    }>;
    /**
     * INV-11: Result retrieval — observation, NOT re-execution.
     * Uses GET to query result without sending the original request again.
     */
    private performRetrieval;
    /**
     * INV-12: Crash recovery — find all pending/stale jobs and resume.
     */
    recoverPendingJobs(): Promise<string[]>;
    private appendEvidence;
}
//# sourceMappingURL=post-settlement-engine.d.ts.map