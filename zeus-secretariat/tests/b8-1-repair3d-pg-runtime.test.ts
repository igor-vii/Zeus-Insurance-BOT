/**
 * BLOCK 8/1 Repair #3D-A — PostgreSQL Runtime Tests for resolveAttemptUnresolvableIfOwner
 *
 * Proves atomic NONE-capability recovery primitive against real PostgreSQL:
 *   1. Current fence → success, both attempt and job become UNRESOLVABLE
 *   2. Stale fence → rejected, no state changes
 *   3. Operation binding mismatch → rejected, no state changes
 *   4. Atomic rollback → partial state impossible
 */

import { sql } from "drizzle-orm";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("Repair #3D-A: PostgreSQL resolveAttemptUnresolvableIfOwner", () => {
  let db: any;
  let PES: any;

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    const mod = await import("../src/store/postgres-execution-store");
    PES = mod.PostgresExecutionStore;
  });

  function resultRows(result: any): any[] {
    return Array.isArray(result) ? result : (result?.rows ?? []);
  }

  test("1. Current fence: ATTEMPTED → UNRESOLVABLE (attempt + job)", async () => {
    const now = Date.now();
    const opId = `op-3da-cur-${now}`;
    const jobId = `rj-3da-cur-${now}`;
    const attId = `att-3da-cur-${now}`;

    // Setup: create recovery job with fence_generation = 0
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 1, '{}'::jsonb, NOW(), NOW())
    `);

    // Setup: create ATTEMPTED execution attempt
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, started_at, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"ATTEMPTED"}, ${opId}, NOW(), NOW())
    `);

    const store = new PES(db);

    // Execute with correct fence generation
    const resolved = await store.resolveAttemptUnresolvableIfOwner(
      jobId, attId, 1, "test-error-reason", "test-job-last-error"
    );
    expect(resolved).toBe(true);

    // Verify attempt → UNRESOLVABLE
    const attCheck = resultRows(await db.execute(sql`
      SELECT status, error_reason FROM execution_attempts WHERE attempt_id = ${attId}
    `));
    expect(attCheck[0]?.status).toBe("UNRESOLVABLE");
    expect(attCheck[0]?.error_reason).toBe("test-error-reason");

    // Verify job → UNRESOLVABLE
    const jobCheck = resultRows(await db.execute(sql`
      SELECT status, last_error FROM recovery_jobs WHERE job_id = ${jobId}
    `));
    expect(jobCheck[0]?.status).toBe("UNRESOLVABLE");
    expect(jobCheck[0]?.last_error).toBe("test-job-last-error");

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("2. Stale fence: rejected, no state changes", async () => {
    const now = Date.now();
    const opId = `op-3da-stale-${now}`;
    const jobId = `rj-3da-stale-${now}`;
    const attId = `att-3da-stale-${now}`;

    // Setup: job with fence_generation = 5
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 5, 5, '{}'::jsonb, NOW(), NOW())
    `);

    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, started_at, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"ATTEMPTED"}, ${opId}, NOW(), NOW())
    `);

    const store = new PES(db);

    // Try with STALE fence generation (3 instead of 5)
    const resolved = await store.resolveAttemptUnresolvableIfOwner(
      jobId, attId, 3, "stale-error", "stale-job-error"
    );
    expect(resolved).toBe(false);

    // Verify attempt UNCHANGED (still ATTEMPTED)
    const attCheck = resultRows(await db.execute(sql`
      SELECT status, error_reason FROM execution_attempts WHERE attempt_id = ${attId}
    `));
    expect(attCheck[0]?.status).toBe("ATTEMPTED");
    expect(attCheck[0]?.error_reason).toBeNull();

    // Verify job UNCHANGED (still RUNNING)
    const jobCheck = resultRows(await db.execute(sql`
      SELECT status, last_error FROM recovery_jobs WHERE job_id = ${jobId}
    `));
    expect(jobCheck[0]?.status).toBe("RUNNING");
    expect(jobCheck[0]?.last_error).toBeNull();

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("3. Operation binding mismatch: rejected, no state changes", async () => {
    const now = Date.now();
    const jobOpId = `op-3da-bind-job-${now}`;
    const attOpId = `op-3da-bind-att-${now}`; // DIFFERENT operation_id
    const jobId = `rj-3da-bind-${now}`;
    const attId = `att-3da-bind-${now}`;

    // Setup: job with one operation_id
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${jobOpId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 1, '{}'::jsonb, NOW(), NOW())
    `);

    // Setup: attempt with DIFFERENT operation_id
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, started_at, created_at)
      VALUES (${attId}, ${attOpId}, ${attOpId}, 1, ${"ATTEMPTED"}, ${attOpId}, NOW(), NOW())
    `);

    const store = new PES(db);

    // Correct fence but mismatched operation_id
    const resolved = await store.resolveAttemptUnresolvableIfOwner(
      jobId, attId, 1, "bind-error", "bind-job-error"
    );
    expect(resolved).toBe(false);

    // Verify attempt UNCHANGED
    const attCheck = resultRows(await db.execute(sql`
      SELECT status FROM execution_attempts WHERE attempt_id = ${attId}
    `));
    expect(attCheck[0]?.status).toBe("ATTEMPTED");

    // Verify job UNCHANGED
    const jobCheck = resultRows(await db.execute(sql`
      SELECT status FROM recovery_jobs WHERE job_id = ${jobId}
    `));
    expect(jobCheck[0]?.status).toBe("RUNNING");

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });

  test("4. Atomic rollback: no partial state on failure", async () => {
    const now = Date.now();
    const opId = `op-3da-atom-${now}`;
    const jobId = `rj-3da-atom-${now}`;
    const attId = `att-3da-atom-${now}`;

    // Setup: job with fence_generation = 1
    await db.execute(sql`
      INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, fence_generation, metadata, created_at, updated_at)
      VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"RUNNING"}, 0, 3, 1, 1, '{}'::jsonb, NOW(), NOW())
    `);

    // Setup: attempt already in terminal state SUCCESS
    // This will cause the UPDATE to affect 0 rows → transaction returns false
    // The key test: even though the lock succeeded, the attempt update fails,
    // so the job must NOT be changed either (atomic rollback).
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, started_at, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"SUCCESS"}, ${opId}, NOW(), NOW())
    `);

    const store = new PES(db);

    // Attempt is already SUCCESS (terminal) → UPDATE affects 0 rows → returns false
    const resolved = await store.resolveAttemptUnresolvableIfOwner(
      jobId, attId, 1, "atomic-error", "atomic-job-error"
    );
    expect(resolved).toBe(false);

    // CRITICAL: Job must remain RUNNING despite successful lock
    // If the transaction were not atomic, the job UPDATE would have committed
    const jobCheck = resultRows(await db.execute(sql`
      SELECT status, last_error FROM recovery_jobs WHERE job_id = ${jobId}
    `));
    expect(jobCheck[0]?.status).toBe("RUNNING");
    expect(jobCheck[0]?.last_error).toBeNull();

    // Attempt must remain SUCCESS (unchanged)
    const attCheck = resultRows(await db.execute(sql`
      SELECT status FROM execution_attempts WHERE attempt_id = ${attId}
    `));
    expect(attCheck[0]?.status).toBe("SUCCESS");

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${jobId}`);
  });
});
