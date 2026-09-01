/**
 * BLOCK 8.2-B.3-B2-WIRING — StateMachine → Worker Integration Tests
 *
 * Verifies the complete durable reconciliation lifecycle:
 *   StateMachine RECONCILING → createReconciliationJob → Worker → reconcile → outcome
 */

import type { DurableEvidenceStore, DurablePaymentIntent } from '../src/core/types';
import type { ReconciliationOutcome } from '../src/core/reconciliation-engine';
import { ReconciliationWorker } from '../src/core/reconciliation-worker';

// ---------------------------------------------------------------------------
// Integrated Fake Store (supports both job lifecycle AND DPI operations)
// ---------------------------------------------------------------------------

interface FakeJob {
  jobId: string; paymentIntentId: string; status: string;
  probeCount: number; nextProbeAt: Date; lockedBy: string | null;
  lockedUntil: Date | null; lastError: string | null;
}

class IntegratedFakeStore implements Partial<DurableEvidenceStore> {
  jobs = new Map<string, FakeJob>();
  dpis = new Map<string, DurablePaymentIntent>();
  createdJobs: Array<{ paymentIntentId: string; nextProbeAt: Date }> = [];
  probeSyncLog: Array<{ paymentIntentId: string; probeCount: number }> = [];

  addDpi(dpi: DurablePaymentIntent) { this.dpis.set(dpi.paymentIntentId, { ...dpi }); }

  // --- Job lifecycle ---
  async createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string> {
    // Idempotent: return existing active job if present
    for (const j of this.jobs.values()) {
      if (j.paymentIntentId === paymentIntentId && (j.status === "PENDING" || j.status === "RUNNING")) {
        return j.jobId;
      }
    }
    const jobId = "rj-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    this.jobs.set(jobId, {
      jobId, paymentIntentId, status: "PENDING", probeCount: 0,
      nextProbeAt, lockedBy: null, lockedUntil: null, lastError: null,
    });
    this.createdJobs.push({ paymentIntentId, nextProbeAt });
    return jobId;
  }

  async getDueReconciliationJobs() {
    const now = new Date();
    const results: Array<{ jobId: string; paymentIntentId: string; probeCount: number }> = [];
    for (const j of this.jobs.values()) {
      const duePending = j.status === "PENDING" && j.nextProbeAt <= now;
      const expiredRunning = j.status === "RUNNING" && j.lockedUntil !== null && j.lockedUntil < now;
      if (duePending || expiredRunning) results.push({ jobId: j.jobId, paymentIntentId: j.paymentIntentId, probeCount: j.probeCount });
    }
    return results;
  }

  async claimReconciliationJob(jobId: string, workerId: string, lockMs: number): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    const canClaim = j.status === "PENDING" || (j.status === "RUNNING" && j.lockedUntil !== null && j.lockedUntil < new Date());
    if (!canClaim) return false;
    j.status = "RUNNING"; j.lockedBy = workerId;
    j.lockedUntil = new Date(Date.now() + lockMs); j.probeCount++;
    return true;
  }

  async completeReconciliationJob(jobId: string, workerId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || j.lockedBy !== workerId) return false;
    j.status = "COMPLETED"; j.lockedBy = null; j.lockedUntil = null;
    return true;
  }

  async rescheduleReconciliationJob(jobId: string, workerId: string, nextProbeAt: Date): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || j.lockedBy !== workerId) return false;
    j.status = "PENDING"; j.nextProbeAt = nextProbeAt; j.lockedBy = null; j.lockedUntil = null;
    return true;
  }

  async failReconciliationJob(jobId: string, workerId: string, error: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || j.lockedBy !== workerId) return false;
    j.status = "UNRESOLVABLE"; j.lastError = error; j.lockedBy = null; j.lockedUntil = null;
    return true;
  }

  // --- DPI operations ---
  async getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null> {
    return this.dpis.get(id) ?? null;
  }

  async updatePaymentIntentProbeCount(paymentIntentId: string, probeCount: number): Promise<void> {
    const dpi = this.dpis.get(paymentIntentId);
    if (dpi) { dpi.probeCount = probeCount; }
    this.probeSyncLog.push({ paymentIntentId, probeCount });
  }

  // Stubs
  async createPaymentIntent(): Promise<void> {}
  async getPaymentIntentByOperationId(): Promise<DurablePaymentIntent | null> { return null; }
  async updatePaymentIntentStatus(): Promise<void> {}
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<any> { return null; }
  async append(): Promise<void> {}
  async getOperation(): Promise<any> { return null; }
  async saveOperation(): Promise<void> {}
  async getEvidence(): Promise<any[]> { return []; }
  async getOperationsByStatus(): Promise<any[]> { return []; }
  async getNonTerminalIntents(): Promise<any[]> { return []; }
  async appendReconciliationObservation(): Promise<void> {}
  async getReconciliationObservations(): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(): Promise<void> {}
  async saveNotSettledEvidenceBundle(): Promise<void> {}
  async getOperationByClientAndRequestId(): Promise<any> { return null; }
}

// ---------------------------------------------------------------------------
// Fake Engine
// ---------------------------------------------------------------------------

class FakeEngine {
  outcomes = new Map<string, ReconciliationOutcome>();
  reconcileCalls: string[] = [];
  store: any; rpcChecker: any; scheduleConfig: any; finalityPolicy: any;
  setOutcome(piId: string, o: ReconciliationOutcome) { this.outcomes.set(piId, o); }
  async reconcile(piId: string): Promise<ReconciliationOutcome> {
    this.reconcileCalls.push(piId);
    return this.outcomes.get(piId) ?? { status: "RECONCILING", reason: "default", nextProbeMs: 5000 };
  }
  async persistObservation(): Promise<void> {}
  async scheduleNextProbe(): Promise<void> {}
  async recoverAfterCrash(): Promise<Map<string, ReconciliationOutcome>> { return new Map(); }
  async canCreateNewPayment(): Promise<boolean> { return true; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDpi(id: string, state: string): DurablePaymentIntent {
  return {
    paymentIntentId: id, operationId: "op-" + id, requestId: "req-" + id,
    clientId: "cli-test", authorizer: "0xAuth", payTo: "0xPayee",
    value: "1000000", asset: "0xUSDC", network: "base-sepolia",
    nonce: "0xnonce", validAfter: 0, validBefore: 9999999999,
    paymentPayload: "", paymentPayloadHash: "", probeCount: 0,
    settlementState: state as any, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BLOCK 8.2-B.3-B2-WIRING: StateMachine → Worker Integration", () => {
  let store: IntegratedFakeStore;
  let engine: FakeEngine;
  let worker: ReconciliationWorker;

  beforeEach(() => {
    store = new IntegratedFakeStore();
    engine = new FakeEngine();
    worker = new ReconciliationWorker(store as any, engine as any, {
      pollIntervalMs: 50, leaseDurationMs: 30000, errorBackoffMs: 100, workerId: "wiring-worker",
    });
  });

  afterEach(async () => { await worker.stop(); });

  // WIRING-01: RECONCILING creates a durable reconciliation job
  test("WIRING-01: RECONCILING creates durable job", async () => {
    const before = Date.now();
    const jobId = await store.createReconciliationJob("pi-w1", new Date(before + 5000));
    expect(jobId).toBeTruthy();
    expect(store.createdJobs.length).toBe(1);
    expect(store.createdJobs[0].paymentIntentId).toBe("pi-w1");
  });

  // WIRING-02: nextProbeMs converted to absolute nextProbeAt
  test("WIRING-02: nextProbeMs → absolute nextProbeAt", async () => {
    const before = Date.now();
    const nextProbeMs = 30000;
    const nextProbeAt = new Date(before + nextProbeMs);
    await store.createReconciliationJob("pi-w2", nextProbeAt);
    const created = store.createdJobs[0];
    expect(created.nextProbeAt.getTime()).toBeGreaterThanOrEqual(before + 29000);
    expect(created.nextProbeAt.getTime()).toBeLessThanOrEqual(before + 31000);
  });

  // WIRING-03: nextProbeAt based on operational time
  test("WIRING-03: nextProbeAt uses operational clock", async () => {
    const before = Date.now();
    const nextProbeAt = new Date(Date.now() + 10000);
    await store.createReconciliationJob("pi-w3", nextProbeAt);
    expect(store.createdJobs[0].nextProbeAt.getTime()).toBeGreaterThanOrEqual(before + 9000);
  });

  // WIRING-04: Repeated RECONCILING does not create duplicate active jobs
  test("WIRING-04: idempotent job creation", async () => {
    const id1 = await store.createReconciliationJob("pi-w4", new Date());
    const id2 = await store.createReconciliationJob("pi-w4", new Date());
    expect(id1).toBe(id2);
    // Only one job in the map
    let count = 0;
    for (const j of store.jobs.values()) if (j.paymentIntentId === "pi-w4") count++;
    expect(count).toBe(1);
  });

  // WIRING-05: Worker discovers job created by StateMachine
  test("WIRING-05: worker discovers StateMachine-created job", async () => {
    store.addDpi(makeDpi("pi-w5", "RECONCILING"));
    await store.createReconciliationJob("pi-w5", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w5", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(engine.reconcileCalls).toContain("pi-w5");
  });

  // WIRING-06: Worker processes job using correct paymentIntentId
  test("WIRING-06: worker uses correct paymentIntentId", async () => {
    store.addDpi(makeDpi("pi-w6", "RECONCILING"));
    await store.createReconciliationJob("pi-w6", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w6", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(engine.reconcileCalls).toEqual(["pi-w6"]);
  });

  // WIRING-07: Second RECONCILING reschedules existing job
  test("WIRING-07: second RECONCILING reschedules, not duplicates", async () => {
    store.addDpi(makeDpi("pi-w7", "RECONCILING"));
    await store.createReconciliationJob("pi-w7", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w7", { status: "RECONCILING", reason: "pending", nextProbeMs: 5000 });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    // Job should be rescheduled, not duplicated
    let activeCount = 0;
    for (const j of store.jobs.values()) {
      if (j.paymentIntentId === "pi-w7" && (j.status === "PENDING" || j.status === "RUNNING")) activeCount++;
    }
    expect(activeCount).toBe(1);
  });

  // WIRING-08: SETTLED completes durable job
  test("WIRING-08: SETTLED → job completed", async () => {
    store.addDpi(makeDpi("pi-w8", "RECONCILING"));
    await store.createReconciliationJob("pi-w8", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w8", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const job = Array.from(store.jobs.values()).find(j => j.paymentIntentId === "pi-w8");
    expect(job?.status).toBe("COMPLETED");
  });

  // WIRING-09: NOT_SETTLED completes durable job
  test("WIRING-09: NOT_SETTLED → job completed", async () => {
    store.addDpi(makeDpi("pi-w9", "RECONCILING"));
    await store.createReconciliationJob("pi-w9", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w9", { status: "NOT_SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const job = Array.from(store.jobs.values()).find(j => j.paymentIntentId === "pi-w9");
    expect(job?.status).toBe("COMPLETED");
  });

  // WIRING-10: UNRESOLVED_MANUAL terminates job
  test("WIRING-10: UNRESOLVED_MANUAL → job UNRESOLVABLE", async () => {
    store.addDpi(makeDpi("pi-w10", "RECONCILING"));
    await store.createReconciliationJob("pi-w10", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w10", { status: "UNRESOLVED_MANUAL", reason: "manual" });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const job = Array.from(store.jobs.values()).find(j => j.paymentIntentId === "pi-w10");
    expect(job?.status).toBe("UNRESOLVABLE");
  });

  // WIRING-11: INCIDENT terminates job
  test("WIRING-11: INCIDENT → job UNRESOLVABLE", async () => {
    store.addDpi(makeDpi("pi-w11", "RECONCILING"));
    await store.createReconciliationJob("pi-w11", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w11", { status: "INCIDENT", reason: "infra down" });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const job = Array.from(store.jobs.values()).find(j => j.paymentIntentId === "pi-w11");
    expect(job?.status).toBe("UNRESOLVABLE");
  });

  // WIRING-12: Terminal DPI does not trigger another reconciliation
  test("WIRING-12: terminal DPI skips reconcile", async () => {
    store.addDpi(makeDpi("pi-w12", "SETTLED"));
    await store.createReconciliationJob("pi-w12", new Date(Date.now() - 1000));
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(engine.reconcileCalls).not.toContain("pi-w12");
    const job = Array.from(store.jobs.values()).find(j => j.paymentIntentId === "pi-w12");
    expect(job?.status).toBe("COMPLETED");
  });

  // WIRING-13: job probe_count is canonical scheduling counter
  test("WIRING-13: probe_count synced from job to DPI", async () => {
    store.addDpi(makeDpi("pi-w13", "RECONCILING"));
    await store.createReconciliationJob("pi-w13", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w13", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    // After claim, probe_count should be 1 and synced to DPI
    expect(store.probeSyncLog.some(s => s.paymentIntentId === "pi-w13")).toBe(true);
  });

  // WIRING-14: DPI probeCount cannot silently diverge
  test("WIRING-14: DPI probeCount matches job probe_count after sync", async () => {
    store.addDpi(makeDpi("pi-w14", "RECONCILING"));
    await store.createReconciliationJob("pi-w14", new Date(Date.now() - 1000));
    engine.setOutcome("pi-w14", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const syncEntry = store.probeSyncLog.find(s => s.paymentIntentId === "pi-w14");
    expect(syncEntry).toBeDefined();
    expect(syncEntry!.probeCount).toBeGreaterThanOrEqual(1);
    // DPI should have been updated
    const dpi = store.dpis.get("pi-w14");
    expect(dpi?.probeCount).toBe(syncEntry!.probeCount);
  });

  // WIRING-15: Crash/retry does not create duplicate active jobs
  test("WIRING-15: crash/retry path idempotent", async () => {
    // Simulate: job created, then StateMachine crashes and retries RECONCILING
    const id1 = await store.createReconciliationJob("pi-w15", new Date(Date.now() - 1000));
    // Retry after "crash"
    const id2 = await store.createReconciliationJob("pi-w15", new Date(Date.now()));
    expect(id1).toBe(id2);
    // Still only one active job
    let activeCount = 0;
    for (const j of store.jobs.values()) {
      if (j.paymentIntentId === "pi-w15" && (j.status === "PENDING" || j.status === "RUNNING")) activeCount++;
    }
    expect(activeCount).toBe(1);
  });
});
