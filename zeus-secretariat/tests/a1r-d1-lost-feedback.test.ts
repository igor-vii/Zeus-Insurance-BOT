/**
 * A1-R D-1 — Reproduction test: lost FSM feedback after saveOperation failure.
 *
 * Failure path under investigation (from the A1 audit, Stage 2A report):
 *   1. Seller execution succeeds (exactly once).
 *   2. PostSettlementEngine.processJob() durably completes the EXECUTION job
 *      (terminal status COMPLETED/SUCCESS) BEFORE any feedback is applied.
 *   3. ExecutionWorker.processOne() calls ExecutionFeedbackService.applyResult().
 *   4. Operation persistence (saveOperation) throws.
 *   5. The worker catches + logs the error (execution-worker.ts:130-135).
 *   6. A subsequent polling iteration does NOT re-drive feedback because
 *      getPendingJobs() excludes terminal jobs (both the in-memory store used
 *      here and PostgresExecutionStore.getPendingJobs filter on
 *      PENDING / stale-RUNNING only).
 *   7. The durable Operation remains stale (SETTLED) although the execution
 *      result is durable.
 *
 * This test FAITHFULLY EXPOSES CURRENT BEHAVIOR. It asserts the defect as it
 * exists today; it does NOT assert desired repaired behavior.
 *
 * Infrastructure: real ExecutionWorker, real PostSettlementEngine, real
 * ExecutionFeedbackService, pre-existing InMemoryExecutionStore (same fixtures
 * as a1-execution-fsm.test.ts). Persistence failure injected at
 * saveOperation() only — worker polling logic and engine job completion are
 * NOT mocked away.
 *
 * Scope limitation (honesty note): the in-memory execution store proves the
 * control-flow defect (terminal jobs invisible to getPendingJobs/recoverPendingJobs
 * and no other applyResult caller). It does NOT prove PostgreSQL-level
 * durability interleavings (e.g., crash between updateJobStatus commit and
 * applyResult). That PG-level verification requires DATABASE_URL integration
 * and is out of scope for this unit reproduction.
 */

import {
  PostSettlementEngine,
  InMemoryExecutionStore,
  ExecutionWorker,
  ExecutionFeedbackService,
} from "zeus-secretariat";
import type { SellerExecutionAdapter, SellerExecutionResult } from "zeus-secretariat";

const SUCCESS_RESULT: SellerExecutionResult = {
  kind: "SUCCESS",
  statusCode: 200,
  body: { ok: true },
  headers: {},
  durationMs: 5,
};

class CountingAdapter implements SellerExecutionAdapter {
  calls = 0;
  async execute(): Promise<SellerExecutionResult> {
    this.calls++;
    return SUCCESS_RESULT;
  }
}

class FakePaymentStoreForEngine {
  observations: unknown[] = [];
  async getPaymentIntentByOperationId(opId: string): Promise<any> {
    // INV-8 guard in initiateExecution requires a SETTLED intent (same seed
    // shape as the pre-existing a1-execution-fsm.test.ts fixture).
    return { operationId: opId, settlementState: "SETTLED", target: "https://seller.example/api", method: "POST" };
  }
  async append(record: unknown): Promise<void> {
    this.observations.push(record);
  }
}

/**
 * Recording operation-persistence facade with injectable saveOperation failure.
 * getOperation/saveOperation implement the minimal contract required by
 * ExecutionFeedbackService (OperationPersistence). No production code changed.
 */
class RecordingOpPersistence {
  op: any;
  saveCalls = 0;
  getCalls = 0;
  failSave = false;

  constructor(op: any) {
    this.op = structuredClone(op);
  }

  async getOperation(_operationId: string): Promise<any> {
    this.getCalls++;
    return structuredClone(this.op);
  }

  async saveOperation(operation: any): Promise<void> {
    this.saveCalls++;
    if (this.failSave) {
      throw new Error("INJECTED_SAVEOPERATION_FAILURE");
    }
    this.op = structuredClone(operation);
  }
}

const baseOp = (opId: string): any => ({
  operationId: opId,
  requestId: `req-${opId}`,
  clientId: `client-${opId}`,
  target: "https://seller.example/api",
  method: "POST",
  paymentPolicy: { maxAmount: "10" },
  paymentState: "SETTLED",
  executionState: "NOT_STARTED",
  deliveryState: "NOT_STARTED",
  currentState: "SETTLED",
  timestamps: { createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
  evidence: [],
});

async function seedPipeline(adapter: SellerExecutionAdapter) {
  const opId = "op-d1-repro";
  const execStore = new InMemoryExecutionStore();
  const paymentStore = new FakePaymentStoreForEngine();
  const engine = new PostSettlementEngine(
    paymentStore as never,
    execStore as never,
    adapter,
    { workerId: "test-worker", sellerUrl: "https://seller.example/api" },
  );
  await engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT", { hello: "world" });
  return { opId, execStore, engine };
}

describe("A1-R D-1 — lost FSM feedback after saveOperation failure", () => {
  it("reproduces: terminal durable job + failed feedback ⇒ Operation stuck SETTLED, second poll does NOT re-drive, seller not re-called", async () => {
    const adapter = new CountingAdapter();
    const { opId, execStore, engine } = await seedPipeline(adapter);

    const ops = new RecordingOpPersistence(baseOp(opId));
    ops.failSave = true; // inject persistence failure at saveOperation()

    const feedback = new ExecutionFeedbackService(ops as never);
    const worker = new ExecutionWorker(engine, execStore as never, {
      feedbackService: feedback,
    });

    const errorLogs: unknown[][] = [];
    const errSpy = jest
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errorLogs.push(args);
      });

    // ---- Iteration 1: seller executes, job goes terminal, feedback fails ----
    const processed1 = await worker.runOnce();
    expect(processed1).toBe(1);

    // Seller executed exactly once.
    expect(adapter.calls).toBe(1);

    // Durable job reached terminal state (COMPLETED via SUCCESS outcome).
    const jobs = await execStore.getPendingJobs();
    const allJobs = await (execStore as any).getAllJobs?.();
    // InMemoryExecutionStore has no getAllJobs; read via internal map instead:
    const stored: any[] = Array.from((execStore as any).jobs.values());
    expect(stored).toHaveLength(1);
    expect(["COMPLETED", "FAILED", "UNRESOLVABLE"]).toContain(stored[0].status);
    expect(jobs).toHaveLength(0); // terminal ⇒ excluded from pending scan

    // Attempt is durably SUCCESS.
    const attempts = await execStore.getAttemptsByOperation(opId);
    expect(attempts.filter((a) => a.status === "SUCCESS")).toHaveLength(1);

    // Feedback was ATTEMPTED and its persistence FAILED:
    expect(ops.saveCalls).toBeGreaterThanOrEqual(1);
    expect(errorLogs.some((l) => String(l[0]).includes("FSM feedback failed"))).toBe(true);
    expect(
      errorLogs.some((l) => String(l[1] ?? "").includes("INJECTED_SAVEOPERATION_FAILURE")),
    ).toBe(true);

    // Worker did NOT falsely report success: nothing was persisted.
    expect(ops.op.currentState).toBe("SETTLED");
    expect(ops.op.executionState).toBe("NOT_STARTED");
    expect(ops.op.evidence).toHaveLength(0);

    // ---- Iteration 2: recovery attempt ----
    const processed2 = await worker.runOnce();
    expect(processed2).toBe(0); // terminal job invisible to getPendingJobs

    // recoverPendingJobs() uses the same filter ⇒ also no re-drive:
    const recovered = await engine.recoverPendingJobs();
    expect(recovered).toHaveLength(0);

    // Feedback was NEVER re-driven after the failure:
    // getCalls == 1 (single applyResult attempt in iteration 1).
    expect(ops.getCalls).toBe(1);

    // Seller was NOT re-executed during recovery:
    expect(adapter.calls).toBe(1);

    // FINAL STATE: durable job terminal + attempt SUCCESS, but Operation STALE.
    expect(ops.op.currentState).toBe("SETTLED");
    expect(ops.op.evidence).toHaveLength(0);

    errSpy.mockRestore();
  });

  it("control case: without the injected failure, the same pipeline reaches SUCCESS (proves the failure is the sole cause)", async () => {
    const adapter = new CountingAdapter();
    const { opId, execStore, engine } = await seedPipeline(adapter);

    const ops = new RecordingOpPersistence(baseOp(opId));
    ops.failSave = false;

    const feedback = new ExecutionFeedbackService(ops as never);
    const worker = new ExecutionWorker(engine, execStore as never, {
      feedbackService: feedback,
    });

    await worker.runOnce();
    await worker.runOnce(); // duplicate poll must be a no-op

    expect(adapter.calls).toBe(1);
    expect(ops.op.currentState).toBe("SUCCESS");
    expect(ops.op.executionState).toBe("CONFIRMED");
    expect(ops.op.deliveryState).toBe("DELIVERED");
    expect(ops.op.evidence.filter((e: any) => e.event === "STATE_TRANSITION")).toHaveLength(4);
  });
});
