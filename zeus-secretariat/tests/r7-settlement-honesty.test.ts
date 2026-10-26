/**
 * R7-A6 + R7-A7 (external audit 2026-10-26, Critical): settlement honesty.
 *
 * A6 — UNRESOLVABLE was unreachable from the post-submission settlement
 *      states: observeSettlement's UNRESOLVED_MANUAL / INCIDENT branches
 *      threw "Invalid state transition", which the execute() catch-all
 *      collapsed to terminal FAILED — "money may have moved, outcome
 *      unknown" was reported as a definitive failure.
 *
 * A7 — asynchronously settled operations stayed in SETTLEMENT_PENDING
 *      forever: the ReconciliationWorker only closed the JOB lifecycle and
 *      never fed the outcome back into the Operation FSM; the public status
 *      remained PROCESSING after the payment had actually settled.
 *
 * These tests pin the fix: FSM edges + SettlementFeedbackService + worker
 * wiring + the honest PENDING result status.
 */

import type { DurableEvidenceStore, DurablePaymentIntent, Operation } from '../src/core/types';
import { isValidTransition } from '../src/core/operation-fsm';
import {
  SettlementFeedbackService,
  planSettlementTransitions,
} from '../src/core/settlement-feedback-service';
import type { ReconciliationOutcome } from '../src/core/reconciliation-engine';
import { ReconciliationWorker } from '../src/core/reconciliation-worker';

// ---------------------------------------------------------------------------
// FSM edges (A6)
// ---------------------------------------------------------------------------

describe("R7-A6: UNRESOLVABLE reachable from post-submission settlement states", () => {
  test("PAYMENT_SUBMITTED → UNRESOLVABLE is valid", () => {
    expect(isValidTransition("PAYMENT_SUBMITTED", "UNRESOLVABLE")).toBe(true);
  });

  test("SETTLEMENT_PENDING → UNRESOLVABLE is valid", () => {
    expect(isValidTransition("SETTLEMENT_PENDING", "UNRESOLVABLE")).toBe(true);
  });

  test("SETTLEMENT_UNKNOWN → UNRESOLVABLE is valid", () => {
    expect(isValidTransition("SETTLEMENT_UNKNOWN", "UNRESOLVABLE")).toBe(true);
  });

  test("pre-submission states still cannot jump to UNRESOLVABLE", () => {
    expect(isValidTransition("AUTHORIZED", "UNRESOLVABLE")).toBe(false);
    expect(isValidTransition("DISCOVERING", "UNRESOLVABLE")).toBe(false);
    expect(isValidTransition("SUCCESS", "UNRESOLVABLE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SettlementFeedbackService (A7)
// ---------------------------------------------------------------------------

class FeedbackFakeStore {
  operations = new Map<string, Operation>();
  saveCalls = 0;

  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async saveOperation(operation: Operation): Promise<void> {
    this.saveCalls += 1;
    this.operations.set(operation.operationId, operation);
  }
}

function makeOperation(operationId: string, currentState: Operation["currentState"]): Operation {
  return {
    operationId,
    requestId: "req-" + operationId,
    target: "https://seller.example/api",
    method: "POST",
    paymentPolicy: {
      maxPrice: "1000000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: ["0xUSDC"],
    },
    paymentState: "SUBMITTED",
    executionState: "NOT_STARTED",
    deliveryState: "NOT_STARTED",
    currentState,
    timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
    evidence: [],
  } as unknown as Operation;
}

function makeSettledEvidence() {
  return {
    authorizationUsed: { transactionHash: "0x" + "ab".repeat(32), blockNumber: 100, logIndex: 1 },
    receipt: { status: 1 as const, blockNumber: 100, gasUsed: "21000" },
    transfer: { from: "0xauth", to: "0xpayee", value: "1000000", tokenContract: "0xusdc" },
    confirmations: 12,
    finalityReached: true,
    rpcObservations: [],
  };
}

describe("R7-A7: SettlementFeedbackService", () => {
  test("plan: SETTLED → [SETTLED]; NOT_SETTLED → [SETTLEMENT_FAILED, FAILED]; manual/incident → [UNRESOLVABLE]; RECONCILING → null", () => {
    expect(planSettlementTransitions({ status: "SETTLED" } as any)).toEqual(["SETTLED"]);
    expect(planSettlementTransitions({ status: "NOT_SETTLED" } as any)).toEqual(["SETTLEMENT_FAILED", "FAILED"]);
    expect(planSettlementTransitions({ status: "UNRESOLVED_MANUAL", reason: "x" } as any)).toEqual(["UNRESOLVABLE"]);
    expect(planSettlementTransitions({ status: "INCIDENT", reason: "x" } as any)).toEqual(["UNRESOLVABLE"]);
    expect(planSettlementTransitions({ status: "RECONCILING", reason: "x" } as any)).toBeNull();
  });

  test("SETTLED outcome moves SETTLEMENT_PENDING operation to SETTLED and saves", async () => {
    const store = new FeedbackFakeStore();
    store.operations.set("op-1", makeOperation("op-1", "SETTLEMENT_PENDING"));
    const feedback = new SettlementFeedbackService(store as any);

    const result = await feedback.applyOutcome("op-1", {
      status: "SETTLED",
      evidence: makeSettledEvidence(),
    } as any);

    expect(result.applied).toBe(true);
    expect(result.currentState).toBe("SETTLED");
    const op = store.operations.get("op-1")!;
    expect(op.currentState).toBe("SETTLED");
    expect(op.paymentState).toBe("SETTLED");
    expect(op.timestamps.settledAt).toBeDefined();
    expect(store.saveCalls).toBe(1);
    const transition = op.evidence.find((e) => e.event === "STATE_TRANSITION");
    expect(transition).toBeDefined();
    expect((transition as any).payload.to).toBe("SETTLED");
  });

  test("NOT_SETTLED outcome walks SETTLEMENT_FAILED → FAILED (honest terminal, not stuck)", async () => {
    const store = new FeedbackFakeStore();
    store.operations.set("op-2", makeOperation("op-2", "SETTLEMENT_PENDING"));
    const feedback = new SettlementFeedbackService(store as any);

    const result = await feedback.applyOutcome("op-2", {
      status: "NOT_SETTLED",
      evidence: {} as any,
    } as any);

    expect(result.applied).toBe(true);
    expect(result.currentState).toBe("FAILED");
    const op = store.operations.get("op-2")!;
    expect(op.currentState).toBe("FAILED");
    expect(op.paymentState).toBe("FAILED");
    expect(op.timestamps.failedAt).toBeDefined();
  });

  test("UNRESOLVED_MANUAL outcome lands on UNRESOLVABLE — not FAILED (A6 regression)", async () => {
    const store = new FeedbackFakeStore();
    store.operations.set("op-3", makeOperation("op-3", "SETTLEMENT_PENDING"));
    const feedback = new SettlementFeedbackService(store as any);

    const result = await feedback.applyOutcome("op-3", {
      status: "UNRESOLVED_MANUAL",
      reason: "§7-8: No matching Transfer event found",
    } as any);

    expect(result.applied).toBe(true);
    expect(result.currentState).toBe("UNRESOLVABLE");
    expect(store.operations.get("op-3")!.currentState).toBe("UNRESOLVABLE");
  });

  test("idempotent: SETTLED outcome on already-SETTLED operation applies nothing and does not save", async () => {
    const store = new FeedbackFakeStore();
    const op = makeOperation("op-4", "SETTLED");
    const evidenceCount = op.evidence.length;
    store.operations.set("op-4", op);
    const feedback = new SettlementFeedbackService(store as any);

    const result = await feedback.applyOutcome("op-4", {
      status: "SETTLED",
      evidence: makeSettledEvidence(),
    } as any);

    expect(result.applied).toBe(false);
    expect(store.saveCalls).toBe(0);
    expect(op.evidence.length).toBe(evidenceCount);
  });

  test("terminal operations are never re-entered", async () => {
    const store = new FeedbackFakeStore();
    store.operations.set("op-5", makeOperation("op-5", "UNRESOLVABLE"));
    const feedback = new SettlementFeedbackService(store as any);

    const result = await feedback.applyOutcome("op-5", {
      status: "NOT_SETTLED",
      evidence: {} as any,
    } as any);

    expect(result.applied).toBe(false);
    expect(store.saveCalls).toBe(0);
  });

  test("missing operation is a no-op (worker path must not throw)", async () => {
    const store = new FeedbackFakeStore();
    const feedback = new SettlementFeedbackService(store as any);
    const result = await feedback.applyOutcome("missing", { status: "SETTLED", evidence: {} as any } as any);
    expect(result.applied).toBe(false);
    expect(result.currentState).toBeNull();
  });

  test("transition not present → SETTLEMENT_FEEDBACK_SKIPPED evidence, no state corruption", async () => {
    const store = new FeedbackFakeStore();
    store.operations.set("op-6", makeOperation("op-6", "CREATED"));
    const feedback = new SettlementFeedbackService(store as any);

    const result = await feedback.applyOutcome("op-6", {
      status: "SETTLED",
      evidence: makeSettledEvidence(),
    } as any);

    expect(result.applied).toBe(false);
    const op = store.operations.get("op-6")!;
    expect(op.currentState).toBe("CREATED");
    const skipped = op.evidence.find((e) => e.event === "SETTLEMENT_FEEDBACK_SKIPPED");
    expect(skipped).toBeDefined();
    expect(store.saveCalls).toBe(0); // no transitions applied → no save
  });
});

// ---------------------------------------------------------------------------
// Worker wiring (A7 end-to-end through the poll loop)
// ---------------------------------------------------------------------------

interface FakeJob {
  jobId: string; paymentIntentId: string; status: string;
  probeCount: number; nextProbeAt: Date; lockedBy: string | null;
  lockedUntil: Date | null; lastError: string | null;
}

class WorkerFakeStore {
  jobs = new Map<string, FakeJob>();
  dpis = new Map<string, DurablePaymentIntent>();
  operations = new Map<string, Operation>();
  probeSyncLog: Array<{ id: string; count: number }> = [];

  addJob(job: FakeJob) { this.jobs.set(job.jobId, job); }
  addDpi(dpi: DurablePaymentIntent) { this.dpis.set(dpi.paymentIntentId, dpi); }

  async getDueReconciliationJobs(_limit?: number) {
    const now = new Date();
    const results: Array<{ jobId: string; paymentIntentId: string; probeCount: number }> = [];
    for (const j of this.jobs.values()) {
      const duePending = j.status === "PENDING" && j.nextProbeAt <= now;
      const expiredRunning = j.status === "RUNNING" && j.lockedUntil !== null && j.lockedUntil < now;
      if (duePending || expiredRunning) {
        results.push({ jobId: j.jobId, paymentIntentId: j.paymentIntentId, probeCount: j.probeCount });
      }
    }
    return results;
  }

  async claimReconciliationJob(jobId: string, workerId: string, lockMs: number): Promise<boolean> {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    const canClaim = j.status === "PENDING" || (j.status === "RUNNING" && j.lockedUntil !== null && j.lockedUntil < now());
    if (!canClaim) return false;
    j.status = "RUNNING"; j.lockedBy = workerId;
    j.lockedUntil = new Date(Date.now() + lockMs); j.probeCount++;
    return true;
  }

  // R7-C2: direct read-back (a claimed RUNNING job is NOT in the due set —
  // this primitive is what makes the probe-count sync work at all).
  async getReconciliationJobById(jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    return { jobId: j.jobId, paymentIntentId: j.paymentIntentId, probeCount: j.probeCount, status: j.status };
  }

  async updatePaymentIntentProbeCount(id: string, count: number): Promise<void> {
    this.probeSyncLog.push({ id, count });
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

  async getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null> {
    return this.dpis.get(id) ?? null;
  }

  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, operation);
  }

  // Store-contract stubs unused in these scenarios
  async append(): Promise<void> {}
  async getEvidence(): Promise<any[]> { return []; }
  async createReconciliationJob(): Promise<string> { return ""; }
}

class WorkerFakeEngine {
  outcomes = new Map<string, ReconciliationOutcome>();
  constructor(private store: WorkerFakeStore) {}

  setOutcome(paymentIntentId: string, outcome: ReconciliationOutcome) {
    this.outcomes.set(paymentIntentId, outcome);
  }

  async reconcile(paymentIntentId: string): Promise<ReconciliationOutcome> {
    return this.outcomes.get(paymentIntentId) ?? { status: "RECONCILING", reason: "default", nextProbeMs: 5000 };
  }
}

function makeWorkerDpi(id: string, state: string, operationId: string): DurablePaymentIntent {
  return {
    paymentIntentId: id, operationId, requestId: "req-" + id,
    clientId: "cli-test", authorizer: "0xAuth", payTo: "0xPayee",
    value: "1000000", asset: "0xUSDC", network: "base-sepolia",
    nonce: "0xnonce", validAfter: 0, validBefore: 9999999999,
    paymentPayload: "", paymentPayloadHash: "",
    settlementState: state as any, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

describe("R7-A7: ReconciliationWorker feeds settlement outcomes into the Operation FSM", () => {
  test("async SETTLED outcome transitions the operation out of SETTLEMENT_PENDING", async () => {
    const store = new WorkerFakeStore();
    const engine = new WorkerFakeEngine(store);
    store.addJob({ jobId: "j-a7-1", paymentIntentId: "pi-a7-1", status: "PENDING", probeCount: 0, nextProbeAt: new Date(Date.now() - 1000), lockedBy: null, lockedUntil: null, lastError: null });
    store.addDpi(makeWorkerDpi("pi-a7-1", "SETTLEMENT_PENDING", "op-a7-1"));
    store.operations.set("op-a7-1", makeOperation("op-a7-1", "SETTLEMENT_PENDING"));
    engine.setOutcome("pi-a7-1", { status: "SETTLED", evidence: makeSettledEvidence() } as any);

    const worker = new ReconciliationWorker(store as any, engine as any, {
      pollIntervalMs: 20, leaseDurationMs: 30000, errorBackoffMs: 100, workerId: "r7-worker",
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    const op = store.operations.get("op-a7-1")!;
    expect(op.currentState).toBe("SETTLED");
    expect(op.paymentState).toBe("SETTLED");
    // The probe-count sync now reads the claimed job directly (R7-C2)
    expect(store.probeSyncLog).toContainEqual({ id: "pi-a7-1", count: 1 });
  }, 10_000);

  test("UNRESOLVED_MANUAL outcome lands the operation on UNRESOLVABLE through the worker", async () => {
    const store = new WorkerFakeStore();
    const engine = new WorkerFakeEngine(store);
    store.addJob({ jobId: "j-a7-2", paymentIntentId: "pi-a7-2", status: "PENDING", probeCount: 0, nextProbeAt: new Date(Date.now() - 1000), lockedBy: null, lockedUntil: null, lastError: null });
    store.addDpi(makeWorkerDpi("pi-a7-2", "SETTLEMENT_PENDING", "op-a7-2"));
    store.operations.set("op-a7-2", makeOperation("op-a7-2", "SETTLEMENT_PENDING"));
    engine.setOutcome("pi-a7-2", { status: "UNRESOLVED_MANUAL", reason: "manual review" });

    const worker = new ReconciliationWorker(store as any, engine as any, {
      pollIntervalMs: 20, leaseDurationMs: 30000, errorBackoffMs: 100, workerId: "r7-worker",
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    expect(store.operations.get("op-a7-2")!.currentState).toBe("UNRESOLVABLE");
  }, 10_000);

  test("RECONCILING outcome leaves the operation untouched (no feedback)", async () => {
    const store = new WorkerFakeStore();
    const engine = new WorkerFakeEngine(store);
    store.addJob({ jobId: "j-a7-3", paymentIntentId: "pi-a7-3", status: "PENDING", probeCount: 0, nextProbeAt: new Date(Date.now() - 1000), lockedBy: null, lockedUntil: null, lastError: null });
    store.addDpi(makeWorkerDpi("pi-a7-3", "SETTLEMENT_PENDING", "op-a7-3"));
    store.operations.set("op-a7-3", makeOperation("op-a7-3", "SETTLEMENT_PENDING"));
    engine.setOutcome("pi-a7-3", { status: "RECONCILING", reason: "insufficient confirmations", nextProbeMs: 1000 });

    const worker = new ReconciliationWorker(store as any, engine as any, {
      pollIntervalMs: 20, leaseDurationMs: 30000, errorBackoffMs: 100, workerId: "r7-worker",
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();

    expect(store.operations.get("op-a7-3")!.currentState).toBe("SETTLEMENT_PENDING");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Honest in-progress result status (A7 companion fix)
// ---------------------------------------------------------------------------

describe("R7-A7: in-progress ExecutionResult status is PENDING, not FAILED", () => {
  test("mapToFinalStatus reports PENDING for non-terminal states", async () => {
    const { Secretariat } = await import("../src/core/state-machine");
    const secretariat = Object.create(Secretariat.prototype) as any;
    expect(secretariat.mapToFinalStatus("SETTLEMENT_PENDING")).toBe("PENDING");
    expect(secretariat.mapToFinalStatus("PAYMENT_SUBMITTED")).toBe("PENDING");
    expect(secretariat.mapToFinalStatus("EXECUTION_PENDING")).toBe("PENDING");
    expect(secretariat.mapToFinalStatus("EXECUTION_UNKNOWN")).toBe("PENDING");
    expect(secretariat.mapToFinalStatus("SUCCESS")).toBe("SUCCESS");
    expect(secretariat.mapToFinalStatus("FAILED")).toBe("FAILED");
    expect(secretariat.mapToFinalStatus("SETTLEMENT_FAILED")).toBe("FAILED");
    expect(secretariat.mapToFinalStatus("UNRESOLVABLE")).toBe("UNRESOLVABLE");
  });
});
