/**
 * BLOCK 8/1 Repair #3B — fence-safe ATTEMPTED Crash Recovery Tests
 *
 * Exercises the REAL PostSettlementEngine.processJob() path to prove
 * that ATTEMPTED attempts after crash are correctly resolved through
 * capability-based recovery without re-executing the original attempt, and
 * that recovery creation is fenced as one atomic operation.
 */

import { PostSettlementEngine } from "../src/core/post-settlement-engine";
import type { ExecutionStore, ExecutionAttempt, RecoveryJob, ExecutionCapability } from "../src/core/post-settlement-engine";
import type { SellerExecutionAdapter, SellerExecutionRequest, SellerExecutionResult } from "../src/adapters/seller-execution-adapter";

describe("BLOCK 8/1 Repair #3B: ATTEMPTED Crash Recovery via processJob()", () => {
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
      { append: async () => {} } as any,
      store,
      mockAdapter,
      { workerId: "test-worker", sellerUrl: "https://seller.example.com", lockDurationMs: 30000 },
    );
  });

  test("T1: stale before first mutation creates no recovery action", async () => {
    const job = makeJob("EXECUTION_IDEMPOTENT");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const fenceA = await store.claimJob(job.jobId, "worker-A", 100);
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fenceB = await store.claimJob(job.jobId, "worker-B", 30_000);
    expect(fenceB).toBeGreaterThan(fenceA!);

    const created = await store.createRecoveryAttemptIfOwner(
      job.jobId,
      attempt.attemptId,
      fenceA!,
      { ...attempt, attemptId: "retry-stale-before", attemptNumber: 2, status: "PENDING" },
      "stale",
    );

    expect(created).toBe(false);
    expect(adapterCalls).toHaveLength(0);
    expect((await store.getAttemptsByOperation(job.operationId))).toHaveLength(1);
    expect((await store.getAttemptById(attempt.attemptId))?.status).toBe("ATTEMPTED");
  });

  test("T2: stale after a successful fenced mutation creates no orphan recovery", async () => {
    const job = makeJob("EXECUTION_IDEMPOTENT");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const fenceA = await store.claimJob(job.jobId, "worker-A", 100);
    const markedUnknown = await store.updateAttemptStatus(
      attempt.attemptId,
      "DELIVERY_UNKNOWN",
      fenceA!,
      { errorReason: "seller outcome unknown" },
    );
    expect(markedUnknown).toBe(true);

    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fenceB = await store.claimJob(job.jobId, "worker-B", 30_000);
    expect(fenceB).toBeGreaterThan(fenceA!);

    const created = await store.createRecoveryAttemptIfOwner(
      job.jobId,
      attempt.attemptId,
      fenceA!,
      { ...attempt, attemptId: "retry-stale-after", attemptNumber: 2, status: "PENDING" },
      "stale after mutation",
    );

    expect(created).toBe(false);
    expect(adapterCalls).toHaveLength(0);
    expect((await store.getAttemptsByOperation(job.operationId))).toHaveLength(1);
    expect((await store.getPendingJobs()).filter((candidate) => candidate.jobType === "RETRY")).toHaveLength(0);
  });

  test("T3: concurrent recovery creates only one retry action", async () => {
    const job = makeJob("EXECUTION_IDEMPOTENT");
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);
    const fence = await store.claimJob(job.jobId, "worker-A", 30_000);

    const retry = (attemptId: string): ExecutionAttempt => ({
      ...attempt,
      attemptId,
      attemptNumber: 2,
      status: "PENDING",
      createdAt: Date.now(),
    });
    const results = await Promise.all([
      store.createRecoveryAttemptIfOwner(job.jobId, attempt.attemptId, fence!, retry("retry-concurrent-a"), "recovery"),
      store.createRecoveryAttemptIfOwner(job.jobId, attempt.attemptId, fence!, retry("retry-concurrent-b"), "recovery"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getAttemptsByOperation(job.operationId))).toHaveLength(2);
    expect((await store.getJob(job.jobId))?.status).toBe("PENDING");
    expect(adapterCalls).toHaveLength(0);
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


// ===========================================================================
// BLOCK 8/1 Repair #3C: Post-Execution DELIVERY_UNKNOWN Stale Worker Tests
// ===========================================================================

describe("BLOCK 8/1 Repair #3C: Post-Execution DELIVERY_UNKNOWN Fencing", () => {
  let store: ExecutionStore;
  let adapterCalls: SellerExecutionRequest[];
  let mockAdapter: SellerExecutionAdapter;
  let engine: PostSettlementEngine;

  function makeJob(capability: ExecutionCapability, overrides?: Partial<RecoveryJob>): RecoveryJob {
    const now = Date.now();
    return {
      jobId: `rj-post-${now}-${Math.random().toString(36).slice(2)}`,
      operationId: `op-post-${now}-${Math.random().toString(36).slice(2)}`,
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

  function makePendingAttempt(operationId: string, overrides?: Partial<ExecutionAttempt>): ExecutionAttempt {
    const now = Date.now();
    return {
      attemptId: `att-post-${now}-${Math.random().toString(36).slice(2)}`,
      operationId,
      executionId: operationId,
      attemptNumber: 1,
      status: "PENDING",
      idempotencyKey: operationId,
      requestUrl: "https://seller.example.com/execute",
      requestMethod: "POST",
      createdAt: now,
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
        // Simulate DELIVERY_UNKNOWN outcome (timeout/connection reset)
        return { kind: "DELIVERY_UNKNOWN", reason: "TIMEOUT" };
      },
    };
    engine = new PostSettlementEngine(
      { append: async () => {} } as any,
      store,
      mockAdapter,
      { workerId: "test-worker", sellerUrl: "https://seller.example.com", lockDurationMs: 30000 },
    );
  });

  test("RESULT_RETRIEVAL: stale worker cannot create retrieval job after fence loss", async () => {
    const job = makeJob("RESULT_RETRIEVAL");
    await store.saveJob(job);
    const attempt = makePendingAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // Worker A claims fence 1
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Lease expires, Worker B claims fence 2
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Worker A tries to create retrieval job with stale fence → REJECTED
    const created = await store.createRecoveryJobIfOwner(
      job.jobId,
      attempt.attemptId,
      fence1!,
      {
        jobId: "retrieval-stale",
        operationId: job.operationId,
        jobType: "RETRIEVAL",
        status: "PENDING",
        priority: 1,
        maxAttempts: 3,
        currentAttempt: 0,
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      "stale test",
    );
    expect(created).toBe(false);

    // Verify no retrieval job was created by stale worker
    const pendingJobs = await store.getPendingJobs();
    const staleRetrieval = pendingJobs.find((j) => j.jobId === "retrieval-stale");
    expect(staleRetrieval).toBeUndefined();
  });

  test("EXECUTION_IDEMPOTENT: stale worker cannot create retry attempt after fence loss", async () => {
    const opId = `op-idemp-post-${Date.now()}`;
    const job = makeJob("EXECUTION_IDEMPOTENT", { operationId: opId });
    await store.saveJob(job);
    const attempt = makePendingAttempt(opId);
    await store.saveAttempt(attempt);

    // Worker A claims fence 1
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Lease expires, Worker B claims fence 2
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Worker A tries to create retry attempt with stale fence → REJECTED
    const created = await store.createRecoveryAttemptIfOwner(
      job.jobId,
      attempt.attemptId,
      fence1!,
      {
        attemptId: "retry-stale",
        operationId: opId,
        executionId: opId,
        attemptNumber: 2,
        status: "PENDING",
        idempotencyKey: opId,
        createdAt: Date.now(),
      },
      "stale test",
    );
    expect(created).toBe(false);

    // Verify no retry attempt was created by stale worker
    const allAttempts = await store.getAttemptsByOperation(opId);
    const staleRetry = allAttempts.find((a) => a.attemptId === "retry-stale");
    expect(staleRetry).toBeUndefined();
  });

  test("Post-execution DELIVERY_UNKNOWN + RESULT_RETRIEVAL uses atomic primitive via processJob", async () => {
    const job = makeJob("RESULT_RETRIEVAL");
    await store.saveJob(job);
    const attempt = makePendingAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // processJob will: claim → execute (returns DELIVERY_UNKNOWN) → createRecoveryJobIfOwner
    const result = await engine.processJob(job.jobId);

    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");
    expect(adapterCalls.length).toBe(1); // Exactly one seller call

    // Original attempt should be DELIVERY_UNKNOWN
    const updatedAttempt = await store.getAttemptById(attempt.attemptId);
    expect(updatedAttempt?.status).toBe("DELIVERY_UNKNOWN");

    // Retrieval job should exist
    const pendingJobs = await store.getPendingJobs();
    const retrievalJob = pendingJobs.find((j) => j.jobType === "RETRIEVAL");
    expect(retrievalJob).toBeDefined();
    expect(retrievalJob?.operationId).toBe(job.operationId);

    // Original job should be COMPLETED
    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("COMPLETED");
  });

  test("Post-execution DELIVERY_UNKNOWN + EXECUTION_IDEMPOTENT uses atomic primitive via processJob", async () => {
    const opId = `op-idemp-proc-${Date.now()}`;
    const job = makeJob("EXECUTION_IDEMPOTENT", { operationId: opId });
    await store.saveJob(job);
    const attempt = makePendingAttempt(opId);
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");
    expect(adapterCalls.length).toBe(1);

    // Original attempt should be DELIVERY_UNKNOWN
    const original = await store.getAttemptById(attempt.attemptId);
    expect(original?.status).toBe("DELIVERY_UNKNOWN");

    // New retry attempt should exist with correct identity
    const allAttempts = await store.getAttemptsByOperation(opId);
    expect(allAttempts.length).toBe(2);
    const retry = allAttempts.find((a) => a.attemptId !== attempt.attemptId);
    expect(retry).toBeDefined();
    expect(retry?.attemptNumber).toBe(2);
    expect(retry?.idempotencyKey).toBe(opId);
    expect(retry?.executionId).toBe(opId);
    expect(retry?.status).toBe("PENDING");

    // Job requeued
    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("PENDING");
  });
});


// ===========================================================================
// BLOCK 8/1 Repair #3D: Atomic ATTEMPTED → UNRESOLVABLE (NONE capability)
// ===========================================================================

describe("BLOCK 8/1 Repair #3D: Atomic NONE Recovery", () => {
  let store: ExecutionStore;
  let engine: PostSettlementEngine;

  function makeJob(overrides?: Partial<RecoveryJob>): RecoveryJob {
    const now = Date.now();
    return {
      jobId: `rj-none-${now}-${Math.random().toString(36).slice(2)}`,
      operationId: `op-none-${now}-${Math.random().toString(36).slice(2)}`,
      jobType: "EXECUTION",
      status: "PENDING",
      priority: 0,
      maxAttempts: 3,
      currentAttempt: 0,
      metadata: { capability: "NONE" },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function makeAttempt(operationId: string, overrides?: Partial<ExecutionAttempt>): ExecutionAttempt {
    const now = Date.now();
    return {
      attemptId: `att-none-${now}-${Math.random().toString(36).slice(2)}`,
      operationId,
      executionId: operationId,
      attemptNumber: 1,
      status: "ATTEMPTED",
      idempotencyKey: operationId,
      createdAt: now,
      startedAt: now,
      ...overrides,
    };
  }

  beforeEach(async () => {
    const { InMemoryExecutionStore } = await import("../src/core/post-settlement-engine");
    store = new InMemoryExecutionStore() as ExecutionStore;
    engine = new PostSettlementEngine(
      { append: async () => {} } as any,
      store,
      { async execute() { return { kind: "DELIVERY_UNKNOWN" as const, reason: "TIMEOUT" }; } },
      { workerId: "test-worker", sellerUrl: "https://seller.example.com", lockDurationMs: 30000 },
    );
  });

  test("current fence: ATTEMPTED + NONE → both attempt and job become UNRESOLVABLE", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const result = await engine.processJob(job.jobId);

    expect(result.finalStatus).toBe("UNRESOLVABLE");
    expect(result.success).toBe(false);

    const updatedAttempt = await store.getAttemptById(attempt.attemptId);
    expect(updatedAttempt?.status).toBe("UNRESOLVABLE");

    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("UNRESOLVABLE");
  });

  test("stale fence: Worker A cannot resolve after Worker B claims", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // Worker A claims fence 1
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Lease expires, Worker B claims fence 2
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Worker A tries atomic resolve with stale fence → REJECTED
    const resolved = await store.resolveAttemptUnresolvableIfOwner(
      job.jobId,
      attempt.attemptId,
      fence1!,
      "stale test",
      "stale test",
    );
    expect(resolved).toBe(false);

    // Verify neither attempt nor job were changed by stale worker
    const unchangedAttempt = await store.getAttemptById(attempt.attemptId);
    expect(unchangedAttempt?.status).toBe("ATTEMPTED");

    const unchangedJob = await store.getJob(job.jobId);
    expect(unchangedJob?.status).toBe("RUNNING"); // Still RUNNING from Worker B's claim
  });

  test("atomic primitive: resolveAttemptUnresolvableIfOwner succeeds with valid fence", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const fence = await store.claimJob(job.jobId, "worker-A", 30000);
    expect(fence).not.toBeNull();

    const resolved = await store.resolveAttemptUnresolvableIfOwner(
      job.jobId,
      attempt.attemptId,
      fence!,
      "test error",
      "test last error",
    );
    expect(resolved).toBe(true);

    const updatedAttempt = await store.getAttemptById(attempt.attemptId);
    expect(updatedAttempt?.status).toBe("UNRESOLVABLE");
    expect(updatedAttempt?.errorReason).toBe("test error");

    const updatedJob = await store.getJob(job.jobId);
    expect(updatedJob?.status).toBe("UNRESOLVABLE");
    expect(updatedJob?.lastError).toBe("test last error");
  });
});
