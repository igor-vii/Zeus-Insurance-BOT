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

import type {
  DurableEvidenceStore,
  DurablePaymentIntent,
  EvidenceRecord,
  ExecutionStatus,
} from "./types";
import type {
  SellerExecutionAdapter,
  SellerExecutionRequest,
  SellerExecutionResult,
} from "../adapters/seller-execution-adapter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionCapability =
  | "EXECUTION_IDEMPOTENT"   // safe to retry with same idempotency key
  | "RESULT_RETRIEVAL"       // can query result without re-executing
  | "NONE";                  // no recovery possible — honest UNKNOWN

// ExecutionStatus imported from ./types (operation-level lifecycle)

/**
 * Canonical execution obligation status for execution attempts and recovery jobs.
 * Distinct from operation-level ExecutionStatus in types.ts.
 */
export type ExecutionObligationStatus =
  | "PENDING"
  | "ATTEMPTED"
  | "SUCCESS"
  | "HTTP_FAILURE"
  | "DELIVERY_UNKNOWN"
  | "UNRESOLVABLE";

export type RecoveryJobType =
  | "EXECUTION"
  | "RETRY"
  | "RETRIEVAL"
  | "OBSERVATION";

export type RecoveryJobStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "UNRESOLVABLE";

export interface ExecutionAttempt {
  readonly attemptId: string;
  readonly operationId: string;
  readonly executionId: string;       // stable idempotency key (INV-9)
  readonly attemptNumber: number;
  status: ExecutionStatus;
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

// ---------------------------------------------------------------------------
// ExecutionStore Interface (R2.1-FIX-1: moved from types.ts to avoid circular dep)
// ---------------------------------------------------------------------------

/**
 * Canonical execution store contract.
 * Implemented by both InMemoryExecutionStore and PostgresExecutionStore.
 * PostSettlementEngine depends on this interface, not a concrete class.
 */
export interface ExecutionStore {
  saveAttempt(attempt: ExecutionAttempt): Promise<void>;
  getAttemptById(attemptId: string): Promise<ExecutionAttempt | null>;
  getAttemptsByOperation(operationId: string): Promise<ExecutionAttempt[]>;
  updateAttemptStatus(attemptId: string, status: ExecutionStatus, extra?: Partial<ExecutionAttempt>): Promise<void>;
  saveJob(job: RecoveryJob): Promise<void>;
  getJob(jobId: string): Promise<RecoveryJob | null>;
  getPendingJobs(): Promise<RecoveryJob[]>;
  claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean>;
  updateJobStatus(jobId: string, status: RecoveryJobStatus, extra?: Partial<RecoveryJob>): Promise<void>;
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

// ---------------------------------------------------------------------------
// In-Memory Execution Store (for testing + fallback)
// ---------------------------------------------------------------------------

/**
 * @experimental NOT PRODUCTION. Phase 2.4 test/experimental only.
 * V0 production uses execution_attempts and reconciliation_jobs tables in PostgreSQL.
 * This class MUST NOT be used in canonical V0 execution path.
 * See docs/CANONICAL_V0_EXECUTION_PATH.md for the authoritative execution architecture.
 */
/** @experimental NOT FOR PRODUCTION - Phase 2.4 prototype only. Production uses PostgreSQL execution_attempts table. */
export class InMemoryExecutionStore {
  readonly attempts: Map<string, ExecutionAttempt> = new Map();
  readonly jobs: Map<string, RecoveryJob> = new Map();
  private readonly attemptsByOp: Map<string, string[]> = new Map();

  async saveAttempt(attempt: ExecutionAttempt): Promise<void> {
    this.attempts.set(attempt.attemptId, { ...attempt });
    const list = this.attemptsByOp.get(attempt.operationId) ?? [];
    if (!list.includes(attempt.attemptId)) list.push(attempt.attemptId);
    this.attemptsByOp.set(attempt.operationId, list);
  }

  async getAttemptsByOperation(operationId: string): Promise<ExecutionAttempt[]> {
    const ids = this.attemptsByOp.get(operationId) ?? [];
    return ids.map((id) => this.attempts.get(id)!).filter(Boolean);
  }

  async getAttemptById(attemptId: string): Promise<ExecutionAttempt | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async updateAttemptStatus(attemptId: string, status: ExecutionStatus, extra?: Partial<ExecutionAttempt>): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
    attempt.status = status;
    if (extra) Object.assign(attempt, extra);
  }

  async saveJob(job: RecoveryJob): Promise<void> {
    this.jobs.set(job.jobId, { ...job });
  }

  async getJob(jobId: string): Promise<RecoveryJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async getPendingJobs(): Promise<RecoveryJob[]> {
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === "PENDING" || (j.status === "RUNNING" && j.lockedUntil && j.lockedUntil < Date.now()),
    );
  }

  /**
   * Atomically claim a job (INV-AQ: only one worker gets it).
   * Returns true if this worker claimed it, false if another worker already has it.
   */
  async claimJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status !== "PENDING" && !(job.status === "RUNNING" && job.lockedUntil && job.lockedUntil < Date.now())) {
      return false;
    }
    job.status = "RUNNING";
    job.lockedBy = workerId;
    job.lockedUntil = Date.now() + lockDurationMs;
    job.currentAttempt += 1;
    job.updatedAt = Date.now();
    return true;
  }

  async updateJobStatus(jobId: string, status: RecoveryJobStatus, extra?: Partial<RecoveryJob>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    job.status = status;
    if (extra) Object.assign(job, extra);
    job.updatedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// PostSettlementEngine
// ---------------------------------------------------------------------------

export class PostSettlementEngine {
  private readonly paymentStore: DurableEvidenceStore;
  private readonly executionStore: ExecutionStore;
  private readonly sellerAdapter: SellerExecutionAdapter;
  private readonly config: Required<PostSettlementConfig>;

  constructor(
    paymentStore: DurableEvidenceStore,
    executionStore: ExecutionStore,
    sellerAdapter: SellerExecutionAdapter,
    config: PostSettlementConfig,
  ) {
    this.paymentStore = paymentStore;
    this.executionStore = executionStore;
    this.sellerAdapter = sellerAdapter;
    this.config = {
      workerId: config.workerId,
      lockDurationMs: config.lockDurationMs ?? 60_000,
      maxExecutionAttempts: config.maxExecutionAttempts ?? 3,
      sellerUrl: config.sellerUrl,
      sellerMethod: config.sellerMethod ?? "POST",
      resultRetrievalUrl: config.resultRetrievalUrl ?? "",
    };
  }

  /**
   * Entry point: called after settlement is confirmed.
   * Creates execution attempt + recovery job. Does NOT execute yet.
   *
   * INV-8: Verifies settlement status before proceeding.
   * INV-9: Uses operationId as stable idempotency key.
   */
  async initiateExecution(
    operationId: string,
    capability: ExecutionCapability,
    requestBody?: unknown,
  ): Promise<{ attemptId: string; jobId: string }> {
    // INV-8: Verify settlement
    const intent = await this.paymentStore.getPaymentIntentByOperationId(operationId);
    if (!intent || intent.settlementState !== "SETTLED") {
      throw new Error(
        `INV-8_VIOLATION: Cannot execute — intent status is ${intent?.settlementState ?? "NOT_FOUND"}, expected SETTLED`,
      );
    }

    const attemptId = `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // INV-9: Stable execution identity = operationId
    const executionId = operationId;

    const attempt: ExecutionAttempt = {
      attemptId,
      operationId,
      executionId,
      attemptNumber: 1,
      status: "PENDING",
      requestUrl: this.config.sellerUrl,
      requestMethod: this.config.sellerMethod,
      requestBody,
      idempotencyKey: executionId,
      createdAt: Date.now(),
    };

    const job: RecoveryJob = {
      jobId,
      operationId,
      jobType: "EXECUTION",
      status: "PENDING",
      priority: 0,
      maxAttempts: this.config.maxExecutionAttempts,
      currentAttempt: 0,
      metadata: { capability, requestBody },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.executionStore.saveAttempt(attempt);
    await this.executionStore.saveJob(job);

    await this.appendEvidence(operationId, "EXECUTION_INITIATED", {
      attemptId,
      jobId,
      executionId,
      capability,
    });

    return { attemptId, jobId };
  }

  /**
   * Execute a single attempt. Called by worker after claiming a job.
   *
   * INV-10: If capability = NONE and status = DELIVERY_UNKNOWN → UNRESOLVABLE
   * INV-13: Raw result stored BEFORE state machine interpretation
   */
  async executeAttempt(attemptId: string): Promise<SellerExecutionResult> {
    const attempt = await this.executionStore.getAttemptById(attemptId);
    if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");

    // Mark as attempted
    await this.executionStore.updateAttemptStatus(attemptId, "ATTEMPTED", {
      startedAt: Date.now(),
    });

    const request: SellerExecutionRequest = {
      idempotencyKey: attempt.idempotencyKey ?? attempt.executionId,
      url: attempt.requestUrl ?? this.config.sellerUrl,
      method: attempt.requestMethod ?? this.config.sellerMethod,
      body: attempt.requestBody,
    };

    // Execute — adapter returns 3-way result (INV-13: evidence before interpretation)
    const result = await this.sellerAdapter.execute(request);

    // Store raw evidence FIRST (INV-13)
    await this.appendEvidence(attempt.operationId, "EXECUTION_RESULT_RAW", {
      attemptId,
      result,
    });

    // NOW interpret and update status
    switch (result.kind) {
      case "SUCCESS":
        await this.executionStore.updateAttemptStatus(attemptId, "SUCCESS", {
          responseStatusCode: result.statusCode,
          responseBody: result.body,
          responseHeaders: result.headers,
          completedAt: Date.now(),
        });
        break;

      case "HTTP_FAILURE":
        await this.executionStore.updateAttemptStatus(attemptId, "HTTP_FAILURE", {
          responseStatusCode: result.statusCode,
          responseBody: result.body,
          responseHeaders: result.headers,
          completedAt: Date.now(),
        });
        break;

      case "DELIVERY_UNKNOWN":
        await this.executionStore.updateAttemptStatus(attemptId, "DELIVERY_UNKNOWN", {
          errorReason: result.reason,
          completedAt: Date.now(),
        });
        break;
    }

    return result;
  }

  /**
   * Process a recovery job: claim, execute, handle result.
   *
   * INV-AQ: Atomic job claiming — only one worker processes each job.
   * INV-10: NONE capability + DELIVERY_UNKNOWN → UNRESOLVABLE (no blind retry)
   * INV-11: RETRIEVAL job type uses GET, not re-execution
   */
  async processJob(jobId: string): Promise<{
    success: boolean;
    result?: SellerExecutionResult;
    finalStatus: ExecutionStatus | RecoveryJobStatus;
  }> {
    // INV-AQ: Atomic claim
    const claimed = await this.executionStore.claimJob(
      jobId,
      this.config.workerId,
      this.config.lockDurationMs,
    );

    if (!claimed) {
      return { success: false, finalStatus: "RUNNING" };
    }

    const job = await this.executionStore.getJob(jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");

    const metadata = job.metadata as { capability?: ExecutionCapability; requestBody?: unknown } | undefined;
    const capability = metadata?.capability ?? "NONE";

    // Find the latest attempt for this operation
    const attempts = await this.executionStore.getAttemptsByOperation(job.operationId);
    const latestAttempt = attempts[attempts.length - 1];

    if (!latestAttempt) {
      await this.executionStore.updateJobStatus(jobId, "FAILED", {
        lastError: "No execution attempt found",
      });
      return { success: false, finalStatus: "FAILED" };
    }

    // Check if already resolved
    if (latestAttempt.status === "SUCCESS") {
      await this.executionStore.updateJobStatus(jobId, "COMPLETED");
      return { success: true, finalStatus: "SUCCESS" };
    }

    // INV-10: NONE capability + DELIVERY_UNKNOWN → UNRESOLVABLE
    if (
      capability === "NONE" &&
      (latestAttempt.status === "DELIVERY_UNKNOWN" || latestAttempt.status === "PENDING")
    ) {
      // For PENDING with NONE capability, we still try once (first execution)
      // But for DELIVERY_UNKNOWN with NONE, we stop
      if (latestAttempt.status === "DELIVERY_UNKNOWN") {
        await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE");
        await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", {
          lastError: "INV-10: DELIVERY_UNKNOWN with NONE capability — no blind retry",
        });

        await this.appendEvidence(job.operationId, "EXECUTION_UNRESOLVABLE", {
          reason: "NONE capability cannot recover from DELIVERY_UNKNOWN",
          attemptId: latestAttempt.attemptId,
        });

        return { success: false, finalStatus: "UNRESOLVABLE" };
      }
    }

    // INV-11: RETRIEVAL — observation, not re-execution
    if (job.jobType === "RETRIEVAL" && capability === "RESULT_RETRIEVAL") {
      return await this.performRetrieval(job, latestAttempt);
    }

    // Execute or retry
    const result = await this.executeAttempt(latestAttempt.attemptId);

    // Handle result
    switch (result.kind) {
      case "SUCCESS":
        await this.executionStore.updateJobStatus(jobId, "COMPLETED");
        await this.appendEvidence(job.operationId, "EXECUTION_SUCCESS", {
          attemptId: latestAttempt.attemptId,
          statusCode: result.statusCode,
        });
        return { success: true, result, finalStatus: "SUCCESS" };

      case "HTTP_FAILURE":
        // HTTP failure is a definitive answer — execution happened but failed
        await this.executionStore.updateJobStatus(jobId, "FAILED", {
          lastError: `HTTP ${result.statusCode}`,
        });
        await this.appendEvidence(job.operationId, "EXECUTION_HTTP_FAILURE", {
          attemptId: latestAttempt.attemptId,
          statusCode: result.statusCode,
        });
        return { success: false, result, finalStatus: "HTTP_FAILURE" };

      case "DELIVERY_UNKNOWN":
        if (capability === "NONE") {
          // INV-10: No blind retry
          await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE");
          await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", {
            lastError: "INV-10: DELIVERY_UNKNOWN with NONE capability",
          });
          return { success: false, result, finalStatus: "UNRESOLVABLE" };
        }

        if (capability === "RESULT_RETRIEVAL") {
          // Create a retrieval job instead of retrying execution
          const retrievalJobId = `job-retrieval-${Date.now()}`;
          await this.executionStore.saveJob({
            jobId: retrievalJobId,
            operationId: job.operationId,
            jobType: "RETRIEVAL",
            status: "PENDING",
            priority: 1,
            maxAttempts: 3,
            currentAttempt: 0,
            metadata: { capability, originalJobId: jobId },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });

          await this.executionStore.updateJobStatus(jobId, "COMPLETED", {
            lastError: "DELIVERY_UNKNOWN — retrieval job created",
          });

          return { success: false, result, finalStatus: "DELIVERY_UNKNOWN" };
        }

        // EXECUTION_IDEMPOTENT: safe to retry
        if (job.currentAttempt < job.maxAttempts) {
          // Create new attempt with SAME idempotency key (INV-9)
          const newAttemptId = `attempt-retry-${Date.now()}`;
          await this.executionStore.saveAttempt({
            attemptId: newAttemptId,
            operationId: job.operationId,
            executionId: latestAttempt.executionId, // SAME stable key
            attemptNumber: latestAttempt.attemptNumber + 1,
            status: "PENDING",
            requestUrl: latestAttempt.requestUrl,
            requestMethod: latestAttempt.requestMethod,
            requestBody: latestAttempt.requestBody,
            idempotencyKey: latestAttempt.idempotencyKey, // SAME key
            createdAt: Date.now(),
          });

          // Re-queue the job
          await this.executionStore.updateJobStatus(jobId, "PENDING", {
            lockedBy: undefined,
            lockedUntil: undefined,
          });

          return { success: false, result, finalStatus: "DELIVERY_UNKNOWN" };
        }

        // Max attempts reached
        await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", {
          lastError: `Max attempts (${job.maxAttempts}) reached with DELIVERY_UNKNOWN`,
        });
        return { success: false, result, finalStatus: "UNRESOLVABLE" };
    }
  }

  /**
   * INV-11: Result retrieval — observation, NOT re-execution.
   * Uses GET to query result without sending the original request again.
   */
  private async performRetrieval(
    job: RecoveryJob,
    attempt: ExecutionAttempt,
  ): Promise<{ success: boolean; finalStatus: ExecutionStatus | RecoveryJobStatus }> {
    const retrievalUrl = this.config.resultRetrievalUrl || `${this.config.sellerUrl}/result/${attempt.executionId}`;

    const request: SellerExecutionRequest = {
      idempotencyKey: `retrieval-${attempt.executionId}`,
      url: retrievalUrl,
      method: "GET", // INV-11: GET, not POST — observation only
    };

    const result = await this.sellerAdapter.execute(request);

    await this.appendEvidence(job.operationId, "RETRIEVAL_RESULT", {
      jobId: job.jobId,
      result,
    });

    if (result.kind === "SUCCESS") {
      await this.executionStore.updateAttemptStatus(attempt.attemptId, "SUCCESS", {
        responseStatusCode: result.statusCode,
        responseBody: result.body,
        completedAt: Date.now(),
      });
      await this.executionStore.updateJobStatus(job.jobId, "COMPLETED");
      return { success: true, finalStatus: "SUCCESS" };
    }

    if (result.kind === "HTTP_FAILURE" && result.statusCode === 404) {
      // Not found — result not available yet
      await this.executionStore.updateJobStatus(job.jobId, "PENDING", {
        lockedBy: undefined,
        lockedUntil: undefined,
        lastError: "Result not found yet — will retry observation",
      });
      return { success: false, finalStatus: "DELIVERY_UNKNOWN" };
    }

    // Other failures
    await this.executionStore.updateJobStatus(job.jobId, "UNRESOLVABLE", {
      lastError: `Retrieval failed: ${result.kind}`,
    });
    return { success: false, finalStatus: "UNRESOLVABLE" };
  }

  /**
   * INV-12: Crash recovery — find all pending/stale jobs and resume.
   */
  async recoverPendingJobs(): Promise<string[]> {
    const pendingJobs = await this.executionStore.getPendingJobs();
    const recovered: string[] = [];

    for (const job of pendingJobs) {
      const result = await this.processJob(job.jobId);
      recovered.push(`${job.jobId}:${result.finalStatus}`);
    }

    return recovered;
  }

  private async appendEvidence(
    operationId: string,
    event: string,
    payload: unknown,
  ): Promise<void> {
    await this.paymentStore.append({
      operationId,
      phase: "EXECUTION",
      timestamp: Date.now(),
      event,
      payload,
    });
  }
}
