/**
 * BLOCK 8 R2.2 Repair #9 — Execution Safety Tests
 *
 * Proves: lease fencing, stale-worker protection, terminal monotonicity,
 * IN_PROGRESS transition, UNKNOWN preservation, idempotency key stability.
 */

import { PostSettlementEngine } from "../src/core/post-settlement-engine";
import type { ExecutionStore, ExecutionAttempt, RecoveryJob, ExecutionObligationStatus } from "../src/core/post-settlement-engine";
import type { SellerExecutionAdapter, SellerExecutionRequest, SellerExecutionResult } from "../src/adapters/seller-execution-adapter";
import { sql } from "drizzle-orm";

// ===========================================================================
// Shared test fixtures
// ===========================================================================

function makeAttempt(overrides?: Partial<ExecutionAttempt>): ExecutionAttempt {
  const now = Date.now();
  return {
    attemptId: `att-${now}`,
    operationId: `op-${now}`,
    executionId: `exec-${now}`,
    attemptNumber: 1,
    status: "PENDING",
    idempotencyKey: `exec-${now}`,
    createdAt: now,
    ...overrides,
  };
}

function makeJob(overrides?: Partial<RecoveryJob>): RecoveryJob {
  const now = Date.now();
  return {
    jobId: `rj-${now}`,
    operationId: `op-${now}`,
    jobType: "EXECUTION",
    status: "PENDING",
    priority: 0,
    maxAttempts: 3,
    currentAttempt: 0,
    metadata: { capability: "EXECUTION_IDEMPOTENT" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ===========================================================================
// T1-T5: Fencing and Stale Worker Tests (using InMemoryExecutionStore)
// ===========================================================================

describe("R2.2-R9: Lease Fencing & Stale Worker Protection", () => {
  let engine: PostSettlementEngine;
  let store: ExecutionStore;
  let mockAdapter: SellerExecutionAdapter;

  beforeEach(() => {
    // Use the InMemoryExecutionStore via PostSettlementEngine constructor
    const { InMemoryExecutionStore } = require("../src/core/post-settlement-engine");
    store = new InMemoryExecutionStore();
    mockAdapter = {
      async execute(req: SellerExecutionRequest): Promise<SellerExecutionResult> {
        return { kind: "SUCCESS", statusCode: 200, body: "", headers: {} };
      },
    };
    engine = new PostSettlementEngine(store as any, store as any, mockAdapter, {
      workerId: "worker-test",
      sellerUrl: "https://seller.example.com",
      lockDurationMs: 30000,
      maxExecutionAttempts: 3,
    });
  });

  test("T1: sequential claims increment fence generation", async () => {
    const job = makeJob();
    await store.saveJob(job);

    // First claim
    const fence1 = await store.claimJob(job.jobId, "worker-A", 30000);
    expect(fence1).not.toBeNull();

    // Simulate lease expiry for second claim
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) {
      savedJob.lockedUntil = Date.now() - 1000; // expired
    }

    // Second claim should get higher generation
    const fence2 = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fence2).not.toBeNull();
    expect(fence2!).toBeGreaterThan(fence1!);
  });

  test("T2: stale worker cannot update attempt status", async () => {
    const job = makeJob();
    const attempt = makeAttempt({ operationId: job.operationId });
    await store.saveJob(job);
    await store.saveAttempt(attempt);

    // Worker A claims fence N
    const fenceA = await store.claimJob(job.jobId, "worker-A", 30000);
    expect(fenceA).not.toBeNull();

    // Simulate lease expiry + Worker B claims fence N+1
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fenceB = await store.claimJob(job.jobId, "worker-B", 30000);
    expect(fenceB).not.toBeNull();
    expect(fenceB!).toBeGreaterThan(fenceA!);

    // Worker A tries to update with old fence → REJECTED
    const result = await store.updateAttemptStatus(attempt.attemptId, "SUCCESS", fenceA!);
    expect(result).toBe(false);
  });

  test("T3: current worker can update attempt status", async () => {
    const job = makeJob();
    const attempt = makeAttempt({ operationId: job.operationId });
    await store.saveJob(job);
    await store.saveAttempt(attempt);

    const fence = await store.claimJob(job.jobId, "worker-A", 30000);
    expect(fence).not.toBeNull();

    const result = await store.updateAttemptStatus(attempt.attemptId, "ATTEMPTED", fence!, { startedAt: Date.now() });
    expect(result).toBe(true);
  });

  test("T4: terminal state SUCCESS cannot be reopened", async () => {
    const job = makeJob();
    const attempt = makeAttempt({ operationId: job.operationId });
    await store.saveJob(job);
    await store.saveAttempt(attempt);

    const fence = await store.claimJob(job.jobId, "worker-A", 30000);
    expect(fence).not.toBeNull();

    // Transition to SUCCESS
    const ok = await store.updateAttemptStatus(attempt.attemptId, "SUCCESS", fence!);
    expect(ok).toBe(true);

    // Try to reopen → all must fail
    const retry1 = await store.updateAttemptStatus(attempt.attemptId, "ATTEMPTED", fence!);
    expect(retry1).toBe(false);

    const retry2 = await store.updateAttemptStatus(attempt.attemptId, "DELIVERY_UNKNOWN", fence!);
    expect(retry2).toBe(false);

    const retry3 = await store.updateAttemptStatus(attempt.attemptId, "HTTP_FAILURE", fence!);
    expect(retry3).toBe(false);
  });

  test("T5: stale worker cannot overwrite terminal state", async () => {
    const job = makeJob();
    const attempt = makeAttempt({ operationId: job.operationId });
    await store.saveJob(job);
    await store.saveAttempt(attempt);

    // Worker A claims and sets SUCCESS
    const fenceA = await store.claimJob(job.jobId, "worker-A", 30000);
    await store.updateAttemptStatus(attempt.attemptId, "SUCCESS", fenceA!);

    // Worker B claims after lease expiry
    const savedJob = await store.getJob(job.jobId);
    if (savedJob) savedJob.lockedUntil = Date.now() - 1000;
    const fenceB = await store.claimJob(job.jobId, "worker-B", 30000);

    // Worker B tries to change SUCCESS → DELIVERY_UNKNOWN → REJECTED (terminal monotonicity)
    const result = await store.updateAttemptStatus(attempt.attemptId, "DELIVERY_UNKNOWN", fenceB!);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// T6: Explicit IN_PROGRESS transition
// ===========================================================================

describe("R2.2-R9: IN_PROGRESS Transition", () => {
  test("T6: markAttemptInProgress transitions PENDING → ATTEMPTED", async () => {
    const { InMemoryExecutionStore } = require("../src/core/post-settlement-engine");
    const store = new InMemoryExecutionStore() as ExecutionStore;
    const attempt = makeAttempt();
    await store.saveAttempt(attempt);

    const marked = await store.markAttemptInProgress(attempt.attemptId, 1);
    expect(marked).toBe(true);

    const updated = await store.getAttemptById(attempt.attemptId);
    expect(updated?.status).toBe("ATTEMPTED");
  });
});

// ===========================================================================
// T7-T9: UNKNOWN Preservation & Idempotency Key
// ===========================================================================

describe("R2.2-R9: UNKNOWN Preservation & Idempotency", () => {
  test("T7: adapter classifies timeout as DELIVERY_UNKNOWN not HTTP_FAILURE", async () => {
    const { HttpSellerExecutionAdapter } = require("../src/adapters/seller-execution-adapter");
    const adapter = new HttpSellerExecutionAdapter(100); // 100ms timeout

    // This will timeout since URL is unreachable
    const result = await adapter.execute({
      url: "http://192.0.2.1:1/unreachable", // RFC 5737 TEST-NET, guaranteed unreachable
      method: "POST",
      idempotencyKey: "test-key",
    });

    expect(result.kind).toBe("DELIVERY_UNKNOWN");
    expect(result.kind).not.toBe("HTTP_FAILURE");
  });

  test("T8: idempotency key remains stable across retries", async () => {
    const { InMemoryExecutionStore } = require("../src/core/post-settlement-engine");
    const store = new InMemoryExecutionStore() as ExecutionStore;
    const opId = "op-stable-key";
    const execId = "exec-stable-key";

    // Attempt 1 — explicit unique attemptId to avoid Date.now() collision
    const att1 = makeAttempt({ attemptId: "att-stable-1", operationId: opId, executionId: execId, attemptNumber: 1, idempotencyKey: execId });
    await store.saveAttempt(att1);

    // Attempt 2 (retry) — same executionId, same idempotencyKey, different attemptId
    const att2 = makeAttempt({ attemptId: "att-stable-2", operationId: opId, executionId: execId, attemptNumber: 2, idempotencyKey: execId });
    await store.saveAttempt(att2);

    const attempts = await store.getAttemptsByOperation(opId);
    expect(attempts[0].idempotencyKey).toBe(attempts[1].idempotencyKey);
    expect(attempts[0].idempotencyKey).toBe(execId);
  });

  test("T9: HTTP adapter sends Idempotency-Key header", async () => {
    // Verify by inspecting source code
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../src/adapters/seller-execution-adapter.ts"),
      "utf-8",
    );
    expect(src).toMatch(/Idempotency-Key.*request\.idempotencyKey/);
  });
});

// ===========================================================================
// T10-T12: Real PostgreSQL Integration Tests
// ===========================================================================

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("R2.2-R9: PostgreSQL Fencing Integration", () => {
  let db: any;
  let PES: any;

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    const mod = await import("../src/store/postgres-execution-store");
    PES = mod.PostgresExecutionStore;
  });

  test("T10: concurrent claims produce different fence generations", async () => {
    const now = Date.now();
    const jobId = `rj-fence-${now}`;
    const opId = `op-fence-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, 0, '{}'::jsonb, NOW(), NOW())
    `);

    const store = new PES(db);

    // Worker A claims
    const fenceA = await store.claimJob(jobId, "worker-A", 30000);
    expect(fenceA).not.toBeNull();

    // Expire lease
    await db.execute(sql`UPDATE recovery_jobs SET locked_until = NOW() - INTERVAL '1 second' WHERE job_id = ${jobId}`);

    // Worker B claims
    const fenceB = await store.claimJob(jobId, "worker-B", 30000);
    expect(fenceB).not.toBeNull();
    expect(fenceB).toBeGreaterThan(fenceA);

    // Cleanup
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("T11: stale fence rejected on updateAttemptStatus", async () => {
    const now = Date.now();
    const jobId = `rj-stale-${now}`;
    const opId = `op-stale-${now}`;
    const attId = `att-stale-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, 0, '{}'::jsonb, NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"PENDING"}, ${opId}, NOW())
    `);

    const store = new PES(db);

    // Worker A claims fence 1
    const fenceA = await store.claimJob(jobId, "worker-A", 30000);

    // Expire + Worker B claims fence 2
    await db.execute(sql`UPDATE recovery_jobs SET locked_until = NOW() - INTERVAL '1 second' WHERE job_id = ${jobId}`);
    const fenceB = await store.claimJob(jobId, "worker-B", 30000);

    // Worker A tries update with stale fence → REJECTED
    const staleResult = await store.updateAttemptStatus(attId, "SUCCESS", fenceA);
    expect(staleResult).toBe(false);

    // Worker B updates with current fence → ACCEPTED
    const currentResult = await store.updateAttemptStatus(attId, "ATTEMPTED", fenceB, { startedAt: Date.now() });
    expect(currentResult).toBe(true);

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("T12: terminal state cannot be overwritten even with valid fence", async () => {
    const now = Date.now();
    const jobId = `rj-term-${now}`;
    const opId = `op-term-${now}`;
    const attId = `att-term-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, 0, '{}'::jsonb, NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"PENDING"}, ${opId}, NOW())
    `);

    const store = new PES(db);
    const fence = await store.claimJob(jobId, "worker-A", 30000);

    // Set to SUCCESS
    const ok = await store.updateAttemptStatus(attId, "SUCCESS", fence);
    expect(ok).toBe(true);

    // Try to overwrite SUCCESS → REJECTED (monotonicity)
    const overwrite = await store.updateAttemptStatus(attId, "DELIVERY_UNKNOWN", fence);
    expect(overwrite).toBe(false);

    // Verify still SUCCESS
    const check = await db.execute(sql`SELECT status FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect((check as any[])[0]?.status).toBe("SUCCESS");

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });
});
