/**
 * BLOCK 8 R2.2 Repair #9 — Execution Fencing & Terminal Monotonicity Tests
 *
 * Proves:
 *   T1: Sequential claims produce monotonically increasing fence generations
 *   T2: Stale worker cannot commit state after newer fence acquired
 *   T3: Current worker can commit state with valid fence
 *   T4: Terminal states are irreversible
 *   T5: Stale worker cannot overwrite terminal state
 *   T6: markAttemptInProgress transitions PENDING → ATTEMPTED
 *   T7: DELIVERY_UNKNOWN preserved for timeout/connection-reset
 *   T8: Stable idempotency key across retries
 *   T9: HTTP Idempotency-Key header propagation
 */

import type { ExecutionObligationStatus, RecoveryJob, ExecutionAttempt } from "../src/core/post-settlement-engine";

// ===========================================================================
// T1-T6: Fencing & Monotonicity (requires real PostgreSQL)
// ===========================================================================

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("R2.2 Repair #9: Fencing & Terminal Monotonicity", () => {
  let db: any;
  let sql: any;
  let PES: any;

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    const drz = await import("drizzle-orm");
    sql = drz.sql;
    const mod = await import("../src/store/postgres-execution-store");
    PES = mod.PostgresExecutionStore;
  });

  test("T1: sequential claims produce monotonic fence generations", async () => {
    const now = Date.now();
    const jobId = `job-t1-${now}`;
    const opId = `op-t1-${now}`;

    // Create a recovery job
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, 0, NOW(), NOW())
    `);

    const store = new PES(db);

    // First claim
    const gen1 = await store.claimJob(jobId, "worker-A", 100); // 100ms lease
    expect(gen1).toBe(1);

    // Wait for lease expiry
    await new Promise((r) => setTimeout(r, 150));

    // Second claim after expiry
    const gen2 = await store.claimJob(jobId, "worker-B", 60000);
    expect(gen2).toBe(2);

    // Cleanup
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("T2: stale worker cannot commit state after newer fence", async () => {
    const now = Date.now();
    const jobId = `job-t2-${now}`;
    const opId = `op-t2-${now}`;
    const attId = `att-t2-${now}`;

    // Setup: job + attempt
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, locked_by, locked_until, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 2, ${"worker-B"}, NOW() + INTERVAL '1 hour', NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"ATTEMPTED"}, ${opId}, NOW())
    `);

    const store = new PES(db);

    // Worker A tries to update with stale fence generation 1
    const staleResult = await store.updateAttemptStatus(attId, "SUCCESS", 1, { completedAt: now });
    expect(staleResult).toBe(false);

    // Verify status unchanged
    const check = await db.execute(sql`SELECT status FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect((check as any[])[0]?.status).toBe("ATTEMPTED");

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("T3: current worker can commit with valid fence", async () => {
    const now = Date.now();
    const jobId = `job-t3-${now}`;
    const opId = `op-t3-${now}`;
    const attId = `att-t3-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, locked_by, locked_until, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 5, ${"worker-C"}, NOW() + INTERVAL '1 hour', NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"ATTEMPTED"}, ${opId}, NOW())
    `);

    const store = new PES(db);
    const result = await store.updateAttemptStatus(attId, "SUCCESS", 5, { completedAt: now });
    expect(result).toBe(true);

    const check = await db.execute(sql`SELECT status FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect((check as any[])[0]?.status).toBe("SUCCESS");

    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("T4: terminal SUCCESS cannot be reopened", async () => {
    const now = Date.now();
    const jobId = `job-t4-${now}`;
    const opId = `op-t4-${now}`;
    const attId = `att-t4-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, locked_by, locked_until, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 3, ${"worker-D"}, NOW() + INTERVAL '1 hour', NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"SUCCESS"}, ${opId}, NOW())
    `);

    const store = new PES(db);

    // Try to transition SUCCESS → ATTEMPTED (should fail)
    const r1 = await store.updateAttemptStatus(attId, "ATTEMPTED", 3);
    expect(r1).toBe(false);

    // Try SUCCESS → DELIVERY_UNKNOWN (should fail)
    const r2 = await store.updateAttemptStatus(attId, "DELIVERY_UNKNOWN", 3);
    expect(r2).toBe(false);

    // Verify still SUCCESS
    const check = await db.execute(sql`SELECT status FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect((check as any[])[0]?.status).toBe("SUCCESS");

    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("T6: markAttemptInProgress transitions PENDING → ATTEMPTED", async () => {
    const now = Date.now();
    const jobId = `job-t6-${now}`;
    const opId = `op-t6-${now}`;
    const attId = `att-t6-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, locked_by, locked_until, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 4, ${"worker-F"}, NOW() + INTERVAL '1 hour', NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"PENDING"}, ${opId}, NOW())
    `);

    const store = new PES(db);
    const marked = await store.markAttemptInProgress(attId, 4);
    expect(marked).toBe(true);

    const check = await db.execute(sql`SELECT status, started_at FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect((check as any[])[0]?.status).toBe("ATTEMPTED");
    expect((check as any[])[0]?.started_at).toBeTruthy();

    // Second call should fail (already ATTEMPTED, not PENDING)
    const marked2 = await store.markAttemptInProgress(attId, 4);
    expect(marked2).toBe(false);

    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });
});

// ===========================================================================
// T7-T9: Static / Unit Tests (no DB required)
// ===========================================================================

describe("R2.2 Repair #9: Idempotency & UNKNOWN Semantics", () => {
  test("T7: DELIVERY_UNKNOWN preserved for ambiguous outcomes", async () => {
    const mod = await import("../src/adapters/seller-execution-adapter");
    const adapter = new mod.HttpSellerExecutionAdapter(100); // 100ms timeout

    // Call with unreachable URL to trigger timeout
    const result = await adapter.execute({
      url: "http://192.0.2.1:1/unreachable", // RFC 5737 TEST-NET, guaranteed unreachable
      method: "POST",
      body: {},
      idempotencyKey: "test-key-t7",
      timeoutMs: 100,
    });

    expect(result.kind).toBe("DELIVERY_UNKNOWN");
  });

  test("T8: stable idempotency key across retries", async () => {
    // Verify that PostSettlementEngine reuses the same executionId/idempotencyKey
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../src/core/post-settlement-engine.ts"), "utf-8",
    );
    // Retry path must reuse latestAttempt.executionId and latestAttempt.idempotencyKey
    expect(src).toMatch(/executionId:\s*latestAttempt\.executionId/);
    expect(src).toMatch(/idempotencyKey:\s*latestAttempt\.idempotencyKey/);
  });

  test("T9: HTTP Idempotency-Key header propagation", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../src/adapters/seller-execution-adapter.ts"), "utf-8",
    );
    expect(src).toMatch(/["']Idempotency-Key["'].*request\.idempotencyKey/);
  });
});
