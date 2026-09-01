/**
 * BLOCK 8 R2.1-FIX-5 — Atomic Settlement Handoff Tests
 */

import { Secretariat } from "../src/core/state-machine";
import type {
  AtomicSettlementHandoff, PaymentSigner, PaymentRequirement,
  SigningContext, PaymentAuthorization, DurableEvidenceStore,
} from "../src/core/types";
import type { RecoveryJob, ExecutionAttempt } from "../src/core/post-settlement-engine";
import type { ReconciliationEngine, ReconciliationOutcome } from "../src/core/reconciliation-engine";

const mockSigner: PaymentSigner = {
  async signPayment(): Promise<PaymentAuthorization> {
    return { signature: "0xmock", scheme: "EIP-3009", timestamp: Date.now(), context: {} };
  },
};

// Minimal fake store — cast required for 20+ method interface
function createFakeStore(overrides?: Record<string, unknown>): DurableEvidenceStore {
  const noop = async () => null;
  const base: Record<string, unknown> = {};
  for (const m of ["createPaymentIntent","updatePaymentIntentStatus","reserveNonce","append","saveOperation","appendReconciliationObservation","saveSettledEvidenceBundle","saveNotSettledEvidenceBundle","updatePaymentIntentProbeCount"]) base[m] = async () => {};
  for (const m of ["getPaymentIntentByOperationId","getNonce","getOperation","getOperationByClientAndRequestId"]) base[m] = noop;
  for (const m of ["getEvidence","getOperationsByStatus","getNonTerminalIntents","getReconciliationObservations","getDueReconciliationJobs"]) base[m] = async () => [];
  for (const m of ["claimReconciliationJob","completeReconciliationJob","rescheduleReconciliationJob","failReconciliationJob"]) base[m] = async () => false;
  base["createReconciliationJob"] = async () => "";
  return { ...base, ...overrides } as unknown as DurableEvidenceStore;
}

// ===========================================================================
// FIX-5-3: Real Observable Atomic Handoff Invocation
// ===========================================================================

describe("R2.1-FIX-5: Observable Atomic Handoff", () => {
  test("FIX-5-3: StateMachine invokes atomicSettlementHandoff with correct arguments", async () => {
    const invocations: Array<{
      piId: string; opId: string; evidence: unknown;
      job: RecoveryJob; attempt: ExecutionAttempt;
    }> = [];

    const handoff: AtomicSettlementHandoff = {
      async settleAndCreateExecutionObligation(piId, opId, evidence, job, attempt) {
        invocations.push({ piId, opId, evidence, job, attempt });
        return true;
      },
    };

    const testOpId = "op-fix5-obs";
    const testPiId = "pi-fix5-obs";

    // Mock reconciliation engine that returns SETTLED
    const mockReconEngine = {
      reconcile: async (): Promise<ReconciliationOutcome> => ({
        status: "SETTLED",
        evidence: { source: "mock-reconciliation", settledAt: Date.now() },
      }),
      recoverAfterCrash: async () => new Map(),
      store: null, rpcChecker: null, scheduleConfig: null, finalityPolicy: null,
      persistObservation: async () => {},
      scheduleNextProbe: async () => {},
      canCreateNewPayment: async () => true,
    } as unknown as ReconciliationEngine;

    const store = createFakeStore({
      getPaymentIntentByOperationId: async (id: string) =>
        id === testOpId
          ? ({ paymentIntentId: testPiId, operationId: testOpId, settlementState: "SETTLEMENT_PENDING" } as never)
          : null,
    });

    const sec = new Secretariat({
      evidenceStore: store,
      signer: mockSigner,
      adapters: new Map(),
      reconciliationEngine: mockReconEngine,
      atomicSettlementHandoff: handoff,
    });

    try {
      await sec.execute({
        target: "https://example.com/test",
        method: "GET",
        requestId: "req-fix5-obs",
        policy: { maxPrice: "0", allowedNetworks: ["base-sepolia"], allowedAssets: ["0x0"] },
      });
    } catch {
      // May fail at submitPayment (no real facilitator) — that is OK
      // as long as observeSettlement was reached via reconciliationEngine
    }

    // UNCONDITIONAL assertion — test MUST fail if handoff was not called
    expect(invocations).toHaveLength(1);
    expect(invocations[0].piId).toBe(testPiId);
    expect(invocations[0].opId).toBe(testOpId);
    expect(invocations[0].evidence).toBeDefined();
    expect(invocations[0].job).toBeDefined();
    expect(invocations[0].job.jobType).toBe("EXECUTION");
    expect(invocations[0].attempt).toBeDefined();
    expect(invocations[0].attempt.attemptNumber).toBe(1);
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
      path.join(__dirname, "../src/store/postgres-execution-store.ts"), "utf-8"
    );
    const txStart = src.indexOf("this.db.transaction(async (tx)");
    expect(txStart).toBeGreaterThan(-1);
    const txBody = src.substring(txStart);
    expect(txBody).toMatch(/tx\.execute\(sql`[\s\S]*?UPDATE payment_intents/);
    expect(txBody).toMatch(/tx\.insert\(recoveryJobsTable\)/);
    expect(txBody).toMatch(/tx\.insert\(executionAttemptsTable\)/);
    // Extract callback body and verify no this.db mutations
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

  test("FIX-5-5B: rollback reverts all mutations after partial success", async () => {
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

  test("FIX-5-6: production handoff creates all records atomically", async () => {
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
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    await db.execute(sql`DELETE FROM payment_intents WHERE payment_intent_id = ${piId}`);
  });
});
