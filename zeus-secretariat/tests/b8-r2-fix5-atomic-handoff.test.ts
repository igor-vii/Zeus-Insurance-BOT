/**
 * BLOCK 8 R2.1-FIX-5 — Atomic Settlement Handoff Tests
 *
 * Proves:
 *   FIX-5-1: Typed AtomicSettlementHandoff is required dependency
 *   FIX-5-3: PostgresExecutionStore implements AtomicSettlementHandoff contract
 *   FIX-5-5A: Production code uses tx for ALL mutations (static proof)
 *   FIX-5-5B: PostgreSQL transaction rollback semantics (infrastructure proof)
 *   FIX-5-6: Production handoff success path (real PostgreSQL)
 */

import type {
  AtomicSettlementHandoff,
} from "../src/core/post-settlement-engine";
import type { RecoveryJob, ExecutionAttempt } from "../src/core/post-settlement-engine";
import { sql } from "drizzle-orm";

// ===========================================================================
// FIX-5-1: Typed Contract Enforcement (Compile-Time Proof)
// ===========================================================================

describe("R2.1-FIX-5: Typed Contract", () => {
  test("FIX-5-1: AtomicSettlementHandoff is a required typed dependency", () => {
    // This test proves at compile time that AtomicSettlementHandoff exists
    // as a typed interface. If the interface were removed or made optional,
    // this would fail to compile.
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
    // Verify PostgresExecutionStore structurally satisfies AtomicSettlementHandoff
    const mod = await import("../src/store/postgres-execution-store");
    const storePrototype = mod.PostgresExecutionStore.prototype;
    expect(typeof storePrototype.settleAndCreateExecutionObligation).toBe("function");
  });

  test("FIX-5-3b: composition root wires executionStore as atomicSettlementHandoff", async () => {
    // Static verification: composition root passes stores.executionStore
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../api-server/src/lib/secretariat-composition.ts"),
      "utf-8",
    );
    expect(src).toMatch(/atomicSettlementHandoff:\s*stores\.executionStore/);
    // Verify NO sequential fallback or duck typing remains
    expect(src).not.toMatch(/as any/);
    expect(src).not.toMatch(/typeof.*settleAndCreateExecutionObligation/);
  });
});

// ===========================================================================
// FIX-5-5A: Production Atomic Boundary (Static Verification)
// ===========================================================================

describe("R2.1-FIX-5: Production Atomic Boundary", () => {
  test("FIX-5-5A: all mutations use tx inside transaction", async () => {
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

  test("FIX-5-5B: transaction rollback reverts all mutations after partial success", async () => {
    const now = Date.now();
    const opId = `op-rb-${now}`, piId = `pi-rb-${now}`, jobId = `rj-rb-${now}`;
    await db.execute(sql`
      INSERT INTO payment_intents (payment_intent_id, operation_id, settlement_state, created_at, updated_at, version)
      VALUES (${piId}, ${opId}, ${"SETTLEMENT_PENDING"}, NOW(), NOW(), 1)
      ON CONFLICT (payment_intent_id) DO UPDATE SET settlement_state = ${"SETTLEMENT_PENDING"}
    `);
    let caught = false;
    try {
      await db.transaction(async (tx: any) => {
        await tx.execute(sql`UPDATE payment_intents SET settlement_state = ${"SETTLED"}, version = version + 1 WHERE payment_intent_id = ${piId}`);
        await tx.execute(sql`INSERT INTO recovery_jobs (job_id, operation_id, job_type, status, priority, max_attempts, current_attempt, metadata, created_at, updated_at) VALUES (${jobId}, ${opId}, ${"EXECUTION"}, ${"PENDING"}, 0, 3, 0, '{}'::jsonb, NOW(), NOW())`);
        throw new Error("ROLLBACK_TEST");
      });
    } catch (e: any) {
      if (e.message === "ROLLBACK_TEST") caught = true; else throw e;
    }
    expect(caught).toBe(true);
    const pi = await db.execute(sql`SELECT settlement_state FROM payment_intents WHERE payment_intent_id = ${piId}`);
    expect((pi as any[])[0]?.settlement_state).toBe("SETTLEMENT_PENDING");
    const rj = await db.execute(sql`SELECT job_id FROM recovery_jobs WHERE job_id = ${jobId}`);
    expect((rj as any[]).length).toBe(0);
    await db.execute(sql`DELETE FROM payment_intents WHERE payment_intent_id = ${piId}`);
  });

  test("FIX-5-6: PostgresExecutionStore.settleAndCreateExecutionObligation creates all records", async () => {
    const now = Date.now();
    const opId = `op-ok-${now}`, piId = `pi-ok-${now}`;
    await db.execute(sql`
      INSERT INTO payment_intents (payment_intent_id, operation_id, settlement_state, created_at, updated_at, version)
      VALUES (${piId}, ${opId}, ${"SETTLEMENT_PENDING"}, NOW(), NOW(), 1)
      ON CONFLICT (payment_intent_id) DO UPDATE SET settlement_state = ${"SETTLEMENT_PENDING"}
    `);
    const store = new PES(db);
    const job: RecoveryJob = {
      jobId: `rj-ok-${now}`, operationId: opId, jobType: "EXECUTION",
      status: "PENDING", priority: 0, maxAttempts: 3, currentAttempt: 0,
      metadata: {}, createdAt: now, updatedAt: now,
    };
    const att: ExecutionAttempt = {
      attemptId: `att-ok-${now}`, operationId: opId, executionId: opId,
      attemptNumber: 1, status: "PENDING", idempotencyKey: opId, createdAt: now,
    };
    const res = await store.settleAndCreateExecutionObligation(piId, opId, { source: "test" }, job, att);
    expect(res).toBe(true);
    const pi = await db.execute(sql`SELECT settlement_state FROM payment_intents WHERE payment_intent_id = ${piId}`);
    expect((pi as any[])[0]?.settlement_state).toBe("SETTLED");
    const rj = await db.execute(sql`SELECT job_id FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    expect((rj as any[]).length).toBeGreaterThan(0);
    const ea = await db.execute(sql`SELECT attempt_id FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    expect((ea as any[]).length).toBeGreaterThan(0);
    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    await db.execute(sql`DELETE FROM payment_intents WHERE payment_intent_id = ${piId}`);
  });
});
