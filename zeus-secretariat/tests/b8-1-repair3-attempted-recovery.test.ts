/**
 * BLOCK 8/1 Repair #3A — ATTEMPTED Crash Recovery Tests
 *
 * Exercises the REAL PostSettlementEngine.processJob() path to prove
 * that ATTEMPTED attempts after crash are correctly resolved through
 * capability-based recovery without re-executing the original attempt.
 */

import { PostSettlementEngine } from "../src/core/post-settlement-engine";
import type { ExecutionStore, ExecutionAttempt, RecoveryJob, ExecutionCapability } from "../src/core/post-settlement-engine";
import type { SellerExecutionAdapter, SellerExecutionRequest, SellerExecutionResult } from "../src/adapters/seller-execution-adapter";

describe("BLOCK 8/1 Repair #3A: ATTEMPTED Crash Recovery via processJob()", () => {
  let store: ExecutionStore;
  let adapterCalls: SellerExecutionRequest[];
  let mockAdapter: SellerExecutionAdapter;
  let engine: PostSettlementEngine;

  function makeJob(capability: ExecutionCapability, overrides?: Partial<RecoveryJob>): RecoveryJob {
    const now = Date.now();
    return {
      jobId: `rj-crash-${now}-${Math.random().toString(36).slice(2)}`,
      operationId: `op-crash-${now}-${Math.random().toString(36).slice(2)}`,
      jobType: "EXECUTION",
      status: "PENDING",
      priority: 0,
      maxAttempts: 3,
      currentAttempt: 0,
      metadata: { capability },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function makeAttempt(operationId: string, overrides?: Partial<ExecutionAttempt>): ExecutionAttempt {
    const now = Date.now();
    return {
      attemptId: `att-crash-${now}-${Math.random().toString(36).slice(2)}`,
      operationId,
      executionId: operationId,
      attemptNumber: 1,
      status: "ATTEMPTED", // Simulates crash after markAttemptInProgress
      idempotencyKey: operationId,
      createdAt: now,
      startedAt: now,
      ...overrides,
    };
  }

  beforeEach(async () => {
    const { InMemoryExecutionStore } = await import("../src/core/post-settlement-engine");
    store = new InMemoryExecutionStore() as ExecutionStore;
    adapterCalls = [];
    mockAdapter = {
      async execute(req: SellerExecutionRequest): Promise<SellerExecutionResult> {
        adapterCalls.push(req);
        return { kind: "SUCCESS", statusCode: 200, body: "{}", headers: {} };
      },
    };
    // Create engine with minimal config
    engine = new PostSettlementEngine(
      store as any, // paymentStore not used in these tests
      store,
      mockAdapter,
      { workerId: "test-worker", sellerUrl: "https://seller.example.com", lockDurationMs: 30000 },
    );
  });

  test("NONE + ATTEMPTED → UNRESOLVABLE, no seller call", async () => {
    const job = makeJob("NONE");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    expect(result.finalStatus).toBe("UNRESOLVABLE");
    expect(result.success).toBe(false);
    expect(adapterCalls.length).toBe(0); // No seller call

    const updatedAttempt = await store.getAttemptById(attempt.attemptId);
    expect(updatedAttempt?.status).toBe("UNRESOLVABLE");

    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("UNRESOLVABLE");
  });

  test("RESULT_RETRIEVAL + ATTEMPTED → retrieval job created, no POST", async () => {
    const job = makeJob("RESULT_RETRIEVAL");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");
    expect(result.success).toBe(false);
    expect(adapterCalls.length).toBe(0); // No POST call

    // Original attempt should be DELIVERY_UNKNOWN
    const updatedAttempt = await store.getAttemptById(attempt.attemptId);
    expect(updatedAttempt?.status).toBe("DELIVERY_UNKNOWN");

    // Original job should be COMPLETED (handed off to retrieval)
    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("COMPLETED");

    // A new RETRIEVAL job should exist
    const pendingJobs = await store.getPendingJobs();
    const retrievalJob = pendingJobs.find((j) => j.jobType === "RETRIEVAL");
    expect(retrievalJob).toBeDefined();
    expect(retrievalJob?.operationId).toBe(job.operationId);
  });

  test("EXECUTION_IDEMPOTENT + ATTEMPTED → new attempt created, original NOT executed", async () => {
    const opId = `op-idemp-${Date.now()}`;
    const job = makeJob("EXECUTION_IDEMPOTENT", { operationId: opId });
    await store.saveJob(job);
    const attempt = makeAttempt(opId, { idempotencyKey: opId });
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");
    expect(result.success).toBe(false);
    expect(adapterCalls.length).toBe(0); // No seller call on THIS processJob invocation

    // Original attempt should be DELIVERY_UNKNOWN (not re-executed)
    const originalAttempt = await store.getAttemptById(attempt.attemptId);
    expect(originalAttempt?.status).toBe("DELIVERY_UNKNOWN");
    expect(originalAttempt?.attemptNumber).toBe(1);

    // New attempt should exist with incremented attemptNumber and SAME key
    const allAttempts = await store.getAttemptsByOperation(opId);
    expect(allAttempts.length).toBe(2);
    const newAttempt = allAttempts.find((a) => a.attemptId !== attempt.attemptId);
    expect(newAttempt).toBeDefined();
    expect(newAttempt?.attemptNumber).toBe(2);
    expect(newAttempt?.idempotencyKey).toBe(opId);
    expect(newAttempt?.executionId).toBe(opId);
    expect(newAttempt?.status).toBe("PENDING");

    // Job should be re-queued for new attempt
    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("PENDING");
  });

  test("crash before seller call — no blind execution of original attempt", async () => {
    const job = makeJob("EXECUTION_IDEMPOTENT");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId, { startedAt: undefined }); // Never actually called seller
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    // Should NOT have called seller with original attempt
    expect(adapterCalls.length).toBe(0);
    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");

    // Original attempt preserved as evidence
    const original = await store.getAttemptById(attempt.attemptId);
    expect(original?.status).toBe("DELIVERY_UNKNOWN");
  });

  test("crash after seller / unknown result — no blind re-execution", async () => {
    const job = makeJob("EXECUTION_IDEMPOTENT");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId, {
      startedAt: Date.now(),
      responseStatusCode: undefined, // Seller may have responded but result lost
    });
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    expect(adapterCalls.length).toBe(0); // No re-execution of original
    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");
  });

  test("stale generation cannot mutate ATTEMPTED recovery state", async () => {
    const job = makeJob("NONE");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // Worker A claims generation 1
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Lease expires, Worker B claims generation 2
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Worker A tries stale update → REJECTED
    const staleResult = await store.updateAttemptStatus(
      attempt.attemptId, "UNRESOLVABLE", fence1!,
      { errorReason: "stale" },
    );
    expect(staleResult).toBe(false);

    // Attempt still ATTEMPTED (stale worker could not change it)
    const unchanged = await store.getAttemptById(attempt.attemptId);
    expect(unchanged?.status).toBe("ATTEMPTED");
  });
});
