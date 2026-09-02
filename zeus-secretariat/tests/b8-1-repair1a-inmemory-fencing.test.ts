/**
 * BLOCK 8/1 Repair #1A — InMemoryExecutionStore Fencing Parity Tests
 *
 * Proves that InMemoryExecutionStore enforces the same fencing contract
 * as PostgresExecutionStore: stale workers cannot mutate state.
 */

import type { ExecutionStore, ExecutionAttempt, RecoveryJob } from "../src/core/post-settlement-engine";

describe("BLOCK 8/1 Repair #1A: InMemory Fencing Parity", () => {
  let store: ExecutionStore;

  beforeEach(async () => {
    const { InMemoryExecutionStore } = await import("../src/core/post-settlement-engine");
    store = new InMemoryExecutionStore() as ExecutionStore;
  });

  function makeJob(overrides?: Partial<RecoveryJob>): RecoveryJob {
    const now = Date.now();
    return {
      jobId: `rj-fence-${now}`,
      operationId: `op-fence-${now}`,
      jobType: "EXECUTION",
      status: "PENDING",
      priority: 0,
      maxAttempts: 3,
      currentAttempt: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function makeAttempt(operationId: string, overrides?: Partial<ExecutionAttempt>): ExecutionAttempt {
    const now = Date.now();
    return {
      attemptId: `att-fence-${now}-${Math.random().toString(36).slice(2)}`,
      operationId,
      executionId: operationId,
      attemptNumber: 1,
      status: "PENDING",
      idempotencyKey: operationId,
      createdAt: now,
      ...overrides,
    };
  }

  test("generation N → updateAttemptStatus succeeds", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const fence = await store.claimJob(job.jobId, "worker-A", 30000);
    expect(fence).not.toBeNull();

    const result = await store.updateAttemptStatus(attempt.attemptId, "ATTEMPTED", fence!, { startedAt: Date.now() });
    expect(result).toBe(true);

    const updated = await store.getAttemptById(attempt.attemptId);
    expect(updated?.status).toBe("ATTEMPTED");
  });

  test("generation N+1 → updateAttemptStatus succeeds after re-claim", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // Worker A claims generation 1
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Simulate lease expiry
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;

    // Worker B claims generation 2
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Worker B can update with generation 2
    const result = await store.updateAttemptStatus(attempt.attemptId, "ATTEMPTED", fence2!, { startedAt: Date.now() });
    expect(result).toBe(true);
  });

  test("generation N → stale mutation rejected after N+1 claimed", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // Worker A claims generation 1
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Simulate lease expiry
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;

    // Worker B claims generation 2
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Worker A tries to update with stale generation 1 → REJECTED
    const staleResult = await store.updateAttemptStatus(attempt.attemptId, "SUCCESS", fence1!);
    expect(staleResult).toBe(false);

    // Verify attempt status unchanged (still PENDING since worker B hasn't updated yet)
    const unchanged = await store.getAttemptById(attempt.attemptId);
    expect(unchanged?.status).toBe("PENDING");
  });

  test("terminal state → stale generation cannot change it", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    // Worker A claims and sets SUCCESS
    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    await store.updateAttemptStatus(attempt.attemptId, "SUCCESS", fence1!);

    // Simulate lease expiry + Worker B claims
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);

    // Worker B tries to change SUCCESS → DELIVERY_UNKNOWN → REJECTED (terminal monotonicity)
    const result = await store.updateAttemptStatus(attempt.attemptId, "DELIVERY_UNKNOWN", fence2!);
    expect(result).toBe(false);

    // Verify still SUCCESS
    const final = await store.getAttemptById(attempt.attemptId);
    expect(final?.status).toBe("SUCCESS");
  });

  test("stale worker cannot updateJobStatus", async () => {
    const job = makeJob();
    await store.saveJob(job);

    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);
    expect(fence1).toBe(1);

    // Expire + re-claim
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).toBe(2);

    // Stale worker A tries updateJobStatus → REJECTED
    const staleResult = await store.updateJobStatus(job.jobId, "COMPLETED", fence1!);
    expect(staleResult).toBe(false);

    // Current worker B can update → ACCEPTED
    const currentResult = await store.updateJobStatus(job.jobId, "COMPLETED", fence2!);
    expect(currentResult).toBe(true);

    const updated = await store.getJob(job.jobId);
    expect(updated?.status).toBe("COMPLETED");
  });

  test("stale worker cannot markAttemptInProgress", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const attempt = makeAttempt(job.operationId);
    await store.saveAttempt(attempt);

    const fence1 = await store.claimJob(job.jobId, "worker-A", 100);

    // Expire + re-claim
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);

    // Stale worker A tries markAttemptInProgress → REJECTED
    const staleResult = await store.markAttemptInProgress(attempt.attemptId, fence1!);
    expect(staleResult).toBe(false);

    // Current worker B can mark → ACCEPTED
    const currentResult = await store.markAttemptInProgress(attempt.attemptId, fence2!);
    expect(currentResult).toBe(true);

    const updated = await store.getAttemptById(attempt.attemptId);
    expect(updated?.status).toBe("ATTEMPTED");
  });
});
