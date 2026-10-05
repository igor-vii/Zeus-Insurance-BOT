/**
 * BLOCK 8.2-B.3-B2-WORKER: Durable Reconciliation Worker
 *
 * Production-safe polling worker that processes reconciliation_jobs
 * via lease-safe atomic operations. Coexists with recoverAfterCrash().
 *
 * Lifecycle: poll → discover → claim → load DPI → reconcile → map outcome → release lease
 */
import type { DurableEvidenceStore } from './types.js';
import type { ReconciliationEngine } from './reconciliation-engine.js';
export interface ReconciliationWorkerConfig {
    /** Polling interval in milliseconds. Default: 5000 */
    pollIntervalMs?: number;
    /** Lease duration in milliseconds. Must exceed max reconcile time. Default: 30000 */
    leaseDurationMs?: number;
    /** Backoff delay for transient exceptions. Default: 10000 */
    errorBackoffMs?: number;
    /** Max jobs per poll batch. Default: 100 */
    batchSize?: number;
    /** Stable worker identity for lease ownership. Auto-generated if not provided. */
    workerId?: string;
}
export declare class ReconciliationWorker {
    private readonly store;
    private readonly engine;
    private readonly config;
    private readonly workerId;
    private running;
    private processing;
    constructor(store: DurableEvidenceStore, engine: ReconciliationEngine, config?: ReconciliationWorkerConfig);
    /** Start the polling loop. Idempotent — repeated calls do not create duplicate loops. */
    start(): void;
    /** Graceful stop: prevents new poll iterations, waits for current job to finish. */
    stop(): Promise<void>;
    get isRunning(): boolean;
    get id(): string;
    private pollLoop;
    private processBatch;
    private processJob;
    private mapOutcome;
    private loadDpi;
    private safeComplete;
    private safeCompletePendingSignatureJob;
    private safeReschedule;
    private safeFail;
}
//# sourceMappingURL=reconciliation-worker.d.ts.map