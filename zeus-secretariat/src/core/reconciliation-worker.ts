/**
 * BLOCK 8.2-B.3-B2-WORKER: Durable Reconciliation Worker
 *
 * Production-safe polling worker that processes reconciliation_jobs
 * via lease-safe atomic operations. Coexists with recoverAfterCrash().
 *
 * Lifecycle: poll → discover → claim → load DPI → reconcile → map outcome → release lease
 */

import type { DurableEvidenceStore, DurablePaymentIntent } from './types.js';
import type { ReconciliationEngine, ReconciliationOutcome } from './reconciliation-engine.js';
import { SettlementFeedbackService } from './settlement-feedback-service.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

const DEFAULT_CONFIG = {
  pollIntervalMs: 5_000,
  leaseDurationMs: 30_000,
  errorBackoffMs: 10_000,
  batchSize: 100,
} as const;

// Terminal settlement states — no further reconciliation needed
const TERMINAL_STATES = new Set(["SETTLED", "NOT_SETTLED", "UNRESOLVED_MANUAL", "INCIDENT"]);

// ---------------------------------------------------------------------------
// Worker Identity
// ---------------------------------------------------------------------------

function resolveWorkerId(configured?: string): string {
  if (configured) return configured;
  try {
    // Prefer env variable
    if (typeof process !== "undefined" && process.env?.WORKER_ID) {
      return process.env.WORKER_ID;
    }
    // Fallback: hostname-pid-timestamp
    const host = typeof process !== "undefined" ? (process.env?.HOSTNAME ?? "unknown") : "unknown";
    const pid = typeof process !== "undefined" ? process.pid : 0;
    return `worker-${host}-${pid}-${Date.now()}`;
  } catch {
    return `worker-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// ---------------------------------------------------------------------------
// Sleep utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ReconciliationWorker
// ---------------------------------------------------------------------------

export class ReconciliationWorker {
  private readonly store: DurableEvidenceStore;
  private readonly engine: ReconciliationEngine;
  private readonly config: Required<ReconciliationWorkerConfig>;
  private readonly workerId: string;
  private running = false;
  private processing = false;

  constructor(
    store: DurableEvidenceStore,
    engine: ReconciliationEngine,
    config?: ReconciliationWorkerConfig,
  ) {
    this.store = store;
    this.engine = engine;
    // Resolve workerId first so config object satisfies Required<> fully
    const resolvedWorkerId = resolveWorkerId(config?.workerId);
    this.workerId = resolvedWorkerId;
    this.config = {
      pollIntervalMs: config?.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
      leaseDurationMs: config?.leaseDurationMs ?? DEFAULT_CONFIG.leaseDurationMs,
      errorBackoffMs: config?.errorBackoffMs ?? DEFAULT_CONFIG.errorBackoffMs,
      batchSize: config?.batchSize ?? DEFAULT_CONFIG.batchSize,
      workerId: resolvedWorkerId,
    };
  }

  /** Start the polling loop. Idempotent — repeated calls do not create duplicate loops. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
  }

  /** Graceful stop: prevents new poll iterations, waits for current job to finish. */
  async stop(): Promise<void> {
    this.running = false;
    // Wait for current processing to complete
    while (this.processing) {
      await sleep(100);
    }
  }

  get isRunning(): boolean { return this.running; }
  get id(): string { return this.workerId; }

  // -------------------------------------------------------------------------
  // Polling Loop
  // -------------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.running) {
      this.processing = true;
      try {
        await this.processBatch();
      } catch (err) {
        // Top-level batch error — log and continue after interval
        console.error("[ReconciliationWorker] Batch error:", err);
      } finally {
        this.processing = false;
      }

      if (!this.running) break;
      await sleep(this.config.pollIntervalMs);
    }
  }

  private async processBatch(): Promise<void> {
    // R7-C2 (external audit 2026-10-26): the configured batchSize was accepted
    // but never used — every poll always scanned the store's hardcoded LIMIT.
    const jobs = await this.store.getDueReconciliationJobs(this.config.batchSize);

    for (const job of jobs) {
      if (!this.running) break;
      await this.processJob(job.jobId, job.paymentIntentId);
    }
  }

  // -------------------------------------------------------------------------
  // Single Job Processing
  // -------------------------------------------------------------------------

  private async processJob(jobId: string, paymentIntentId: string): Promise<void> {
    // PENDING_SIGNATURE is a passive pre-signature boundary, not a
    // reconciliation attempt. Check it before claim because claim increments
    // the durable probe counter.
    const preflightDpi = await this.loadDpi(paymentIntentId);
    if (preflightDpi?.settlementState === "PENDING_SIGNATURE") {
      await this.safeCompletePendingSignatureJob(jobId);
      return;
    }

    // Step 1: Atomic claim
    const claimed = await this.store.claimReconciliationJob(
      jobId, this.workerId, this.config.leaseDurationMs,
    );
    if (!claimed) return; // Another worker got it

    try {
      // Step 2: Load DPI
      const dpi = await this.loadDpi(paymentIntentId);

      if (!dpi) {
        // DPI missing — cannot reconcile, fail the job
        await this.safeFail(jobId, `DPI not found for paymentIntentId=${paymentIntentId}`);
        return;
      }

      // Step 3: Terminal DPI short-circuit
      if (TERMINAL_STATES.has(dpi.settlementState)) {
        await this.safeComplete(jobId);
        return;
      }

      // Step 3.5: B.3-B2-WIRING — Sync canonical probe count from job to DPI.
      // job.probe_count (incremented at claim) is the authoritative scheduling counter.
      // DPI.probeCount is a derived cache that ReconciliationEngine.getNextProbeDelay() reads.
      //
      // R7-C2 (external audit 2026-10-26): the previous sync re-read the job
      // from getDueReconciliationJobs() AFTER claiming it — but a freshly
      // claimed RUNNING job is by definition not due, so the lookup ALWAYS
      // missed and DPI.probeCount was pinned to 1: the engine's backoff
      // schedule never grew. The claimed job is now read back directly via
      // the optional getReconciliationJobById primitive.
      try {
        const extStore = this.store as DurableEvidenceStore & Partial<{
          updatePaymentIntentProbeCount(id: string, count: number): Promise<void>;
          getReconciliationJobById(jobId: string): Promise<{ probeCount: number } | null>;
        }>;
        if (
          typeof extStore.updatePaymentIntentProbeCount === "function" &&
          typeof extStore.getReconciliationJobById === "function"
        ) {
          const claimedJob = await extStore.getReconciliationJobById(jobId);
          // claimReconciliationJob incremented probe_count atomically before
          // this read; a missing row means the job vanished — fall back to 1.
          const jobProbeCount = claimedJob?.probeCount ?? 1;
          await extStore.updatePaymentIntentProbeCount(paymentIntentId, jobProbeCount);
        }
      } catch (syncErr) {
        // Probe count sync failure is non-fatal — engine will use potentially stale
        // DPI.probeCount, resulting in slightly wrong backoff but not data corruption.
        console.warn(`[ReconciliationWorker] Probe count sync failed for ${paymentIntentId}:`, syncErr);
      }

      // Step 4: Reconcile
      const outcome = await this.engine.reconcile(paymentIntentId);

      // Step 5: Map outcome to job lifecycle (and feed the Operation FSM — R7-A7)
      await this.mapOutcome(jobId, outcome, dpi);

    } catch (err) {
      // Unexpected exception — reschedule with error backoff
      // Do NOT mark as terminal; this is a transient operational failure
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.safeReschedule(
        jobId,
        new Date(Date.now() + this.config.errorBackoffMs),
      );
      console.error(`[ReconciliationWorker] Job ${jobId} exception:`, errorMsg);
    }
  }

  // -------------------------------------------------------------------------
  // Outcome Mapping
  // -------------------------------------------------------------------------

  private async mapOutcome(
    jobId: string,
    outcome: ReconciliationOutcome,
    dpi?: DurablePaymentIntent | null,
  ): Promise<void> {
    // R7-A7 (external audit 2026-10-26, Critical): feed the outcome back into
    // the Operation FSM. Previously only the JOB lifecycle was closed here,
    // so an asynchronously settled operation stayed in SETTLEMENT_PENDING
    // (public status PROCESSING) forever. Feedback runs BEFORE the job
    // closure and is non-fatal: a feedback failure must never lose the job
    // bookkeeping (the operation can be repaired by the next probe/scanner).
    if (dpi?.operationId) {
      try {
        const feedback = new SettlementFeedbackService(this.store);
        const result = await feedback.applyOutcome(dpi.operationId, outcome, {
          paymentIntentId: dpi.paymentIntentId,
        });
        if (result.applied) {
          console.info(
            `[ReconciliationWorker] Settlement feedback applied: operation=${dpi.operationId} -> ${result.currentState} (${outcome.status})`,
          );
        }
      } catch (feedbackErr) {
        console.warn(
          `[ReconciliationWorker] Settlement feedback failed for operation=${dpi.operationId}:`,
          feedbackErr instanceof Error ? feedbackErr.message : feedbackErr,
        );
      }
    }

    switch (outcome.status) {
      case "SETTLED":
      case "NOT_SETTLED":
        await this.safeComplete(jobId);
        break;

      case "RECONCILING": {
        const nextProbeMs = outcome.nextProbeMs ?? this.config.errorBackoffMs;
        const nextProbeAt = new Date(Date.now() + nextProbeMs);
        await this.safeReschedule(jobId, nextProbeAt);
        break;
      }

      case "UNRESOLVED_MANUAL":
      case "INCIDENT":
        await this.safeFail(jobId, outcome.reason);
        break;

      default:
        // Unknown outcome status — reschedule defensively
        await this.safeReschedule(
          jobId,
          new Date(Date.now() + this.config.errorBackoffMs),
        );
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Safe Lifecycle Operations (ownership-aware, non-throwing)
  // -------------------------------------------------------------------------

  private async loadDpi(paymentIntentId: string): Promise<DurablePaymentIntent | null> {
    // Use getPaymentIntentByOperationId or equivalent lookup.
    // DurableEvidenceStore may expose getPaymentIntentById via Partial extension.
    const extStore = this.store as DurableEvidenceStore & Partial<{
      getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null>;
    }>;
    if (typeof extStore.getPaymentIntentById === "function") {
      return extStore.getPaymentIntentById(paymentIntentId);
    }
    // Fallback: scan by operationId is not available here; return null
    return null;
  }

  private async safeComplete(jobId: string): Promise<void> {
    const ok = await this.store.completeReconciliationJob(jobId, this.workerId);
    if (!ok) {
      console.warn(`[ReconciliationWorker] Lost ownership completing job ${jobId}`);
    }
  }

  private async safeCompletePendingSignatureJob(jobId: string): Promise<void> {
    const extStore = this.store as DurableEvidenceStore & Partial<{
      completePendingReconciliationJob(id: string): Promise<boolean>;
      updateReconciliationJob(
        id: string,
        updates: { status?: string; nextProbeAt?: Date; lastError?: string; probeCount?: number },
      ): Promise<void>;
    }>;

    if (typeof extStore.completePendingReconciliationJob === "function") {
      const ok = await extStore.completePendingReconciliationJob(jobId);
      if (!ok) {
        console.warn(`[ReconciliationWorker] Pending-signature job ${jobId} was not completed`);
      }
      return;
    }

    // Compatibility fallback for stores that expose the existing lifecycle
    // update primitive but not the atomic pending-signature helper yet.
    if (typeof extStore.updateReconciliationJob === "function") {
      await extStore.updateReconciliationJob(jobId, { status: "COMPLETED" });
      return;
    }

    console.warn(
      `[ReconciliationWorker] Cannot retire pending-signature job ${jobId}: store lacks a completion primitive`,
    );
  }

  private async safeReschedule(jobId: string, nextProbeAt: Date): Promise<void> {
    const ok = await this.store.rescheduleReconciliationJob(jobId, this.workerId, nextProbeAt);
    if (!ok) {
      console.warn(`[ReconciliationWorker] Lost ownership rescheduling job ${jobId}`);
    }
  }

  private async safeFail(jobId: string, error: string): Promise<void> {
    const ok = await this.store.failReconciliationJob(jobId, this.workerId, error);
    if (!ok) {
      console.warn(`[ReconciliationWorker] Lost ownership failing job ${jobId}`);
    }
  }
}
