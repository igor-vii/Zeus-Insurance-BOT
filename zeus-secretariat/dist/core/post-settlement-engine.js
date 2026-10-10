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
    attempts = new Map();
    jobs = new Map();
    attemptsByOp = new Map();
    async saveAttempt(attempt) {
        this.attempts.set(attempt.attemptId, { ...attempt });
        const list = this.attemptsByOp.get(attempt.operationId) ?? [];
        if (!list.includes(attempt.attemptId))
            list.push(attempt.attemptId);
        this.attemptsByOp.set(attempt.operationId, list);
    }
    async getAttemptsByOperation(operationId) {
        const ids = this.attemptsByOp.get(operationId) ?? [];
        return ids.map((id) => this.attempts.get(id)).filter(Boolean);
    }
    async getAttemptById(attemptId) {
        return this.attempts.get(attemptId) ?? null;
    }
    // R2.2 Repair #9: enforce the current operation fence before mutating state.
    async updateAttemptStatus(attemptId, status, fenceGeneration, extra) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt)
            return false;
        const job = Array.from(this.jobs.values()).find((candidate) => candidate.operationId === attempt.operationId);
        if (!job || job.currentAttempt !== fenceGeneration)
            return false;
        // Terminal monotonicity: reject transitions from terminal states
        const terminalStates = ["SUCCESS", "HTTP_FAILURE", "DELIVERY_UNKNOWN", "UNRESOLVABLE"];
        if (terminalStates.includes(attempt.status))
            return false;
        attempt.status = status;
        if (extra)
            Object.assign(attempt, extra);
        return true;
    }
    /**
     * In-memory parity for the PostgreSQL attempted-recovery transaction.
     * There are no awaits between the checks and mutations, so a concurrent
     * call cannot interleave on the JavaScript event loop.
     */
    async createRecoveryAttemptIfOwner(jobId, originalAttemptId, fenceGeneration, retryAttempt, errorReason) {
        const job = this.jobs.get(jobId);
        const original = this.attempts.get(originalAttemptId);
        if (!job ||
            job.status !== "RUNNING" ||
            job.currentAttempt !== fenceGeneration ||
            !original ||
            original.operationId !== job.operationId ||
            (original.status !== "ATTEMPTED" && original.status !== "DELIVERY_UNKNOWN")) {
            return false;
        }
        if (original.status === "ATTEMPTED") {
            original.status = "DELIVERY_UNKNOWN";
            original.errorReason = errorReason;
        }
        this.attempts.set(retryAttempt.attemptId, { ...retryAttempt });
        const attemptIds = this.attemptsByOp.get(retryAttempt.operationId) ?? [];
        if (!attemptIds.includes(retryAttempt.attemptId))
            attemptIds.push(retryAttempt.attemptId);
        this.attemptsByOp.set(retryAttempt.operationId, attemptIds);
        job.status = "PENDING";
        job.lockedBy = undefined;
        job.lockedUntil = undefined;
        job.updatedAt = Date.now();
        return true;
    }
    /**
     * In-memory parity for the PostgreSQL attempted-retrieval transaction.
     */
    async createRecoveryJobIfOwner(jobId, originalAttemptId, fenceGeneration, retrievalJob, errorReason) {
        const job = this.jobs.get(jobId);
        const original = this.attempts.get(originalAttemptId);
        if (!job ||
            job.status !== "RUNNING" ||
            job.currentAttempt !== fenceGeneration ||
            !original ||
            original.operationId !== job.operationId ||
            (original.status !== "ATTEMPTED" && original.status !== "DELIVERY_UNKNOWN")) {
            return false;
        }
        if (original.status === "ATTEMPTED") {
            original.status = "DELIVERY_UNKNOWN";
            original.errorReason = errorReason;
        }
        this.jobs.set(retrievalJob.jobId, { ...retrievalJob });
        job.status = "COMPLETED";
        job.lastError = errorReason;
        job.lockedBy = undefined;
        job.lockedUntil = undefined;
        job.updatedAt = Date.now();
        return true;
    }
    // R2.2 Repair #3D: Atomic ATTEMPTED → UNRESOLVABLE resolution for NONE capability.
    async resolveAttemptUnresolvableIfOwner(jobId, attemptId, fenceGeneration, attemptErrorReason, jobLastError) {
        const job = this.jobs.get(jobId);
        const attempt = this.attempts.get(attemptId);
        if (!job || !attempt)
            return false;
        // Fence check: reject if generation doesn't match current ownership
        if (job.currentAttempt !== fenceGeneration)
            return false;
        // Must be RUNNING (claimed by current worker)
        if (job.status !== "RUNNING")
            return false;
        // Operation must match
        if (attempt.operationId !== job.operationId)
            return false;
        // Terminal monotonicity: reject if attempt already terminal
        const terminalStates = ["SUCCESS", "HTTP_FAILURE", "DELIVERY_UNKNOWN", "UNRESOLVABLE"];
        if (terminalStates.includes(attempt.status))
            return false;
        // Atomic transition: both attempt and job → UNRESOLVABLE
        attempt.status = "UNRESOLVABLE";
        attempt.errorReason = attemptErrorReason;
        job.status = "UNRESOLVABLE";
        job.lastError = jobLastError;
        job.updatedAt = Date.now();
        return true;
    }
    // R2.2 Repair #1A: Mark attempt as in-progress with stale-worker protection.
    async markAttemptInProgress(attemptId, fenceGeneration) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt || attempt.status !== "PENDING")
            return false;
        // Stale-worker protection: verify fence via owning job
        const job = Array.from(this.jobs.values()).find((j) => j.operationId === attempt.operationId);
        if (!job || job.currentAttempt !== fenceGeneration)
            return false;
        attempt.status = "ATTEMPTED";
        attempt.startedAt = Date.now();
        return true;
    }
    async saveJob(job) {
        this.jobs.set(job.jobId, { ...job });
    }
    async getJob(jobId) {
        return this.jobs.get(jobId) ?? null;
    }
    async getPendingJobs() {
        return Array.from(this.jobs.values()).filter((j) => j.status === "PENDING" || (j.status === "RUNNING" && j.lockedUntil && j.lockedUntil < Date.now()));
    }
    /**
     * R2.2 Repair #9: Atomically claim a job with fencing generation.
     * Returns fence generation (monotonic per job) on success, null on failure.
     * Uses currentAttempt as fence generation for in-memory test compatibility.
     */
    async claimJob(jobId, workerId, lockDurationMs) {
        const job = this.jobs.get(jobId);
        if (!job)
            return null;
        if (job.status !== "PENDING" && !(job.status === "RUNNING" && job.lockedUntil && job.lockedUntil < Date.now())) {
            return null;
        }
        job.status = "RUNNING";
        job.lockedBy = workerId;
        job.lockedUntil = Date.now() + lockDurationMs;
        job.currentAttempt += 1;
        job.updatedAt = Date.now();
        // Return currentAttempt as monotonic fence generation
        return job.currentAttempt;
    }
    /**
     * R2.2 Repair #1A: Fenced job status update with stale-worker protection.
     * Checks fenceGeneration against job.currentAttempt (monotonic per claim).
     * Terminal states are irreversible.
     */
    async updateJobStatus(jobId, status, fenceGeneration, extra) {
        const job = this.jobs.get(jobId);
        if (!job)
            return false;
        // Stale-worker protection: reject if fence doesn't match current generation
        if (job.currentAttempt !== fenceGeneration)
            return false;
        // Terminal monotonicity: reject transitions from terminal states
        const terminalStates = ["COMPLETED", "FAILED", "UNRESOLVABLE"];
        if (terminalStates.includes(job.status))
            return false;
        job.status = status;
        if (extra)
            Object.assign(job, extra);
        job.updatedAt = Date.now();
        return true;
    }
}
// ---------------------------------------------------------------------------
// PostSettlementEngine
// ---------------------------------------------------------------------------
export class PostSettlementEngine {
    paymentStore;
    executionStore;
    sellerAdapter;
    config;
    constructor(paymentStore, executionStore, sellerAdapter, config) {
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
    async initiateExecution(operationId, capability, requestBody) {
        // INV-8: Verify settlement
        const intent = await this.paymentStore.getPaymentIntentByOperationId(operationId);
        if (!intent || intent.settlementState !== "SETTLED") {
            throw new Error(`INV-8_VIOLATION: Cannot execute — intent status is ${intent?.settlementState ?? "NOT_FOUND"}, expected SETTLED`);
        }
        const attemptId = `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        // INV-9: Stable execution identity = operationId
        const executionId = operationId;
        const attempt = {
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
        const job = {
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
    /**
     * R2.2 Repair #9: Execute seller call with fencing protection.
     * Transitions attempt to ATTEMPTED (in-progress) BEFORE seller call
     * to durably distinguish "not started" from "call may be in flight".
     */
    async executeAttempt(attemptId, fenceGeneration) {
        const attempt = await this.executionStore.getAttemptById(attemptId);
        if (!attempt)
            throw new Error("ATTEMPT_NOT_FOUND");
        // R2.2 Repair #9: Explicit IN_PROGRESS transition before seller call.
        // If this fails (stale fence or already transitioned), abort execution.
        const marked = await this.executionStore.markAttemptInProgress(attemptId, fenceGeneration);
        if (!marked) {
            throw new Error("FENCE_REJECTED: lost ownership before seller call");
        }
        const request = {
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
                await this.executionStore.updateAttemptStatus(attemptId, "SUCCESS", fenceGeneration, {
                    responseStatusCode: result.statusCode,
                    responseBody: result.body,
                    responseHeaders: result.headers,
                    completedAt: Date.now(),
                });
                break;
            case "HTTP_FAILURE":
                await this.executionStore.updateAttemptStatus(attemptId, "HTTP_FAILURE", fenceGeneration, {
                    responseStatusCode: result.statusCode,
                    responseBody: result.body,
                    responseHeaders: result.headers,
                    completedAt: Date.now(),
                });
                break;
            case "DELIVERY_UNKNOWN":
                await this.executionStore.updateAttemptStatus(attemptId, "DELIVERY_UNKNOWN", fenceGeneration, {
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
    async processJob(jobId) {
        // R2.2 Repair #9: Atomic claim returns fence generation for stale-worker protection.
        const fenceGeneration = await this.executionStore.claimJob(jobId, this.config.workerId, this.config.lockDurationMs);
        if (fenceGeneration === null) {
            return { success: false, finalStatus: "RUNNING" };
        }
        const job = await this.executionStore.getJob(jobId);
        if (!job)
            throw new Error("JOB_NOT_FOUND");
        const metadata = job.metadata;
        const capability = metadata?.capability ?? "NONE";
        // Find the latest attempt for this operation
        const attempts = await this.executionStore.getAttemptsByOperation(job.operationId);
        const latestAttempt = attempts[attempts.length - 1];
        if (!latestAttempt) {
            await this.executionStore.updateJobStatus(jobId, "FAILED", fenceGeneration, {
                lastError: "No execution attempt found",
            });
            return { success: false, finalStatus: "FAILED" };
        }
        // Check if already resolved
        if (latestAttempt.status === "SUCCESS") {
            await this.executionStore.updateJobStatus(jobId, "COMPLETED", fenceGeneration);
            return { success: true, finalStatus: "SUCCESS" };
        }
        // R2.2 Repair #3A: ATTEMPTED after crash recovery means seller call was
        // initiated but result was never persisted. Handle each capability path
        // directly to avoid terminal-state guard rejections and ensure the original
        // ATTEMPTED attempt is NEVER re-executed.
        if (latestAttempt.status === "ATTEMPTED") {
            const recoveryReason = "RECOVERY: attempt was ATTEMPTED at crash recovery — seller call outcome unknown";
            // --- NONE: ATTEMPTED → UNRESOLVABLE atomically (Repair #3D) ---
            if (capability === "NONE") {
                const resolved = await this.executionStore.resolveAttemptUnresolvableIfOwner(jobId, latestAttempt.attemptId, fenceGeneration, recoveryReason, "INV-10: ATTEMPTED at crash recovery with NONE capability — no blind retry");
                if (!resolved)
                    return { success: false, finalStatus: "RUNNING" };
                await this.appendEvidence(job.operationId, "EXECUTION_UNRESOLVABLE", {
                    reason: recoveryReason,
                    attemptId: latestAttempt.attemptId,
                });
                return { success: false, finalStatus: "UNRESOLVABLE" };
            }
            // --- RESULT_RETRIEVAL: Create retrieval job, do NOT re-execute original attempt ---
            if (capability === "RESULT_RETRIEVAL") {
                const retrievalJobId = `job-retrieval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const created = await this.executionStore.createRecoveryJobIfOwner(jobId, latestAttempt.attemptId, fenceGeneration, {
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
                }, recoveryReason);
                if (!created)
                    return { success: false, finalStatus: "RUNNING" };
                await this.appendEvidence(job.operationId, "RETRIEVAL_CREATED", {
                    reason: recoveryReason,
                    retrievalJobId,
                    attemptId: latestAttempt.attemptId,
                });
                return { success: false, finalStatus: "DELIVERY_UNKNOWN" };
            }
            // --- EXECUTION_IDEMPOTENT: Create NEW attempt, do NOT re-execute original ---
            if (capability === "EXECUTION_IDEMPOTENT") {
                // Create new attempt with SAME idempotency key (INV-9)
                if (job.currentAttempt < job.maxAttempts) {
                    const newAttemptId = `attempt-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const created = await this.executionStore.createRecoveryAttemptIfOwner(jobId, latestAttempt.attemptId, fenceGeneration, {
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
                    }, recoveryReason);
                    if (!created)
                        return { success: false, finalStatus: "RUNNING" };
                    await this.appendEvidence(job.operationId, "EXECUTION_RETRY_CREATED", {
                        reason: recoveryReason,
                        newAttemptId,
                        originalAttemptId: latestAttempt.attemptId,
                    });
                    return { success: false, finalStatus: "DELIVERY_UNKNOWN" };
                }
                // Max attempts reached
                const attemptUpdated = await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration, { errorReason: recoveryReason });
                if (!attemptUpdated)
                    return { success: false, finalStatus: "RUNNING" };
                const jobUpdated = await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                    lastError: `Max attempts (${job.maxAttempts}) reached — ATTEMPTED at crash recovery`,
                });
                if (!jobUpdated)
                    return { success: false, finalStatus: "RUNNING" };
                return { success: false, finalStatus: "UNRESOLVABLE" };
            }
            // Unknown capability — treat as NONE (safe default)
            await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration, { errorReason: recoveryReason });
            await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                lastError: "ATTEMPTED at crash recovery with unknown capability",
            });
            return { success: false, finalStatus: "UNRESOLVABLE" };
        }
        // INV-10: NONE capability + DELIVERY_UNKNOWN → UNRESOLVABLE
        if (capability === "NONE" &&
            (latestAttempt.status === "DELIVERY_UNKNOWN" || latestAttempt.status === "PENDING")) {
            // For PENDING with NONE capability, we still try once (first execution)
            // But for DELIVERY_UNKNOWN with NONE, we stop
            if (latestAttempt.status === "DELIVERY_UNKNOWN") {
                await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration);
                await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
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
            return await this.performRetrieval(job, latestAttempt, fenceGeneration);
        }
        // Execute or retry
        const result = await this.executeAttempt(latestAttempt.attemptId, fenceGeneration);
        // Handle result
        switch (result.kind) {
            case "SUCCESS":
                await this.executionStore.updateJobStatus(jobId, "COMPLETED", fenceGeneration);
                await this.appendEvidence(job.operationId, "EXECUTION_SUCCESS", {
                    attemptId: latestAttempt.attemptId,
                    statusCode: result.statusCode,
                });
                return { success: true, result, finalStatus: "SUCCESS" };
            case "HTTP_FAILURE":
                // HTTP failure is a definitive answer — execution happened but failed
                await this.executionStore.updateJobStatus(jobId, "FAILED", fenceGeneration, {
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
                    await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration);
                    await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                        lastError: "INV-10: DELIVERY_UNKNOWN with NONE capability",
                    });
                    return { success: false, result, finalStatus: "UNRESOLVABLE" };
                }
                if (capability === "RESULT_RETRIEVAL") {
                    // R2.2 Repair #3C: Atomic fenced retrieval job creation.
                    // Replaces unfenced saveJob() + separate updateJobStatus() to prevent
                    // stale workers from creating recovery jobs after losing their fence.
                    const retrievalJobId = `job-retrieval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const created = await this.executionStore.createRecoveryJobIfOwner(jobId, latestAttempt.attemptId, fenceGeneration, {
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
                    }, "DELIVERY_UNKNOWN — retrieval job created");
                    if (!created) {
                        // Fence rejected — another worker owns this job now
                        return { success: false, finalStatus: "RUNNING" };
                    }
                    return { success: false, result, finalStatus: "DELIVERY_UNKNOWN" };
                }
                // EXECUTION_IDEMPOTENT: safe to retry
                if (job.currentAttempt < job.maxAttempts) {
                    // R2.2 Repair #3C: Atomic fenced retry attempt creation.
                    // Replaces unfenced saveAttempt() + separate updateJobStatus() to prevent
                    // stale workers from creating retry attempts after losing their fence.
                    const newAttemptId = `attempt-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const created = await this.executionStore.createRecoveryAttemptIfOwner(jobId, latestAttempt.attemptId, fenceGeneration, {
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
                    }, "DELIVERY_UNKNOWN — retry attempt created");
                    if (!created) {
                        // Fence rejected — another worker owns this job now
                        return { success: false, finalStatus: "RUNNING" };
                    }
                    return { success: false, result, finalStatus: "DELIVERY_UNKNOWN" };
                }
                // Max attempts reached
                await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                    lastError: `Max attempts (${job.maxAttempts}) reached with DELIVERY_UNKNOWN`,
                });
                return { success: false, result, finalStatus: "UNRESOLVABLE" };
        }
    }
    /**
     * INV-11: Result retrieval — observation, NOT re-execution.
     * Uses GET to query result without sending the original request again.
     */
    async performRetrieval(job, attempt, fenceGeneration) {
        const retrievalUrl = this.config.resultRetrievalUrl || `${this.config.sellerUrl}/result/${attempt.executionId}`;
        const request = {
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
            await this.executionStore.updateAttemptStatus(attempt.attemptId, "SUCCESS", fenceGeneration, {
                responseStatusCode: result.statusCode,
                responseBody: result.body,
                completedAt: Date.now(),
            });
            await this.executionStore.updateJobStatus(job.jobId, "COMPLETED", fenceGeneration);
            return { success: true, finalStatus: "SUCCESS" };
        }
        if (result.kind === "HTTP_FAILURE" && result.statusCode === 404) {
            // Not found — result not available yet
            await this.executionStore.updateJobStatus(job.jobId, "PENDING", fenceGeneration, {
                lockedBy: undefined,
                lockedUntil: undefined,
                lastError: "Result not found yet — will retry observation",
            });
            return { success: false, finalStatus: "DELIVERY_UNKNOWN" };
        }
        // Other failures
        await this.executionStore.updateJobStatus(job.jobId, "UNRESOLVABLE", fenceGeneration, {
            lastError: `Retrieval failed: ${result.kind}`,
        });
        return { success: false, finalStatus: "UNRESOLVABLE" };
    }
    /**
     * INV-12: Crash recovery — find all pending/stale jobs and resume.
     */
    async recoverPendingJobs() {
        const pendingJobs = await this.executionStore.getPendingJobs();
        const recovered = [];
        for (const job of pendingJobs) {
            const result = await this.processJob(job.jobId);
            recovered.push(`${job.jobId}:${result.finalStatus}`);
        }
        return recovered;
    }
    async appendEvidence(operationId, event, payload) {
        await this.paymentStore.append({
            operationId,
            phase: "EXECUTION",
            timestamp: Date.now(),
            event,
            payload,
        });
    }
}
//# sourceMappingURL=post-settlement-engine.js.map