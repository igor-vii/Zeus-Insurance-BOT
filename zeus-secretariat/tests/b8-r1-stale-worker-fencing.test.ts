/**
 * BLOCK 8/1 Repair #1 — Stale Worker Fencing Tests
 *
 * Proves: after lease loss, old worker cannot modify durable execution state.
 */

import type { ExecutionStore, RecoveryJob, ExecutionAttempt } from "../src/core/post-settlement-engine";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("BLOCK 8/1 Repair #1: Stale Worker Fencing (PostgreSQL)", () => {
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

  test("R1-T1: stale worker cannot update job status after newer claim", async () => {
    const now = Date.now();
    const jobId = `rj-r1t1-${now}`;
    const opId = `op-r1t1-${now}`;

    // Create job
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, 0, '{}'::jsonb, NOW(), NOW())
    `);

    const store = new PES(db);

    // Worker A claims → generation 1
    const genA = await store.claimJob(jobId, "worker-A", 100); // 100ms lease
    expect(genA).toBe(1);

    // Wait for lease expiry
    await new Promise((r) => setTimeout(r, 150));

    // Worker B claims → generation 2
    const genB = await store.claimJob(jobId, "worker-B", 60000);
    expect(genB).toBe(2);

    // Worker A tries to update with stale generation → REJECTED
    const staleResult = await store.updateJobStatus(jobId, "COMPLETED", genA!);
    expect(staleResult).toBe(false);

    // Verify job is still RUNNING (not COMPLETED)
    const check = await db.execute(sql`SELECT status FROM recovery_jobs WHERE job_id = ${jobId}`);
    expect((check as any[])[0]?.status).toBe("RUNNING");

    // Worker B updates with current generation → ACCEPTED
    const currentResult = await store.updateJobStatus(jobId, "COMPLETED", genB!);
    expect(currentResult).toBe(true);

    // Verify now COMPLETED
    const check2 = await db.execute(sql`SELECT status FROM recovery_jobs WHERE job_id = ${jobId}`);
    expect((check2 as any[])[0]?.status).toBe("COMPLETED");

    // Cleanup
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("R1-T2: terminal job state cannot be reopened by any worker", async () => {
    const now = Date.now();
    const jobId = `rj-r1t2-${now}`;
    const opId = `op-r1t2-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, locked_by, locked_until, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"COMPLETED"}, 0, 3, 1, 5, ${"worker-C"}, NOW() + INTERVAL '1 hour', '{}'::jsonb, NOW(), NOW())
    `);

    const store = new PES(db);

    // Even with valid fence generation, cannot reopen COMPLETED
    const result = await store.updateJobStatus(jobId, "PENDING", 5);
    expect(result).toBe(false);

    // Verify still COMPLETED
    const check = await db.execute(sql`SELECT status FROM recovery_jobs WHERE job_id = ${jobId}`);
    expect((check as any[])[0]?.status).toBe("COMPLETED");

    // Cleanup
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("R1-T3: stale worker cannot update attempt status after newer claim", async () => {
    const now = Date.now();
    const jobId = `rj-r1t3-${now}`;
    const opId = `op-r1t3-${now}`;
    const attId = `att-r1t3-${now}`;

    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, 0, '{}'::jsonb, NOW(), NOW())
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"ATTEMPTED"}, ${opId}, NOW())
    `);

    const store = new PES(db);

    // Worker A claims gen 1
    const genA = await store.claimJob(jobId, "worker-A", 100);
    // Lease expires
    await new Promise((r) => setTimeout(r, 150));
    // Worker B claims gen 2
    const genB = await store.claimJob(jobId, "worker-B", 60000);

    // Worker A tries to set SUCCESS with stale fence → REJECTED
    const staleResult = await store.updateAttemptStatus(attId, "SUCCESS", genA!, { completedAt: now });
    expect(staleResult).toBe(false);

    // Verify still ATTEMPTED
    const check = await db.execute(sql`SELECT status FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect((check as any[])[0]?.status).toBe("ATTEMPTED");

    // Worker B sets SUCCESS with current fence → ACCEPTED
    const currentResult = await store.updateAttemptStatus(attId, "SUCCESS", genB!, { completedAt: now });
    expect(currentResult).toBe(true);

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });
});
