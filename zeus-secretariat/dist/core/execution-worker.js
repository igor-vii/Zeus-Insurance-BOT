/**
 * A1-A: Production Execution Worker (polling consumer/dispatcher for recovery_jobs)
 *
 * Closes the proven audit gap (A1 Finding #1): after settlement,
 * recovery_jobs(EXECUTION, PENDING) rows are created and a working
 * PostSettlementEngine.processJob() exists — but production runtime had NO
 * permanent consumer draining those jobs.
 *
 * This worker uses ONLY existing infrastructure:
 *   executionStore.getPendingJobs() → claim/lease/fencing (inside processJob)
 *   → PostSettlementEngine.processJob(jobId) → ExecutionFeedbackService (A1-B).
 *
 * No new queue, no new schema, no new execution mechanism.
 * Lifecycle mirrors ReconciliationWorker (start/stop idempotent polling loop).
 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 100;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class ExecutionWorker {
    engine;
    store;
    feedback;
    pollIntervalMs;
    batchSize;
    running = false;
    processing = false;
    /**
     * F-15 fix (external audit 2026-10-25): consecutive failures of the
     * SETTLED-intent obligation scanner. The scanner is the safety net that
     * finds settled payments without an execution obligation — a PERSISTENT
     * failure here means settled payments silently stop being executed. It
     * must be observable, not swallowed.
     */
    consecutiveScannerFailures = 0;
    /** Alert threshold: after this many consecutive scanner failures, log CRIT. */
    static SCANNER_FAILURE_ALERT_THRESHOLD = 3;
    get scannerFailureCount() {
        return this.consecutiveScannerFailures;
    }
    constructor(engine, store, config) {
        this.engine = engine;
        this.store = store;
        this.feedback = config?.feedbackService ?? null;
        this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.batchSize = config?.batchSize ?? DEFAULT_BATCH_SIZE;
    }
    /** Start the polling loop. Idempotent — repeated calls do not create duplicate loops. */
    start() {
        if (this.running)
            return;
        this.running = true;
        void this.pollLoop();
    }
    /** Graceful stop: prevents new poll iterations, waits for current batch to finish. */
    async stop() {
        this.running = false;
        while (this.processing) {
            await sleep(50);
        }
    }
    get isRunning() {
        return this.running;
    }
    /**
     * Run exactly one poll iteration. Exposed for deterministic testing and
     * for shutdown-drain scenarios. Returns the number of jobs processed.
     */
    async runOnce() {
        // R0 repair: BEFORE draining pending jobs, make sure every SETTLED payment
        // intent has an EXECUTION obligation. Without this scan, a payment settled
        // by the background ReconciliationWorker (or after a crash between
        // settlement and handoff) would stay SETTLED forever — the seller would
        // never be called and the client would never receive the resource.
        // Best-effort + idempotent: stores without the scanner are skipped;
        // duplicate obligations are blocked by the DB unique index.
        try {
            await this.engine.ensureExecutionObligations?.();
            // F-15: success resets the failure streak — the streak measures
            // PERSISTENT scanner breakage, not one-off blips.
            this.consecutiveScannerFailures = 0;
        }
        catch (err) {
            // F-15: scanning is best-effort and job processing must proceed, but a
            // persistent scanner failure must be VISIBLE — settled payments would
            // silently stop being executed. Log loudly, count the streak, escalate
            // past the threshold.
            this.consecutiveScannerFailures++;
            if (this.consecutiveScannerFailures >= ExecutionWorker.SCANNER_FAILURE_ALERT_THRESHOLD) {
                console.error(`[ExecutionWorker] CRIT: ensureExecutionObligations failed ${this.consecutiveScannerFailures}x in a row — ` +
                    `settled payments may be missing execution obligations. Last error:`, err);
            }
            else {
                console.error(`[ExecutionWorker] ensureExecutionObligations failed (consecutive=${this.consecutiveScannerFailures}):`, err);
            }
        }
        const jobs = await this.store.getPendingJobs();
        let processed = 0;
        for (const job of jobs.slice(0, this.batchSize)) {
            if (!this.running && this.processingStartedByStart)
                break;
            await this.processOne(job);
            processed++;
        }
        return processed;
    }
    processingStartedByStart = false;
    async pollLoop() {
        this.processingStartedByStart = true;
        while (this.running) {
            this.processing = true;
            try {
                await this.runOnce();
            }
            catch (err) {
                console.error("[ExecutionWorker] Batch error:", err);
            }
            finally {
                this.processing = false;
            }
            if (!this.running)
                break;
            await sleep(this.pollIntervalMs);
        }
    }
    async processOne(job) {
        // Claim + fencing happen atomically inside processJob(). If the claim is
        // lost (claimJob() → null: another worker owns the job) or the job is
        // still in flight, processJob() returns finalStatus "RUNNING". Such a
        // no-op must be completely safe: NO FSM feedback, NO saveOperation,
        // NO evidence append (audit finding #1).
        const result = await this.engine.processJob(job.jobId);
        if (result.finalStatus === "RUNNING")
            return;
        // A1-B: feed the execution result back into the Operation FSM.
        if (this.feedback) {
            try {
                await this.feedback.applyResult(job.operationId, result.finalStatus, {
                    jobId: job.jobId,
                    statusCode: result.result?.kind === "SUCCESS" || result.result?.kind === "HTTP_FAILURE"
                        ? result.result.statusCode
                        : undefined,
                    reason: result.result?.kind === "DELIVERY_UNKNOWN" ? result.result.reason : undefined,
                });
            }
            catch (err) {
                // Feedback failure must not corrupt durable job state; the job itself
                // is already terminal-or-retryable. Log loudly — next iteration or
                // recoverPendingJobs() will re-drive feedback via idempotent apply.
                console.error(`[ExecutionWorker] FSM feedback failed for job ${job.jobId}:`, err);
            }
        }
    }
}
//# sourceMappingURL=execution-worker.js.map