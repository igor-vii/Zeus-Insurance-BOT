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
import { randomUUID } from 'node:crypto';
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
    /**
     * F-001: in-memory parity for the atomic attempt+job creation.
     * There are no awaits between the mutations, so a concurrent call cannot
     * interleave on the JavaScript event loop — both rows or neither.
     */
    async saveAttemptWithJob(attempt, job) {
        this.attempts.set(attempt.attemptId, { ...attempt });
        const list = this.attemptsByOp.get(attempt.operationId) ?? [];
        if (!list.includes(attempt.attemptId))
            list.push(attempt.attemptId);
        this.attemptsByOp.set(attempt.operationId, list);
        this.jobs.set(job.jobId, { ...job });
    }
    async getAttemptsByOperation(operationId) {
        const ids = this.attemptsByOp.get(operationId) ?? [];
        return ids.map((id) => this.attempts.get(id)).filter(Boolean);
    }
    async getAttemptById(attemptId) {
        return this.attempts.get(attemptId) ?? null;
    }
    // R2.2 Repair #9: enforce the current operation fence before mutating state.
    // F-04: when jobId is provided, the fence must come from THAT job.
    async updateAttemptStatus(attemptId, status, fenceGeneration, extra, jobId) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt)
            return false;
        const job = jobId
            ? this.jobs.get(jobId)
            : Array.from(this.jobs.values()).find((candidate) => candidate.operationId === attempt.operationId);
        if (!job || job.operationId !== attempt.operationId || job.currentAttempt !== fenceGeneration)
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
     * F-02: in-memory parity of the atomic DELIVERY_UNKNOWN → SUCCESS +
     * job → COMPLETED transition, fenced to the specific job.
     */
    async resolveRetrievalSuccessIfOwner(jobId, attemptId, fenceGeneration, extra) {
        const job = this.jobs.get(jobId);
        const attempt = this.attempts.get(attemptId);
        if (!job ||
            job.status !== "RUNNING" ||
            job.currentAttempt !== fenceGeneration ||
            !attempt ||
            attempt.operationId !== job.operationId ||
            attempt.status !== "DELIVERY_UNKNOWN") {
            return false;
        }
        attempt.status = "SUCCESS";
        if (extra)
            Object.assign(attempt, extra);
        job.status = "COMPLETED";
        job.lockedBy = undefined;
        job.lockedUntil = undefined;
        job.updatedAt = Date.now();
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
    // F-04: when jobId is provided, the fence must come from THAT job.
    async markAttemptInProgress(attemptId, fenceGeneration, jobId) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt || attempt.status !== "PENDING")
            return false;
        // Stale-worker protection: verify fence via owning job
        const job = jobId
            ? this.jobs.get(jobId)
            : Array.from(this.jobs.values()).find((j) => j.operationId === attempt.operationId);
        if (!job || job.operationId !== attempt.operationId || job.currentAttempt !== fenceGeneration)
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
/**
 * R7-B2 (external audit 2026-10-26, High): seller statuses whose answer does
 * NOT prove the paid call definitively failed. 408 (seller-side timeout),
 * 429 (rate limit) and gateway-class 5xx mean the request MAY or MAY NOT
 * have been processed. Definitive 4xx (400/401/403/404/…) are NOT here.
 */
const RETRYABLE_SELLER_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
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
        const attemptId = `attempt-${Date.now()}-${randomUUID()}`;
        const jobId = `job-${Date.now()}-${randomUUID()}`;
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
        // F-001 (external audit Blocker): single transactional write.
        // The previous saveAttempt() → saveJob() pair left a crash window: a
        // failure between the two writes persisted the attempt without the job,
        // and the obligation scanner excluded such intents forever — the seller
        // was never called despite SETTLED payment. Now both rows are created
        // atomically; if this throws, NOTHING persists and the next scan retries.
        await this.executionStore.saveAttemptWithJob(attempt, job);
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
    async executeAttempt(attemptId, fenceGeneration, jobId) {
        const attempt = await this.executionStore.getAttemptById(attemptId);
        if (!attempt)
            throw new Error("ATTEMPT_NOT_FOUND");
        // R2.2 Repair #9: Explicit IN_PROGRESS transition before seller call.
        // If this fails (stale fence or already transitioned), abort execution.
        // F-04: fence bound to the specific job when the caller provides it.
        const marked = await this.executionStore.markAttemptInProgress(attemptId, fenceGeneration, jobId);
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
        // NOW interpret and update status.
        // F-03 fix (external audit 2026-10-25): the caller MUST NOT report an
        // outcome that the authoritative store rejected. A rejected write means
        // the fence was lost or the attempt already terminal — throw so
        // processJob cannot publish SUCCESS/FAILURE/UNKNOWN for a state that was
        // never committed. The attempt keeps its ATTEMPTED status, so the next
        // claim goes through the safe ATTEMPTED crash-recovery path.
        let persisted;
        switch (result.kind) {
            case "SUCCESS":
                persisted = await this.executionStore.updateAttemptStatus(attemptId, "SUCCESS", fenceGeneration, {
                    responseStatusCode: result.statusCode,
                    responseBody: result.body,
                    responseHeaders: result.headers,
                    completedAt: Date.now(),
                }, jobId);
                break;
            case "HTTP_FAILURE": {
                // R7-B2: for TRANSIENT statuses (408/429/500/502/503/504) the outcome
                // is UNKNOWN, not a definitive failure — the attempt is recorded as
                // DELIVERY_UNKNOWN (with the HTTP status preserved in errorReason)
                // so the fenced retry machinery (createRecoveryAttemptIfOwner) can
                // take over, exactly like a timeout. Definitive 4xx stays
                // HTTP_FAILURE (terminal, honest: the seller answered).
                const transient = RETRYABLE_SELLER_STATUSES.has(result.statusCode);
                persisted = await this.executionStore.updateAttemptStatus(attemptId, transient ? "DELIVERY_UNKNOWN" : "HTTP_FAILURE", fenceGeneration, transient
                    ? { errorReason: `HTTP ${result.statusCode} — transient seller failure (outcome unknown)`, responseStatusCode: result.statusCode, responseBody: result.body, completedAt: Date.now() }
                    : { responseStatusCode: result.statusCode, responseBody: result.body, responseHeaders: result.headers, completedAt: Date.now() }, jobId);
                break;
            }
            case "DELIVERY_UNKNOWN":
                persisted = await this.executionStore.updateAttemptStatus(attemptId, "DELIVERY_UNKNOWN", fenceGeneration, {
                    errorReason: result.reason,
                    completedAt: Date.now(),
                }, jobId);
                break;
        }
        if (!persisted) {
            await this.appendEvidence(attempt.operationId, "EXECUTION_PERSIST_REJECTED", {
                attemptId,
                jobId: jobId ?? null,
                outcome: result.kind,
                note: "Authoritative store rejected the status write — outcome NOT published",
            });
            throw new Error(`ATTEMPT_PERSIST_REJECTED: ${result.kind} outcome for attempt ${attemptId} was not durably committed`);
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
        // Check if already resolved. F-03: the COMPLETED closure is verified —
        // a rejected write (stale fence) must not be reported as success.
        if (latestAttempt.status === "SUCCESS") {
            const jobCompleted = await this.executionStore.updateJobStatus(jobId, "COMPLETED", fenceGeneration);
            if (!jobCompleted)
                return { success: false, finalStatus: "RUNNING" };
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
                const retrievalJobId = `job-retrieval-${Date.now()}-${randomUUID()}`;
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
                    const newAttemptId = `attempt-retry-${Date.now()}-${randomUUID()}`;
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
                // INV-10 close-out: the attempt is ALREADY terminal (DELIVERY_UNKNOWN) —
                // the terminal monotonicity guard correctly rejects attempt-level
                // writes, so the attempt marker is best-effort (it stays honest:
                // DELIVERY_UNKNOWN). The JOB closure below is the operational decision
                // and is fenced + mandatory (F-03: verified).
                await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration, undefined, jobId).catch(() => false);
                const jobResolved = await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                    lastError: "INV-10: DELIVERY_UNKNOWN with NONE capability — no blind retry",
                });
                if (!jobResolved)
                    return { success: false, finalStatus: "RUNNING" };
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
        // Execute or retry.
        // F-04: pass the jobId so every attempt mutation is fenced to THIS job.
        const result = await this.executeAttempt(latestAttempt.attemptId, fenceGeneration, jobId);
        // Handle result. F-03: every finality write below is verified — a rejected
        // write (lost fence / already-terminal) must NOT be reported as success.
        switch (result.kind) {
            case "SUCCESS": {
                const jobCompleted = await this.executionStore.updateJobStatus(jobId, "COMPLETED", fenceGeneration);
                if (!jobCompleted)
                    return { success: false, finalStatus: "RUNNING" };
                await this.appendEvidence(job.operationId, "EXECUTION_SUCCESS", {
                    attemptId: latestAttempt.attemptId,
                    statusCode: result.statusCode,
                });
                return { success: true, result, finalStatus: "SUCCESS" };
            }
            case "HTTP_FAILURE": {
                // R7-B2 (external audit 2026-10-26, High): "HTTP failure is a
                // definitive answer" was TRUE only for a subset of statuses. A
                // 408/429/503/504 (and gateway-class 5xx) does NOT tell us the paid
                // call definitively failed — the backend may or may not have
                // processed it. Collapsing ALL of them to terminal FAILED hid
                // possible deliveries behind a lie.
                //
                // Classification (mirrors the facilitator leg, F-112):
                //   definitive 4xx (400/401/403/404/405/410/422/…) → HTTP_FAILURE
                //     → execution feedback → FAILED (honest: the seller answered).
                //   transient/unknown (408, 429, 500, 502, 503, 504) →
                //     capability-gated retry exactly like DELIVERY_UNKNOWN; with no
                //     retry capability → UNRESOLVABLE (INV-10 semantics — money
                //     spent, outcome unknown, no blind retry).
                if (RETRYABLE_SELLER_STATUSES.has(result.statusCode)) {
                    if (capability === "EXECUTION_IDEMPOTENT" && job.currentAttempt < job.maxAttempts) {
                        // R7-B12: retries are gated STRICTLY on EXECUTION_IDEMPOTENT.
                        const newAttemptId = `attempt-retry-${Date.now()}-${randomUUID()}`;
                        const created = await this.executionStore.createRecoveryAttemptIfOwner(jobId, latestAttempt.attemptId, fenceGeneration, {
                            attemptId: newAttemptId,
                            operationId: job.operationId,
                            executionId: latestAttempt.executionId, // SAME stable key
                            attemptNumber: latestAttempt.attemptNumber + 1,
                            status: "PENDING",
                            requestUrl: latestAttempt.requestUrl,
                            requestMethod: latestAttempt.requestMethod,
                            requestBody: latestAttempt.requestBody,
                            idempotencyKey: latestAttempt.idempotencyKey, // SAME key (INV-9)
                            createdAt: Date.now(),
                        }, `HTTP ${result.statusCode} — transient seller failure, idempotent retry created`);
                        if (!created)
                            return { success: false, finalStatus: "RUNNING" };
                        await this.appendEvidence(job.operationId, "EXECUTION_RETRY_CREATED", {
                            reason: `HTTP ${result.statusCode} — transient seller failure`,
                            newAttemptId,
                            originalAttemptId: latestAttempt.attemptId,
                        });
                        // Outcome not yet known — the retry attempt will produce the
                        // authoritative verdict; feedback maps this to EXECUTION_UNKNOWN.
                        return { success: false, result, finalStatus: "DELIVERY_UNKNOWN" };
                    }
                    // No idempotent-retry capability: honest unknown, not a lie.
                    // Attempt marker is best-effort (may already be terminal); the job
                    // closure is fenced + mandatory (F-03: verified).
                    await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration, {
                        errorReason: `HTTP ${result.statusCode} with capability ${capability} — outcome unknown, no safe retry`,
                    }, jobId).catch(() => false);
                    const jobUnknown = await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                        lastError: `HTTP ${result.statusCode} — transient seller failure without retry capability ${capability}`,
                    });
                    if (!jobUnknown)
                        return { success: false, finalStatus: "RUNNING" };
                    await this.appendEvidence(job.operationId, "EXECUTION_UNRESOLVABLE", {
                        reason: `HTTP ${result.statusCode} with capability ${capability} — outcome unknown, no safe retry`,
                        attemptId: latestAttempt.attemptId,
                    });
                    return { success: false, result, finalStatus: "UNRESOLVABLE" };
                }
                // Definitive seller answer — execution happened and failed.
                const jobFailed = await this.executionStore.updateJobStatus(jobId, "FAILED", fenceGeneration, {
                    lastError: `HTTP ${result.statusCode}`,
                });
                if (!jobFailed)
                    return { success: false, finalStatus: "RUNNING" };
                await this.appendEvidence(job.operationId, "EXECUTION_HTTP_FAILURE", {
                    attemptId: latestAttempt.attemptId,
                    statusCode: result.statusCode,
                });
                return { success: false, result, finalStatus: "HTTP_FAILURE" };
            }
            case "DELIVERY_UNKNOWN":
                if (capability === "NONE") {
                    // INV-10: No blind retry. Attempt marker is best-effort (already
                    // terminal — see the INV-10 close-out above); job closure is
                    // fenced + mandatory (F-03: verified).
                    await this.executionStore.updateAttemptStatus(latestAttempt.attemptId, "UNRESOLVABLE", fenceGeneration, undefined, jobId).catch(() => false);
                    const jobResolved2 = await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                        lastError: "INV-10: DELIVERY_UNKNOWN with NONE capability",
                    });
                    if (!jobResolved2)
                        return { success: false, finalStatus: "RUNNING" };
                    return { success: false, result, finalStatus: "UNRESOLVABLE" };
                }
                if (capability === "RESULT_RETRIEVAL") {
                    // R2.2 Repair #3C: Atomic fenced retrieval job creation.
                    // Replaces unfenced saveJob() + separate updateJobStatus() to prevent
                    // stale workers from creating recovery jobs after losing their fence.
                    const retrievalJobId = `job-retrieval-${Date.now()}-${randomUUID()}`;
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
                // R7-B12 (external audit 2026-10-26): retries are gated STRICTLY on
                // EXECUTION_IDEMPOTENT. The previous fall-through accepted ANY other
                // capability here — including header-claimed SIGNED_RECEIPT, which is
                // NOT IMPLEMENTED — and re-fired the PAID call under a capability
                // that never promised idempotency. Anything but EXECUTION_IDEMPOTENT
                // is treated as NONE (INV-10: honest UNRESOLVABLE, no blind retry).
                if (capability === "EXECUTION_IDEMPOTENT" && job.currentAttempt < job.maxAttempts) {
                    // R2.2 Repair #3C: Atomic fenced retry attempt creation.
                    // Replaces unfenced saveAttempt() + separate updateJobStatus() to prevent
                    // stale workers from creating retry attempts after losing their fence.
                    const newAttemptId = `attempt-retry-${Date.now()}-${randomUUID()}`;
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
                    // B-BS-16 evidence gap (found by the r6 post-money gate): the
                    // ATTEMPTED crash-recovery branch records EXECUTION_RETRY_CREATED,
                    // but this live DELIVERY_UNKNOWN retry branch created the recovery
                    // attempt silently — the recovery DECISION was missing from the
                    // evidence trail. INV-13: record the decision.
                    await this.appendEvidence(job.operationId, "EXECUTION_RETRY_CREATED", {
                        reason: "DELIVERY_UNKNOWN — retry attempt created",
                        newAttemptId,
                        originalAttemptId: latestAttempt.attemptId,
                    });
                    return { success: false, result, finalStatus: "DELIVERY_UNKNOWN" };
                }
                // Max attempts reached
                const jobCapped = await this.executionStore.updateJobStatus(jobId, "UNRESOLVABLE", fenceGeneration, {
                    lastError: `Max attempts (${job.maxAttempts}) reached with DELIVERY_UNKNOWN`,
                });
                if (!jobCapped)
                    return { success: false, finalStatus: "RUNNING" };
                return { success: false, result, finalStatus: "UNRESOLVABLE" };
        }
    }
    /**
     * INV-11: Result retrieval — observation, NOT re-execution.
     * Uses GET to query result without sending the original request again.
     *
     * F-02 fix (external audit 2026-10-25): a successful retrieval resolves the
     * DELIVERY_UNKNOWN attempt to SUCCESS through the dedicated atomic
     * resolveRetrievalSuccessIfOwner (attempt → SUCCESS + job → COMPLETED in
     * ONE transaction, fenced to this job). A REJECTED transition is never
     * reported as success — the job stays claimable and the next pass re-probes.
     *
     * F-06 fix: the HTTP-404 branch is bounded — no more infinite observation
     * loop. claimJob() increments current_attempt on every claim; once the job
     * exhausts maxAttempts it is closed as UNRESOLVABLE (an explicit, final
     * operational decision), otherwise requeued as PENDING for the next poll.
     */
    async performRetrieval(job, attempt, fenceGeneration) {
        const metadata = (job.metadata ?? {});
        const retrievalUrl = metadata.resultRetrievalEndpoint
            || this.config.resultRetrievalUrl
            || `${attempt.requestUrl ?? this.config.sellerUrl}/result/${attempt.executionId}`;
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
            // F-02: the ONLY legal path from DELIVERY_UNKNOWN to SUCCESS — atomic,
            // jobId-fenced, proof attached. Stores without the method fall back to
            // updateAttemptStatus, which correctly REJECTS the terminal transition;
            // in that case we must NOT complete the job nor report success.
            const resolved = typeof this.executionStore.resolveRetrievalSuccessIfOwner === "function"
                ? await this.executionStore.resolveRetrievalSuccessIfOwner(job.jobId, attempt.attemptId, fenceGeneration, {
                    responseStatusCode: result.statusCode,
                    responseBody: result.body,
                    completedAt: Date.now(),
                })
                : await this.executionStore.updateAttemptStatus(attempt.attemptId, "SUCCESS", fenceGeneration, {
                    responseStatusCode: result.statusCode,
                    responseBody: result.body,
                    completedAt: Date.now(),
                }, job.jobId);
            if (!resolved) {
                await this.appendEvidence(job.operationId, "RETRIEVAL_SUCCESS_NOT_COMMITTED", {
                    jobId: job.jobId,
                    attemptId: attempt.attemptId,
                    note: "Attempt transition DELIVERY_UNKNOWN→SUCCESS was rejected — outcome NOT published",
                });
                return { success: false, finalStatus: "RUNNING" };
            }
            return { success: true, finalStatus: "SUCCESS" };
        }
        if (result.kind === "HTTP_FAILURE" && result.statusCode === 404) {
            // F-06: bounded observation. The result is not available YET — but the
            // job must not circle PENDING forever. currentAttempt counts claims;
            // when the bound is exhausted, close the job explicitly.
            if (job.currentAttempt >= job.maxAttempts) {
                const jobUnresolvable = await this.executionStore.updateJobStatus(job.jobId, "UNRESOLVABLE", fenceGeneration, {
                    lastError: `Retrieval exhausted maxAttempts (${job.maxAttempts}) — result still unavailable (404)`,
                });
                if (!jobUnresolvable)
                    return { success: false, finalStatus: "RUNNING" };
                await this.appendEvidence(job.operationId, "RETRIEVAL_UNRESOLVABLE", {
                    jobId: job.jobId,
                    reason: `Result unavailable after ${job.currentAttempt} observation attempts (404)`,
                });
                return { success: false, finalStatus: "UNRESOLVABLE" };
            }
            const requeued = await this.executionStore.updateJobStatus(job.jobId, "PENDING", fenceGeneration, {
                lockedBy: undefined,
                lockedUntil: undefined,
                lastError: `Result not found yet — observation ${job.currentAttempt}/${job.maxAttempts} (requeued with poll-interval backoff)`,
            });
            if (!requeued)
                return { success: false, finalStatus: "RUNNING" };
            return { success: false, finalStatus: "DELIVERY_UNKNOWN" };
        }
        // Other failures
        const jobFailed = await this.executionStore.updateJobStatus(job.jobId, "UNRESOLVABLE", fenceGeneration, {
            lastError: `Retrieval failed: ${result.kind}`,
        });
        if (!jobFailed)
            return { success: false, finalStatus: "RUNNING" };
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
    /**
     * R0 repair: SETTLED-intent obligation scanner.
     *
     * Finds payment intents that reached SETTLED (by the synchronous execute()
     * path or by the background ReconciliationWorker) but have NO durable
     * EXECUTION job, and creates one:
     *   - no attempt at all  → initiateExecution() (atomic attempt+job, F-001);
     *   - attempt without job (legacy orphan) → the missing job is created and
     *     linked to the surviving attempt (repair, F-001) instead of skipping.
     *
     * Why this exists: the settlement→execution handoff has two owners —
     *   (a) StateMachine.persistSettlementAndExecutionObligation (atomic, only
     *       when settlement happens inside execute()), and
     *   (b) nobody — for payments settled by the ReconciliationWorker after
     *       execute() returned.
     * This scanner closes case (b) and crash windows between settlement and
     * handoff. Idempotent: the (operation_id WHERE job_type='EXECUTION') unique
     * index blocks duplicates under concurrent scanners.
     */
    async ensureExecutionObligations() {
        const scanner = this.paymentStore;
        if (typeof scanner.getSettledIntentsWithoutObligation !== "function") {
            return []; // store does not support scanning (e.g. in-memory test stores)
        }
        const settled = await scanner.getSettledIntentsWithoutObligation();
        const created = [];
        for (const intent of settled) {
            try {
                // F-001 (external audit Blocker): the scanner selects SETTLED intents
                // by a MISSING EXECUTION job. An intent that already has an attempt
                // (a legacy orphan from a crash between the two unfenced writes) must
                // be RECONCILED — the missing job is created and linked to the
                // surviving attempt — never silently excluded forever.
                let existingAttempt = null;
                if (typeof this.executionStore.getAttemptsByOperation === "function") {
                    try {
                        const attempts = await this.executionStore.getAttemptsByOperation(intent.operationId);
                        if (Array.isArray(attempts) && attempts.length > 0) {
                            existingAttempt = attempts[attempts.length - 1];
                        }
                    }
                    catch { /* fall through and attempt idempotent creation */ }
                }
                if (existingAttempt) {
                    // Legacy orphan repair: attempt survived, job did not.
                    //  - non-terminal attempt → PENDING job: the worker resumes the
                    //    obligation and processes the surviving attempt;
                    //  - terminal attempt    → COMPLETED marker job: the delivery
                    //    already concluded, the marker documents it and releases the
                    //    intent from future scanner windows without re-execution.
                    const terminalAttemptStates = ["SUCCESS", "HTTP_FAILURE", "DELIVERY_UNKNOWN", "UNRESOLVABLE"];
                    const now = Date.now();
                    const repairJob = {
                        jobId: `job-${now}-${randomUUID()}`,
                        operationId: intent.operationId,
                        jobType: "EXECUTION",
                        status: terminalAttemptStates.includes(existingAttempt.status) ? "COMPLETED" : "PENDING",
                        priority: 0,
                        maxAttempts: this.config.maxExecutionAttempts,
                        currentAttempt: 0,
                        metadata: {
                            capability: "EXECUTION_IDEMPOTENT",
                            repairedLegacyOrphan: true,
                            linkedAttemptId: existingAttempt.attemptId,
                            linkedAttemptStatus: existingAttempt.status,
                        },
                        createdAt: now,
                        updatedAt: now,
                    };
                    await this.executionStore.saveJob(repairJob);
                    created.push(`${intent.operationId}:${repairJob.jobId}:repaired`);
                    await this.appendEvidence(intent.operationId, "EXECUTION_OBLIGATION_REPAIRED", {
                        jobId: repairJob.jobId,
                        linkedAttemptId: existingAttempt.attemptId,
                        linkedAttemptStatus: existingAttempt.status,
                    });
                    continue;
                }
                const { jobId } = await this.initiateExecution(intent.operationId, "EXECUTION_IDEMPOTENT");
                created.push(`${intent.operationId}:${jobId}`);
            }
            catch {
                // Duplicate obligation race (unique index) or transient store error —
                // the next scan cycle will retry what actually failed.
            }
        }
        return created;
    }
    async appendEvidence(operationId, event, payload) {
        // F-111 (external audit 2026-10-26): assign the same Repair-C3
        // per-operation sequence the state machine uses. The engine appends
        // directly to the durable store, so the next free slot is derived from
        // the durable evidence view; on a read failure the record is still
        // appended WITHOUT a sequence (legacy payload-hash identity — correct,
        // just weaker ordering) rather than blocking execution evidence.
        let sequence;
        try {
            if (typeof this.paymentStore.getEvidence === "function") {
                const existing = await this.paymentStore.getEvidence(operationId);
                sequence = Array.isArray(existing) ? existing.length : undefined;
            }
        }
        catch {
            sequence = undefined;
        }
        await this.paymentStore.append({
            operationId,
            phase: "EXECUTION",
            timestamp: Date.now(),
            event,
            payload,
            sequence,
        });
    }
}
//# sourceMappingURL=post-settlement-engine.js.map