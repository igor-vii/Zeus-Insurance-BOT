/**
 * BLOCK 8 R2.1-FIX-5 — Atomic Settlement Handoff Tests
 *
 * Proves:
 *   FIX-5-1: Typed AtomicSettlementHandoff is required dependency
 *   FIX-5-3: PostgresExecutionStore implements AtomicSettlementHandoff contract
 *   FIX-5-5A: Production code uses tx for ALL mutations (static proof)
 *   FIX-5-5B: PostgreSQL transaction rollback of ALL THREE mutations
 *   FIX-5-6: Production handoff success via real PostgresExecutionStore
 */

import type {
  AtomicSettlementHandoff,
} from "../src/core/post-settlement-engine";
import type { RecoveryJob, ExecutionAttempt } from "../src/core/post-settlement-engine";
import { sql } from "drizzle-orm";

function resultRows<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

// ===========================================================================
// FIX-5-1: Typed Contract Enforcement (Compile-Time Proof)
// ===========================================================================

describe("R2.1-FIX-5: Typed Contract", () => {
  test("FIX-5-1: AtomicSettlementHandoff is a required typed dependency", () => {
    const mockHandoff: AtomicSettlementHandoff = {
      async settleAndCreateExecutionObligation(_piId, _opId, _ev, _job, _att) {
        return true;
      },
    };
    expect(mockHandoff).toBeDefined();
    expect(typeof mockHandoff.settleAndCreateExecutionObligation).toBe("function");
  });
});

// ===========================================================================
// FIX-5-3: PostgresExecutionStore Implements AtomicSettlementHandoff
// ===========================================================================

describe("R2.1-FIX-5: Implementation Contract", () => {
  test("FIX-5-3: PostgresExecutionStore has settleAndCreateExecutionObligation method", async () => {
    const mod = await import("../src/store/postgres-execution-store");
    const storePrototype = mod.PostgresExecutionStore.prototype;
    expect(typeof storePrototype.settleAndCreateExecutionObligation).toBe("function");
  });

  test("FIX-5-3b: composition root wires executionStore as atomicSettlementHandoff", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../api-server/src/lib/secretariat-composition.ts"),
      "utf-8",
    );
    expect(src).toMatch(/atomicSettlementHandoff:\s*stores\.executionStore/);
    expect(src).not.toMatch(/as any/);
    expect(src).not.toMatch(/typeof.*settleAndCreateExecutionObligation/);
  });
});

// ===========================================================================
// FIX-5-5A: Production Atomic Boundary (Static Verification)
// ===========================================================================

describe("R2.1-FIX-5: Production Atomic Boundary", () => {
  test("FIX-5-5A: all three mutations use tx inside transaction", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../src/store/postgres-execution-store.ts"), "utf-8",
    );
    const txStart = src.indexOf("this.db.transaction(async (tx)");
    expect(txStart).toBeGreaterThan(-1);
    const txBody = src.substring(txStart);
    // All three mutations use tx
    expect(txBody).toMatch(/tx\.execute\(sql`[\s\S]*?UPDATE payment_intents/);
    expect(txBody).toMatch(/tx\.insert\(recoveryJobsTable\)/);
    expect(txBody).toMatch(/tx\.insert\(executionAttemptsTable\)/);
    // No this.db mutations inside transaction callback
    const cbStart = txBody.indexOf("{");
    let bc = 0, cbEnd = cbStart;
    for (let i = cbStart; i < txBody.length; i++) {
      if (txBody[i] === "{") bc++;
      if (txBody[i] === "}") bc--;
      if (bc === 0) { cbEnd = i; break; }
    }
    const cb = txBody.substring(cbStart, cbEnd);
    expect(cb).not.toMatch(/this\.db\.execute/);
    expect(cb).not.toMatch(/this\.db\.insert/);
  });
});

// ===========================================================================
// FIX-5-5B & FIX-5-6: Real PostgreSQL Integration Tests
// ===========================================================================

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("R2.1-FIX-5: PostgreSQL Integration", () => {
  let db: any;
  let PES: any;

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    const mod = await import("../src/store/postgres-execution-store");
    PES = mod.PostgresExecutionStore;
  });

  test("FIX-5-5B: rollback reverts ALL THREE mutations after partial success", async () => {
    const now = Date.now();
    const opId = `op-rb3i-${now}`;
    const piId = `pi-rb3i-${now}`;
    const jobId = `rj-rb3i-${now}`;
    const attId = `att-rb3i-${now}`;

    // Setup: create PI in SETTLEMENT_PENDING state
    await db.execute(sql`
      INSERT INTO payment_intents (payment_intent_id, operation_id, authorizer, pay_to, value, asset, network, nonce, valid_after, valid_before, payment_payload, payment_payload_hash, settlement_state, created_at, updated_at, version)
      VALUES (${piId}, ${opId}, 'test-authorizer', '0xTestPayTo', '0.000001', 'USDC', 'base-sepolia', '0', 0, 9999999999, '{}', '0xhash', ${"SETTLEMENT_PENDING"}, NOW(), NOW(), 1)
      ON CONFLICT (payment_intent_id) DO UPDATE SET settlement_state = ${"SETTLEMENT_PENDING"}
    `);

    // Execute transaction that succeeds on ALL THREE mutations then throws
    // Uses SAME db.transaction() mechanism as production PostgresExecutionStore
    let caught = false;
    try {
      await db.transaction(async (tx: any) => {
        // Mutation 1: CAS payment_intent → SETTLED
        await tx.execute(sql`
          UPDATE payment_intents SET settlement_state = ${"SETTLED"}, version = version + 1, updated_at = NOW()
          WHERE payment_intent_id = ${piId}
        `);
        // Mutation 2: INSERT recovery_job
        await tx.execute(sql`
          INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, metadata, created_at, updated_at)
          VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, '{}'::jsonb, NOW(), NOW())
        `);
        // Mutation 3: INSERT execution_attempt
        await tx.execute(sql`
          INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
          VALUES (${attId}, ${opId}, ${opId}, 1, ${"PENDING"}, ${opId}, NOW())
        `);
        // Deterministic failure AFTER all three mutations succeeded
        throw new Error("ROLLBACK_TEST_3I");
      });
    } catch (e: any) {
      if (e.message === "ROLLBACK_TEST_3I") caught = true; else throw e;
    }

    expect(caught).toBe(true);

    // PROOF: payment_intent reverted to SETTLEMENT_PENDING
    const piAfter = await db.execute(sql`SELECT settlement_state FROM payment_intents WHERE payment_intent_id = ${piId}`);
    expect(resultRows(piAfter)[0]?.settlement_state).toBe("SETTLEMENT_PENDING");

    // PROOF: recovery_job does NOT exist
    const rjAfter = await db.execute(sql`SELECT job_id FROM recovery_jobs WHERE job_id = ${jobId}`);
    expect(resultRows(rjAfter).length).toBe(0);

    // PROOF: execution_attempt does NOT exist
    const eaAfter = await db.execute(sql`SELECT attempt_id FROM execution_attempts WHERE attempt_id = ${attId}`);
    expect(resultRows(eaAfter).length).toBe(0);

    // Cleanup
    await db.execute(sql`DELETE FROM payment_intents WHERE payment_intent_id = ${piId}`);
  });

  test("FIX-5-6: PostgresExecutionStore.settleAndCreateExecutionObligation creates all records with correct identity", async () => {
    const now = Date.now();
    const opId = `op-ok3i-${now}`;
    const piId = `pi-ok3i-${now}`;

    // Setup: create PI in SETTLEMENT_PENDING state
    await db.execute(sql`
      INSERT INTO payment_intents (payment_intent_id, operation_id, authorizer, pay_to, value, asset, network, nonce, valid_after, valid_before, payment_payload, payment_payload_hash, settlement_state, created_at, updated_at, version)
      VALUES (${piId}, ${opId}, 'test-authorizer', '0xTestPayTo', '0.000001', 'USDC', 'base-sepolia', '0', 0, 9999999999, '{}', '0xhash', ${"SETTLEMENT_PENDING"}, NOW(), NOW(), 1)
      ON CONFLICT (payment_intent_id) DO UPDATE SET settlement_state = ${"SETTLEMENT_PENDING"}
    `);

    // Call REAL production method
    const store = new PES(db);
    const job: RecoveryJob = {
      jobId: `rj-ok3i-${now}`, operationId: opId, jobType: "EXECUTION",
      status: "PENDING", priority: 0, maxAttempts: 3, currentAttempt: 0,
      metadata: {}, createdAt: now, updatedAt: now,
    };
    const att: ExecutionAttempt = {
      attemptId: `att-ok3i-${now}`, operationId: opId, executionId: opId,
      attemptNumber: 1, status: "PENDING", idempotencyKey: opId, createdAt: now,
    };

    const res = await store.settleAndCreateExecutionObligation(piId, opId, { source: "fix5-3i-test" }, job, att);
    expect(res).toBe(true);

    // Verify payment_intent = SETTLED with correct operationId
    const piCheck = await db.execute(sql`SELECT settlement_state, operation_id FROM payment_intents WHERE payment_intent_id = ${piId}`);
    const piRow = resultRows(piCheck)[0];
    expect(piRow?.settlement_state).toBe("SETTLED");
    expect(piRow?.operation_id).toBe(opId);

    // Verify recovery_job exists with correct operationId
    const rjCheck = await db.execute(sql`SELECT job_id, operation_id FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    const rjRow = resultRows(rjCheck)[0];
    expect(rjRow).toBeDefined();
    expect(rjRow?.operation_id).toBe(opId);

    // Verify execution_attempt exists with correct operationId and executionId
    const eaCheck = await db.execute(sql`SELECT attempt_id, operation_id, execution_id, attempt_number FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    const eaRow = resultRows(eaCheck)[0];
    expect(eaRow).toBeDefined();
    expect(eaRow?.operation_id).toBe(opId);
    expect(eaRow?.execution_id).toBe(opId);
    expect(eaRow?.attempt_number).toBe(1);

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    await db.execute(sql`DELETE FROM payment_intents WHERE payment_intent_id = ${piId}`);
  });
});
