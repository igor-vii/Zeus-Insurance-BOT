import type { DurableEvidenceStore, DurablePaymentIntent, Operation } from "../src/core/types";
import { ReconciliationWorker } from "../src/core/reconciliation-worker";
import type { ReconciliationOutcome } from "../src/core/reconciliation-engine";

interface FakeJob {
  jobId: string;
  paymentIntentId: string;
  status: string;
  probeCount: number;
  nextProbeAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
}

class PassiveStore implements Partial<DurableEvidenceStore> {
  readonly jobs = new Map<string, FakeJob>();
  readonly dpis = new Map<string, DurablePaymentIntent>();
  readonly operations = new Map<string, Operation>();
  readonly claimCalls: string[] = [];
  readonly completePendingCalls: string[] = [];
  readonly rescheduleCalls: string[] = [];
  readonly probeCountUpdates: Array<{ paymentIntentId: string; probeCount: number }> = [];

  async getDueReconciliationJobs() {
    const now = new Date();
    return [...this.jobs.values()]
      .filter(job =>
        (job.status === "PENDING" && job.nextProbeAt <= now) ||
        (job.status === "RUNNING" && job.lockedUntil !== null && job.lockedUntil < now),
      )
      .map(job => ({
        jobId: job.jobId,
        paymentIntentId: job.paymentIntentId,
        probeCount: job.probeCount,
      }));
  }

  async claimReconciliationJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.status = "RUNNING";
    job.lockedBy = workerId;
    job.lockedUntil = new Date(Date.now() + lockDurationMs);
    job.probeCount++;
    this.claimCalls.push(jobId);
    return true;
  }

  async completePendingReconciliationJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || !(
      job.status === "PENDING" ||
      (job.status === "RUNNING" && job.lockedUntil !== null && job.lockedUntil < new Date())
    )) {
      return false;
    }
    job.status = "COMPLETED";
    job.lockedBy = null;
    job.lockedUntil = null;
    this.completePendingCalls.push(jobId);
    return true;
  }

  async completeReconciliationJob(): Promise<boolean> {
    throw new Error("normal reconciliation completion must not be used");
  }

  async rescheduleReconciliationJob(jobId: string): Promise<boolean> {
    this.rescheduleCalls.push(jobId);
    return false;
  }

  async getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null> {
    return this.dpis.get(paymentIntentId) ?? null;
  }

  async updatePaymentIntentProbeCount(paymentIntentId: string, probeCount: number): Promise<void> {
    this.probeCountUpdates.push({ paymentIntentId, probeCount });
  }
}

class CountingEngine {
  reconcileCalls = 0;
  facilitatorCalls = 0;
  rpcCalls = 0;
  submissionCalls = 0;

  async reconcile(_paymentIntentId: string): Promise<ReconciliationOutcome> {
    this.reconcileCalls++;
    this.facilitatorCalls++;
    this.rpcCalls++;
    this.submissionCalls++;
    return { status: "RECONCILING", reason: "test engine should not be reached" };
  }
}

function makePendingIntent(): DurablePaymentIntent {
  return {
    paymentIntentId: "pi-pending-signature",
    operationId: "op-pending-signature",
    requestId: "req-pending-signature",
    clientId: "client-pending-signature",
    authorizer: "0xAuthorizer",
    payTo: "0xPayee",
    value: "1000000",
    asset: "0xUSDC",
    network: "base-sepolia",
    nonce: "0xnonce",
    validAfter: 0,
    validBefore: 9999999999,
    paymentPayload: "pending",
    paymentPayloadHash: "pending-hash",
    settlementState: "PENDING_SIGNATURE",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeAwaitingSignatureOperation(): Operation {
  return {
    operationId: "op-pending-signature",
    requestId: "req-pending-signature",
    clientId: "client-pending-signature",
    target: "https://seller.example.com/api",
    method: "GET",
    currentState: "AWAITING_SIGNATURE",
    paymentState: "PENDING_SIGNATURE",
    requestPayload: {},
    evidence: [],
    timestamps: {},
  } as Operation;
}

describe("Repair B: PENDING_SIGNATURE remains passive in the worker", () => {
  test("retires an existing job before claim without reconciliation or economic action", async () => {
    const store = new PassiveStore();
    const engine = new CountingEngine();
    const dpi = makePendingIntent();
    const job: FakeJob = {
      jobId: "job-pending-signature",
      paymentIntentId: dpi.paymentIntentId,
      status: "PENDING",
      probeCount: 0,
      nextProbeAt: new Date(Date.now() - 1000),
      lockedBy: null,
      lockedUntil: null,
    };
    store.dpis.set(dpi.paymentIntentId, dpi);
    store.jobs.set(job.jobId, job);
    store.operations.set(dpi.operationId, makeAwaitingSignatureOperation());

    const worker = new ReconciliationWorker(store as any, engine as any, {
      pollIntervalMs: 10,
      leaseDurationMs: 30_000,
      errorBackoffMs: 10,
      workerId: "repair-b-worker",
    });

    worker.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    await worker.stop();

    expect(store.completePendingCalls).toEqual([job.jobId]);
    expect(store.claimCalls).toEqual([]);
    expect(store.rescheduleCalls).toEqual([]);
    expect(store.probeCountUpdates).toEqual([]);
    expect(job.status).toBe("COMPLETED");
    expect(job.probeCount).toBe(0);
    expect(engine.reconcileCalls).toBe(0);
    expect(engine.facilitatorCalls).toBe(0);
    expect(engine.rpcCalls).toBe(0);
    expect(engine.submissionCalls).toBe(0);
    expect(store.dpis.get(dpi.paymentIntentId)?.settlementState).toBe("PENDING_SIGNATURE");
    expect(store.operations.get(dpi.operationId)?.currentState).toBe("AWAITING_SIGNATURE");
  });
});