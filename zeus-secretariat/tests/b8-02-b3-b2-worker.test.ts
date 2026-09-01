/**
 * BLOCK 8.2-B.3-B2-WORKER — Durable Reconciliation Worker Tests
 *
 * Tests worker orchestration contract using deterministic fake store/engine.
 */

import type { DurableEvidenceStore, DurablePaymentIntent } from '../src/core/types';
import type { ReconciliationEngine, ReconciliationOutcome } from '../src/core/reconciliation-engine';
import { ReconciliationWorker } from '../src/core/reconciliation-worker';

// ---------------------------------------------------------------------------
// Fake Store
// ---------------------------------------------------------------------------

interface FakeJob {
  jobId: string; paymentIntentId: string; status: string;
  probeCount: number; nextProbeAt: Date; lockedBy: string | null;
  lockedUntil: Date | null; lastError: string | null;
}

class FakeStore implements Partial<DurableEvidenceStore> {
  jobs = new Map<string, FakeJob>();
  dpis = new Map<string, DurablePaymentIntent>();
  claimLog: string[] = [];
  completeLog: Array<{ jobId: string; workerId: string }> = [];
  rescheduleLog: Array<{ jobId: string; workerId: string; nextProbeAt: Date }> = [];
  failLog: Array<{ jobId: string; workerId: string; error: string }> = [];

  addJob(job: FakeJob) { this.jobs.set(job.jobId, job); }
  addDpi(dpi: DurablePaymentIntent) { this.dpis.set(dpi.paymentIntentId, dpi); }

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
    const now = new Date();
    const canClaim = j.status === "PENDING" || (j.status === "RUNNING" && j.lockedUntil !== null && j.lockedUntil < now);
    if (!canClaim) return false;
    j.status = "RUNNING"; j.lockedBy = workerId;
    j.lockedUntil = new Date(Date.now() + lockMs); j.probeCount++;
    this.claimLog.push(jobId);
    return true;
  }

  async completeReconciliationJob(jobId: string, workerId: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || j.lockedBy !== workerId) return false;
    j.status = "COMPLETED"; j.lockedBy = null; j.lockedUntil = null;
    this.completeLog.push({ jobId, workerId });
    return true;
  }

  async rescheduleReconciliationJob(jobId: string, workerId: string, nextProbeAt: Date): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || j.lockedBy !== workerId) return false;
    j.status = "PENDING"; j.nextProbeAt = nextProbeAt; j.lockedBy = null; j.lockedUntil = null;
    this.rescheduleLog.push({ jobId, workerId, nextProbeAt });
    return true;
  }

  async failReconciliationJob(jobId: string, workerId: string, error: string): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || j.lockedBy !== workerId) return false;
    j.status = "UNRESOLVABLE"; j.lastError = error; j.lockedBy = null; j.lockedUntil = null;
    this.failLog.push({ jobId, workerId, error });
    return true;
  }

  async getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null> {
    return this.dpis.get(id) ?? null;
  }

  // Stubs for unused interface methods
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
  async createReconciliationJob(): Promise<string> { return ""; }
}

// ---------------------------------------------------------------------------
// Fake ReconciliationEngine
// ---------------------------------------------------------------------------

class FakeEngine {
  outcomes = new Map<string, ReconciliationOutcome>();
  reconcileCalls: string[] = [];
  shouldThrow = false;

  setOutcome(paymentIntentId: string, outcome: ReconciliationOutcome) {
    this.outcomes.set(paymentIntentId, outcome);
  }

  async reconcile(paymentIntentId: string): Promise<ReconciliationOutcome> {
    this.reconcileCalls.push(paymentIntentId);
    if (this.shouldThrow) throw new Error("transient RPC failure");
    return this.outcomes.get(paymentIntentId) ?? { status: "RECONCILING", reason: "default", nextProbeMs: 5000 };
  }

  // Stubs
  store: any; rpcChecker: any; scheduleConfig: any; finalityPolicy: any;
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
    paymentPayload: "", paymentPayloadHash: "",
    settlementState: state as any, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function makeJob(id: string, piId: string, nextProbeAt?: Date): FakeJob {
  return {
    jobId: id, paymentIntentId: piId, status: "PENDING", probeCount: 0,
    nextProbeAt: nextProbeAt ?? new Date(Date.now() - 1000),
    lockedBy: null, lockedUntil: null, lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BLOCK 8.2-B.3-B2-WORKER: Reconciliation Worker", () => {
  let store: FakeStore;
  let engine: FakeEngine;
  let worker: ReconciliationWorker;

  beforeEach(() => {
    store = new FakeStore();
    engine = new FakeEngine();
    worker = new ReconciliationWorker(store as any, engine as any, {
      pollIntervalMs: 50, leaseDurationMs: 30000, errorBackoffMs: 100, workerId: "test-worker",
    });
  });

  afterEach(async () => { await worker.stop(); });

  // --- Discovery / Claim ---

  test("W1: due PENDING job gets claimed and processed", async () => {
    store.addJob(makeJob("j1", "pi1"));
    store.addDpi(makeDpi("pi1", "SETTLEMENT_PENDING"));
    engine.setOutcome("pi1", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.claimLog).toContain("j1");
    expect(store.completeLog.some(c => c.jobId === "j1")).toBe(true);
  });

  test("W2: concurrent worker loses claim", async () => {
    const job = makeJob("j2", "pi2");
    job.status = "RUNNING"; job.lockedBy = "other-worker";
    job.lockedUntil = new Date(Date.now() + 60000);
    store.addJob(job);
    store.addDpi(makeDpi("pi2", "RECONCILING"));
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.claimLog).not.toContain("j2");
  });

  test("W3: expired RUNNING job gets reclaimed", async () => {
    const job = makeJob("j3", "pi3");
    job.status = "RUNNING"; job.lockedBy = "dead-worker";
    job.lockedUntil = new Date(Date.now() - 1000); // expired
    store.addJob(job);
    store.addDpi(makeDpi("pi3", "SETTLEMENT_PENDING"));
    engine.setOutcome("pi3", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.claimLog).toContain("j3");
  });

  test("W4: future PENDING job is ignored", async () => {
    store.addJob(makeJob("j4", "pi4", new Date(Date.now() + 60000)));
    store.addDpi(makeDpi("pi4", "RECONCILING"));
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.claimLog).not.toContain("j4");
  });

  // --- Terminal DPI ---

  test("W5: terminal DPI does not call reconcile", async () => {
    store.addJob(makeJob("j5", "pi5"));
    store.addDpi(makeDpi("pi5", "SETTLED"));
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(engine.reconcileCalls).not.toContain("pi5");
  });

  test("W6: terminal DPI completes job", async () => {
    store.addJob(makeJob("j6", "pi6"));
    store.addDpi(makeDpi("pi6", "NOT_SETTLED"));
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.completeLog.some(c => c.jobId === "j6")).toBe(true);
  });

  // --- Outcomes ---

  test("W7: SETTLED completes job", async () => {
    store.addJob(makeJob("j7", "pi7"));
    store.addDpi(makeDpi("pi7", "RECONCILING"));
    engine.setOutcome("pi7", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.completeLog.some(c => c.jobId === "j7")).toBe(true);
  });

  test("W8: NOT_SETTLED completes job", async () => {
    store.addJob(makeJob("j8", "pi8"));
    store.addDpi(makeDpi("pi8", "RECONCILING"));
    engine.setOutcome("pi8", { status: "NOT_SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.completeLog.some(c => c.jobId === "j8")).toBe(true);
  });

  test("W9: RECONCILING reschedules job", async () => {
    store.addJob(makeJob("j9", "pi9"));
    store.addDpi(makeDpi("pi9", "RECONCILING"));
    engine.setOutcome("pi9", { status: "RECONCILING", reason: "pending", nextProbeMs: 5000 });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.rescheduleLog.some(r => r.jobId === "j9")).toBe(true);
  });

  test("W10: nextProbeMs converted to absolute nextProbeAt", async () => {
    store.addJob(makeJob("j10", "pi10"));
    store.addDpi(makeDpi("pi10", "RECONCILING"));
    engine.setOutcome("pi10", { status: "RECONCILING", reason: "pending", nextProbeMs: 60000 });
    const before = Date.now();
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const entry = store.rescheduleLog.find(r => r.jobId === "j10");
    expect(entry).toBeDefined();
    // nextProbeAt should be approximately now + 60000
    expect(entry!.nextProbeAt.getTime()).toBeGreaterThanOrEqual(before + 59000);
    expect(entry!.nextProbeAt.getTime()).toBeLessThanOrEqual(before + 62000);
  });

  test("W11: UNRESOLVED_MANUAL fails job", async () => {
    store.addJob(makeJob("j11", "pi11"));
    store.addDpi(makeDpi("pi11", "RECONCILING"));
    engine.setOutcome("pi11", { status: "UNRESOLVED_MANUAL", reason: "manual review needed" });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.failLog.some(f => f.jobId === "j11" && f.error === "manual review needed")).toBe(true);
  });

  test("W12: INCIDENT fails job", async () => {
    store.addJob(makeJob("j12", "pi12"));
    store.addDpi(makeDpi("pi12", "RECONCILING"));
    engine.setOutcome("pi12", { status: "INCIDENT", reason: "RPC infrastructure down" });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.failLog.some(f => f.jobId === "j12")).toBe(true);
  });

  // --- Error Handling ---

  test("W13: reconcile exception reschedules with error backoff", async () => {
    store.addJob(makeJob("j13", "pi13"));
    store.addDpi(makeDpi("pi13", "RECONCILING"));
    engine.shouldThrow = true;
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.rescheduleLog.some(r => r.jobId === "j13")).toBe(true);
    // Should NOT be in fail log
    expect(store.failLog.some(f => f.jobId === "j13")).toBe(false);
  });

  test("W14: error does not mark job terminal", async () => {
    store.addJob(makeJob("j14", "pi14"));
    store.addDpi(makeDpi("pi14", "RECONCILING"));
    engine.shouldThrow = true;
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    const job = store.jobs.get("j14")!;
    expect(job.status).toBe("PENDING"); // rescheduled, not terminal
  });

  test("W15: ownership loss does not mutate job again", async () => {
    // Simulate: claim succeeds but reschedule fails (lost lease)
    store.addJob(makeJob("j15", "pi15"));
    store.addDpi(makeDpi("pi15", "RECONCILING"));
    engine.setOutcome("pi15", { status: "RECONCILING", reason: "pending", nextProbeMs: 5000 });
    // Override reschedule to simulate ownership loss
    store.rescheduleReconciliationJob = async () => false;
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    // Job should still be RUNNING (claim succeeded, reschedule failed silently)
    // Worker did not force-update or retry
    const job = store.jobs.get("j15")!;
    expect(job.status).toBe("RUNNING");
  });

  // --- Crash/Recovery Semantics ---

  test("W16: DPI becomes terminal before completion — next worker completes", async () => {
    // Simulate: job was RUNNING, DPI became SETTLED externally
    const job = makeJob("j16", "pi16");
    job.status = "RUNNING"; job.lockedBy = "dead-worker";
    job.lockedUntil = new Date(Date.now() - 1000);
    store.addJob(job);
    store.addDpi(makeDpi("pi16", "SETTLED")); // Already terminal
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(engine.reconcileCalls).not.toContain("pi16"); // No re-reconcile
    expect(store.completeLog.some(c => c.jobId === "j16")).toBe(true);
  });

  test("W17: expired lease allows new worker reclaim", async () => {
    const job = makeJob("j17", "pi17");
    job.status = "RUNNING"; job.lockedBy = "old-worker";
    job.lockedUntil = new Date(Date.now() - 5000);
    store.addJob(job);
    store.addDpi(makeDpi("pi17", "RECONCILING"));
    engine.setOutcome("pi17", { status: "SETTLED", evidence: {} as any });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    expect(store.claimLog).toContain("j17");
    expect(store.completeLog.some(c => c.jobId === "j17" && c.workerId === "test-worker")).toBe(true);
  });

  // --- Worker Lifecycle ---

  test("W18: start creates exactly one polling loop", async () => {
    store.addJob(makeJob("j18", "pi18"));
    store.addDpi(makeDpi("pi18", "SETTLEMENT_PENDING"));
    engine.setOutcome("pi18", { status: "SETTLED", evidence: {} as any });
    worker.start();
    worker.start(); // duplicate start
    worker.start(); // another duplicate
    await new Promise(r => setTimeout(r, 300));
    // Job should be processed exactly once
    const claimCount = store.claimLog.filter(id => id === "j18").length;
    expect(claimCount).toBe(1);
  });

  test("W19: repeated start does not create duplicate loops", async () => {
    expect(worker.isRunning).toBe(false);
    worker.start();
    expect(worker.isRunning).toBe(true);
    worker.start();
    expect(worker.isRunning).toBe(true);
    await worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  test("W20: stop prevents further polling", async () => {
    store.addJob(makeJob("j20a", "pi20a"));
    store.addDpi(makeDpi("pi20a", "RECONCILING"));
    engine.setOutcome("pi20a", { status: "RECONCILING", reason: "pending", nextProbeMs: 10 });
    worker.start();
    await new Promise(r => setTimeout(r, 150));
    await worker.stop();
    const countAfterStop = store.claimLog.length;
    // Wait and verify no more processing
    await new Promise(r => setTimeout(r, 200));
    // Add a new job after stop — should NOT be processed
    store.addJob(makeJob("j20b", "pi20b"));
    store.addDpi(makeDpi("pi20b", "RECONCILING"));
    await new Promise(r => setTimeout(r, 200));
    expect(store.claimLog).not.toContain("j20b");
  });
});
