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
import type { ExecutionStore } from "./post-settlement-engine.js";
import type { PostSettlementEngine } from "./post-settlement-engine.js";
import type { ExecutionFeedbackService } from "./execution-feedback-service.js";
export interface ExecutionWorkerConfig {
    /** Polling interval in milliseconds. Default: 5000 */
    pollIntervalMs?: number;
    /** Max jobs per poll batch. Default: 100 */
    batchSize?: number;
    /** Stable worker identity used for lease ownership inside processJob(). */
    workerId?: string;
}
export declare class ExecutionWorker {
    private readonly engine;
    private readonly store;
    private readonly feedback;
    private readonly pollIntervalMs;
    private readonly batchSize;
    private running;
    private processing;
    /**
     * F-15 fix (external audit 2026-10-25): consecutive failures of the
     * SETTLED-intent obligation scanner. The scanner is the safety net that
     * finds settled payments without an execution obligation — a PERSISTENT
     * failure here means settled payments silently stop being executed. It
     * must be observable, not swallowed.
     */
    private consecutiveScannerFailures;
    /** Alert threshold: after this many consecutive scanner failures, log CRIT. */
    private static readonly SCANNER_FAILURE_ALERT_THRESHOLD;
    get scannerFailureCount(): number;
    constructor(engine: PostSettlementEngine, store: ExecutionStore, config?: ExecutionWorkerConfig & {
        feedbackService?: ExecutionFeedbackService | null;
    });
    /** Start the polling loop. Idempotent — repeated calls do not create duplicate loops. */
    start(): void;
    /** Graceful stop: prevents new poll iterations, waits for current batch to finish. */
    stop(): Promise<void>;
    get isRunning(): boolean;
    /**
     * Run exactly one poll iteration. Exposed for deterministic testing and
     * for shutdown-drain scenarios. Returns the number of jobs processed.
     */
    runOnce(): Promise<number>;
    private processingStartedByStart;
    private pollLoop;
    private processOne;
}
//# sourceMappingURL=execution-worker.d.ts.map