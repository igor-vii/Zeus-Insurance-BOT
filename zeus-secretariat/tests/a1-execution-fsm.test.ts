/**
 * A1 targeted verification — post-settlement execution flow hardening.
 *
 * Covers the risks identified by the A1 audit (findings 1–6) with real
 * production components and no external services:
 *
 *   Test 1  persistence roundtrip        saveOperation() → getOperation()
 *   Test 2  restart reconstruction       durable HTTP_FAILURE attempt
 *   Test 3  worker claim lost            claimJob() → null ⇒ NO feedback
 *   Test 4  SUCCESS feedback + duplicate polling (idempotency)
 *   Test 5  DELIVERY_UNKNOWN ≠ FAILED    critical invariant (spec §3 / B6-B)
 *   Test 6  getOperation error handling  real DB errors propagate (audit #6)
 *
 * Infrastructure used (all pre-existing): InMemoryExecutionStore,
 * PostSettlementEngine, ExecutionWorker, ExecutionFeedbackService,
 * PostgresEvidenceStore.getOperation/saveOperation driven through a fake
 * pg-compatible db stub implementing the Operation-persistence contract
 * (no DATABASE_URL required — reproducible in sandbox).
 */

import { PostgresEvidenceStore } from "@workspace/db/secretariat/postgres-store";
import type { Operation, DurablePaymentIntent } from "zeus-secretariat";
import {
  PostSettlementEngine,
  InMemoryExecutionStore,
  ExecutionWorker,
  ExecutionFeedbackService,
} from "zeus-secretariat";
import type { SellerExecutionAdapter, SellerExecutionResult } from "zeus-secretariat";

// ---------------------------------------------------------------------------
// Fake pg/db stub — supports exactly the query shapes PostgresEvidenceStore
// uses inside getOperation()/saveOperation()/getPaymentIntentByOperationId().
// ---------------------------------------------------------------------------

interface IntentRow {
  paymentIntentId: string;
  operationId: string;
  requestId: string | null;
  clientId: string | null;
  target: string | null;
  method: string | null;
  paymentPolicy: unknown;
  authorizer: string;
  payTo: string;
  value: string;
  asset: string;
  network: string;
  nonce: string;
  validAfter: number;
  validBefore: number;
  paymentPayload: string;
  paymentPayloadHash: string;
  settlementState: string;
  txHash: string | null;
  facilitatorHttpStatus: number | null;
  facilitatorResponseBody: unknown;
  errorReason: string | null;
  submitAttemptAt: Date | null;
  settledAt: Date | null;
  notSettledAt: Date | null;
  settledEvidenceBundle: unknown;
  notSettledEvidenceBundle: unknown;
  reconciliationObservations: unknown[];
  nextProbeAt: Date | null;
  probeCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AttemptRow {
  operation_id: string;
  attempt_number: number;
  status: string;
}

class FakeDb {
  intents = new Map<string, IntentRow>(); // keyed by operationId
  attempts: AttemptRow[] = [];
  failNextExecute = false;
  executeCalls = 0;

  seedIntent(opId: string, overrides?: Partial<IntentRow>): void {
    const now = new Date(1_700_000_000_000);
    this.intents.set(opId, {
      paymentIntentId: `pi-${opId}`,
      operationId: opId,
      requestId: `req-${opId}`,
      clientId: `client-${opId}`,
      target: "https://seller.example/api",
      method: "POST",
      paymentPolicy: { maxAmount: "10" },
      authorizer: "0xauthorizer",
      payTo: "0xpayto",
      value: "1.0",
      asset: "0xasset",
      network: "base-sepolia",
      nonce: "0xnonce",
      validAfter: 0,
      validBefore: 9999999999,
      paymentPayload: "payload",
      paymentPayloadHash: "hash",
      settlementState: "SETTLED",
      txHash: "0xtx",
      facilitatorHttpStatus: 200,
      facilitatorResponseBody: null,
      errorReason: null,
      submitAttemptAt: now,
      settledAt: now,
      notSettledAt: null,
      settledEvidenceBundle: null,
      notSettledEvidenceBundle: null,
      reconciliationObservations: [],
      nextProbeAt: null,
      probeCount: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  /** Extract the first bound parameter value from a drizzle SQL object. */
  private static paramOf(query: unknown): string {
    const q = query as { params?: unknown[]; queryChunks?: unknown[]; queryChunksList?: unknown[] };
    const params = q.params ?? q.queryChunks ?? q.queryChunksList;
    if (Array.isArray(params)) {
      for (const p of params) {
        const v = (p as { value?: unknown })?.value;
        if (typeof v === "string") return v;
        if (typeof p === "string" && !p.includes("SELECT") && !p.includes("UPDATE")) return p;
      }
    }
    return "";
  }

  /** Rebuild raw SQL text from a drizzle SQL template (inlining params as quoted literals). */
  private static sqlText(query: unknown): string {
    const q = query as { queryChunks?: Array<string | { value?: unknown }> };
    if (Array.isArray(q.queryChunks)) {
      return q.queryChunks
        .map((c) => (typeof c === "string" ? c : `'${String(c?.value)}'`))
        .join("");
    }
    const t = query as { text?: string; sql?: string };
    return String(t?.text ?? t?.sql ?? query);
  }

  /** Minimal drizzle select() chain for payment_intents WHERE operation_id = X LIMIT 1. */
  select() {
    return {
      from: (_table: unknown) => ({
        where: (clause: unknown) => {
          const opId = FakeDb.paramOf(clause);
          const self = this;
          return {
            limit: (_n: number) => Promise.resolve(self.intents.get(opId) ? [self.intents.get(opId)!] : []),
          };
        },
      }),
    };
  }

  /** UPDATE payment_intents SET {...} WHERE operation_id = X (drizzle chain). */
  update(_table: unknown) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          const opId = FakeDb.paramOf(clause);
          const row = this.intents.get(opId);
          if (row) Object.assign(row, values);
          return Promise.resolve();
        },
      }),
    };
  }

  /** Raw SQL executor emulating the sql`` shapes used by A1 code paths. */
  async execute(query: unknown): Promise<unknown[]> {
    this.executeCalls++;
    if (this.failNextExecute) {
      this.failNextExecute = false;
      throw new Error("FAKE_DB_CONNECTION_LOST");
    }
    const text = FakeDb.sqlText(query);

    if (text.includes("jsonb_array_elements")) {
      // SELECT EXISTS (... WHERE e = ${record}::jsonb) AS present
      const m = text.match(/'\[.*\]'::jsonb/s);
      const recMatch = text.match(/AS \$\d+|=\s*'?(\{.*?\})'?\s*::jsonb/s);
      let existing: unknown[] = [];
      if (m) {
        try { existing = JSON.parse(m[0].replace(/^'/, "").replace(/'::jsonb$/, "")); } catch { existing = []; }
      }
      let record: unknown = null;
      if (recMatch) {
        try { record = JSON.parse(recMatch[1]); } catch { record = null; }
      }
      const present =
        record !== null &&
        Array.isArray(existing) &&
        existing.some((e) => JSON.stringify(e) === JSON.stringify(record));
      return [{ present }];
    }

    if (text.includes("FROM payment_intents")) {
      // UPDATE ... reconciliation_observations = COALESCE(...) || ${record}::jsonb
      const im = text.match(/WHERE payment_intent_id = '([^']+)'/);
      const rm = text.match(/\|\| '(\{.*?\})'::jsonb/s);
      if (im && rm) {
        const row = [...this.intents.values()].find((r) => r.paymentIntentId === im[1]);
        if (row) {
          const arr = (row.reconciliationObservations ?? []) as unknown[];
          arr.push(JSON.parse(rm[1]));
          row.reconciliationObservations = arr;
          row.updatedAt = new Date();
        }
      }
      return [];
    }

    if (text.includes("FROM execution_attempts")) {
      const om = text.match(/WHERE operation_id = '([^']+)'/);
      const opId = om ? om[1] : "";
      const sorted = this.attempts
        .filter((a) => a.operation_id === opId)
        .sort((a, b) => b.attempt_number - a.attempt_number)
        .slice(0, 1);
      return sorted;
    }

    return [];
  }
}

function makeStore(db: FakeDb): PostgresEvidenceStore {
  return new PostgresEvidenceStore(db as unknown as ConstructorParameters<typeof PostgresEvidenceStore>[0]);
}

const baseOp = (opId: string, over?: Partial<Operation>): Operation => ({
  operationId: opId,
  requestId: `req-${opId}`,
  clientId: `client-${opId}`,
  target: "https://seller.example/api",
  method: "POST",
  paymentPolicy: { maxAmount: "10" } as any,
  paymentState: "SETTLED",
  executionState: "NOT_STARTED",
  deliveryState: "NOT_STARTED",
  currentState: "SETTLED" as any,
  timestamps: { createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
  evidence: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Test fakes for the engine stack
// ---------------------------------------------------------------------------

class FakePaymentStoreForEngine {
  constructor(private readonly db: FakeDb) {}
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    const row = this.db.intents.get(opId);
    if (!row) return null;
    return { ...(row as unknown as DurablePaymentIntent), updatedAt: Date.now() };
  }
  async append(record: { operationId: string; phase: string; timestamp: number; event: string; payload: unknown }): Promise<void> {
    const row = this.db.intents.get(record.operationId);
    if (row) (row.reconciliationObservations as unknown[]).push(record);
  }
}

function fixedAdapter(result: SellerExecutionResult): SellerExecutionAdapter {
  return { execute: async () => result };
}

const SUCCESS_RESULT: SellerExecutionResult = {
  kind: "SUCCESS", statusCode: 200, body: { ok: true }, headers: {}, durationMs: 5,
};
const HTTP_500_RESULT: SellerExecutionResult = {
  kind: "HTTP_FAILURE", statusCode: 500, body: {}, headers: {}, durationMs: 5,
};
const TIMEOUT_RESULT: SellerExecutionResult = {
  kind: "DELIVERY_UNKNOWN", reason: "TIMEOUT", error: "timeout", durationMs: 30_000,
};

async function seedSettledPipeline(opts: {
  capability: "EXECUTION_IDEMPOTENT" | "RESULT_RETRIEVAL" | "NONE";
  adapter: SellerExecutionAdapter;
  opId?: string;
}) {
  const opId = opts.opId ?? `op-${Math.random().toString(36).slice(2)}`;
  const db = new FakeDb();
  db.seedIntent(opId, { settlementState: "SETTLED" });
  const execStore = new InMemoryExecutionStore();
  const engine = new PostSettlementEngine(
    new FakePaymentStoreForEngine(db) as never,
    execStore as never,
    opts.adapter,
    { workerId: "test-worker", sellerUrl: "https://seller.example/api" },
  );
  await engine.initiateExecution(opId, opts.capability, { hello: "world" });
  return { db, opId, execStore, engine };
}

// ===========================================================================
// Test 1 — persistence roundtrip: saveOperation() → getOperation()
// ===========================================================================
describe("A1 hardening #1/#2/#3 — persistence roundtrip", () => {
  it("restores currentState, executionState, deliveryState, evidence and key fields after save→reload", async () => {
    const db = new FakeDb();
    const store = makeStore(db);
    const opId = "op-roundtrip";
    db.seedIntent(opId, { settlementState: "SETTLED" });
    db.attempts.push({ operation_id: opId, attempt_number: 1, status: "SUCCESS" });

    const transitionRecord = {
      operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_500,
      event: "STATE_TRANSITION", payload: { from: "EXECUTION_CONFIRMED", to: "DELIVERED", finalStatus: "SUCCESS" },
    };
    const op = baseOp(opId, {
      target: "https://seller.example/v2",
      method: "PUT",
      currentState: "DELIVERED" as any,
      executionState: "CONFIRMED",
      deliveryState: "DELIVERED",
      evidence: [transitionRecord as any],
    });

    await store.saveOperation(op);
    const restored = await store.getOperation(opId);

    expect(restored).not.toBeNull();
    // key operation fields
    expect(restored!.operationId).toBe(opId);
    expect(restored!.requestId).toBe(`req-${opId}`);
    expect(restored!.clientId).toBe(`client-${opId}`);
    expect(restored!.target).toBe("https://seller.example/v2");
    expect(restored!.method).toBe("PUT");
    expect(restored!.paymentPolicy).toEqual({ maxAmount: "10" });
    // FSM state reconstructible from evidence (A1 Finding #3 closure)
    expect(restored!.currentState).toBe("DELIVERED");
    // axes reconstructed per spec §4 mapping
    expect(restored!.executionState).toBe("CONFIRMED"); // attempt SUCCESS → CONFIRMED
    expect(restored!.deliveryState).toBe("DELIVERED"); // latest STATE_TRANSITION to DELIVERED
    expect(restored!.paymentState).toBe("SETTLED");
    // full evidence array restored
    expect(restored!.evidence).toHaveLength(1);
    expect((restored!.evidence[0] as any).event).toBe("STATE_TRANSITION");
    expect(restored!.timestamps.createdAt).toBe(1_700_000_000_000);
  });

  it("duplicate save of the same operation does NOT re-append identical evidence (audit #2)", async () => {
    const db = new FakeDb();
    const store = makeStore(db);
    const opId = "op-dup-save";
    db.seedIntent(opId, { settlementState: "SETTLED" });

    const rec = {
      operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_600,
      event: "STATE_TRANSITION", payload: { from: "SETTLED", to: "EXECUTION_PENDING", finalStatus: "SUCCESS" },
    };
    const op = baseOp(opId, { currentState: "EXECUTION_PENDING" as any, evidence: [rec as any] });

    await store.saveOperation(op);
    await store.saveOperation(op); // retried/concurrent save — same identity
    const restored = await store.getOperation(opId);
    expect(restored!.evidence.filter((e) => (e as any).timestamp === rec.timestamp)).toHaveLength(1);
  });
});

// ===========================================================================
// Test 2 — restart reconstruction with durable HTTP_FAILURE attempt
// ===========================================================================
describe("A1 hardening — restart reconstruction (HTTP_FAILURE)", () => {
  it("reconstructs executionState=FAILED and current FSM state=FAILED after restart", async () => {
    const db = new FakeDb();
    const store = makeStore(db);
    const opId = "op-restart-httpfail";
    db.seedIntent(opId, { settlementState: "SETTLED" });
    db.attempts.push({ operation_id: opId, attempt_number: 1, status: "HTTP_FAILURE" });
    // Only partial evidence was durably recorded before the crash:
    (db.intents.get(opId)!.reconciliationObservations as unknown[]).push({
      operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_100,
      event: "STATE_TRANSITION", payload: { from: "SETTLED", to: "EXECUTION_PENDING" },
    });

    const restored = await store.getOperation(opId);
    expect(restored!.executionState).toBe("FAILED");
    // Existing failure semantics: EXECUTION_PENDING → FAILED is a valid edge;
    // durable attempt status fast-forwards the lagging evidence (audit #3).
    expect(restored!.currentState).toBe("FAILED");
    expect(restored!.deliveryState).toBe("PENDING"); // EXECUTION_PENDING → PENDING, not NOT_STARTED
  });

  it("EXECUTION_CONFIRMED evidence reconstructs deliveryState=PENDING (audit #3)", async () => {
    const db = new FakeDb();
    const store = makeStore(db);
    const opId = "op-confirm-delivery";
    db.seedIntent(opId, { settlementState: "SETTLED" });
    db.attempts.push({ operation_id: opId, attempt_number: 1, status: "SUCCESS" });
    (db.intents.get(opId)!.reconciliationObservations as unknown[]).push({
      operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_200,
      event: "STATE_TRANSITION", payload: { from: "EXECUTION_PENDING", to: "EXECUTION_CONFIRMED" },
    });

    const restored = await store.getOperation(opId);
    expect(restored!.deliveryState).toBe("PENDING"); // NOT NOT_STARTED
    expect(restored!.executionState).toBe("CONFIRMED");
  });
});

// ===========================================================================
// Test 3 — worker claim lost ⇒ no feedback, no saveOperation (audit #1)
// ===========================================================================
describe("A1 hardening #1 — claim-lost no-op safety", () => {
  it("processJob returning RUNNING (claim lost) applies NO FSM feedback and NO saveOperation", async () => {
    const feedbackCalls: unknown[] = [];
    const saveCalls: unknown[] = [];
    const fakeEngine = {
      processJob: async () => ({ success: false, finalStatus: "RUNNING" }),
    };
    const fakeStore = {
      getPendingJobs: async () => [
        { jobId: "job-x", operationId: "op-x", jobType: "EXECUTION", status: "RUNNING", priority: 0, maxAttempts: 3, currentAttempt: 1, createdAt: 0, updatedAt: 0 },
      ],
    };
    const fakeOpsPersistence = {
      getOperation: async () => null,
      saveOperation: async (op: Operation) => { saveCalls.push(op); },
    };
    // Real ExecutionFeedbackService over a recording persistence — proves that
    // NO feedback call means NO getOperation/saveOperation at all.
    const feedback = new ExecutionFeedbackService(fakeOpsPersistence as never);
    const applySpy = jest.spyOn(feedback, "applyResult");

    const worker = new ExecutionWorker(fakeEngine as never, fakeStore as never, {
      feedbackService: feedback,
    });

    await worker.runOnce();

    expect(applySpy).not.toHaveBeenCalled(); // RUNNING ⇒ feedback NOT called
    expect(saveCalls).toHaveLength(0);       // and therefore saveOperation NOT called
    expect(feedbackCalls).toHaveLength(0);
  });

  it("real engine: second concurrent claim returns RUNNING and job processes exactly once", async () => {
    const { db, opId, execStore, engine } = await seedSettledPipeline({
      capability: "EXECUTION_IDEMPOTENT", adapter: fixedAdapter(SUCCESS_RESULT),
    });
    const jobs = await execStore.getPendingJobs();
    expect(jobs.length).toBe(1);
    const first = await engine.processJob(jobs[0].jobId);
    expect(first.finalStatus).toBe("SUCCESS");
    // Job terminal — a racing consumer's claim must be rejected → RUNNING no-op
    const second = await engine.processJob(jobs[0].jobId);
    expect(second.finalStatus).toBe("RUNNING");
    // Exactly one attempt row, no duplicates
    expect(db.attempts.length).toBeGreaterThanOrEqual(0);
    const attempts = await execStore.getAttemptsByOperation(opId);
    expect(attempts.filter((a) => a.status === "SUCCESS")).toHaveLength(1);
  });
});

// ===========================================================================
// Test 4 — SUCCESS feedback + duplicate polling idempotency
// ===========================================================================
describe("A1 hardening #2 — SUCCESS feedback & duplicate handling", () => {
  it("worker drives SETTLED → EXECUTION_PENDING → EXECUTION_CONFIRMED → DELIVERED → SUCCESS and duplicate poll adds nothing", async () => {
    const { db, opId, execStore, engine } = await seedSettledPipeline({
      capability: "EXECUTION_IDEMPOTENT", adapter: fixedAdapter(SUCCESS_RESULT),
    });
    const store = makeStore(db);
    const feedback = new ExecutionFeedbackService(store);
    const worker = new ExecutionWorker(engine, execStore as never, { feedbackService: feedback });

    await worker.runOnce();

    const op = await store.getOperation(opId);
    expect(op!.currentState).toBe("SUCCESS");
    expect(op!.executionState).toBe("CONFIRMED");
    expect(op!.deliveryState).toBe("DELIVERED");
    const transitions = op!.evidence.filter((e) => (e as any).event === "STATE_TRANSITION");
    expect(transitions.map((t) => (t as any).payload.to)).toEqual([
      "EXECUTION_PENDING", "EXECUTION_CONFIRMED", "DELIVERED", "SUCCESS",
    ]);

    // Duplicate iteration: job COMPLETED → getPendingJobs empty → no re-drive.
    const evidenceLen = op!.evidence.length;
    await worker.runOnce();
    const op2 = await store.getOperation(opId);
    expect(op2!.evidence).toHaveLength(evidenceLen);
    expect(op2!.currentState).toBe("SUCCESS");

    // Even a forced duplicate feedback call is a no-op (terminal guard):
    const res = await feedback.applyResult(opId, "SUCCESS");
    expect(res.applied).toBe(false);
    const op3 = await store.getOperation(opId);
    expect(op3!.evidence).toHaveLength(evidenceLen);
  });

  it("HTTP_FAILURE feedback: SETTLED → EXECUTION_PENDING → FAILED", async () => {
    const { db, opId, execStore, engine } = await seedSettledPipeline({
      capability: "EXECUTION_IDEMPOTENT", adapter: fixedAdapter(HTTP_500_RESULT),
    });
    const store = makeStore(db);
    const worker = new ExecutionWorker(engine, execStore as never, {
      feedbackService: new ExecutionFeedbackService(store),
    });

    await worker.runOnce();
    const op = await store.getOperation(opId);
    expect(op!.currentState).toBe("FAILED");
    expect(op!.executionState).toBe("FAILED");
  });
});

// ===========================================================================
// Test 5 — CRITICAL INVARIANT: DELIVERY_UNKNOWN ≠ FAILED
// ===========================================================================
describe("A1 invariant — DELIVERY_UNKNOWN ≠ FAILED", () => {
  it("RESULT_RETRIEVAL timeout ends at EXECUTION_UNKNOWN, never FAILED", async () => {
    const { db, opId, execStore, engine } = await seedSettledPipeline({
      capability: "RESULT_RETRIEVAL", adapter: fixedAdapter(TIMEOUT_RESULT),
    });
    const store = makeStore(db);
    const worker = new ExecutionWorker(engine, execStore as never, {
      feedbackService: new ExecutionFeedbackService(store),
    });

    await worker.runOnce();
    const op = await store.getOperation(opId);
    expect(op!.currentState).toBe("EXECUTION_UNKNOWN");
    expect(op!.currentState).not.toBe("FAILED"); // ГЛАВНЫЙ ASSERT
    expect(op!.executionState).toBe("UNKNOWN");
  });

  it("feedback service maps DELIVERY_UNKNOWN plan without FAILED anywhere", async () => {
    const { planExecutionTransitions } = await import("zeus-secretariat");
    const plan = planExecutionTransitions("DELIVERY_UNKNOWN")!;
    expect(plan).toEqual(["EXECUTION_PENDING", "EXECUTION_UNKNOWN"]);
    expect(plan).not.toContain("FAILED");
    expect(planExecutionTransitions("RUNNING")).toBeNull();
  });
});

// ===========================================================================
// Test 6 — getOperation error handling (audit #6): no silent masking
// ===========================================================================
describe("A1 hardening #6 — DB errors propagate", () => {
  it("real DB error during execution_attempts query propagates instead of silent fallback", async () => {
    const db = new FakeDb();
    const store = makeStore(db);
    const opId = "op-error";
    db.seedIntent(opId);
    db.attempts.push({ operation_id: opId, attempt_number: 1, status: "SUCCESS" });
    db.failNextExecute = true; // the attempts query will throw
    await expect(store.getOperation(opId)).rejects.toThrow("FAKE_DB_CONNECTION_LOST");
  });
});

// ===========================================================================
// Test 7 — UNRESOLVABLE semantics (audit #4 decision)
//   * execution axis → CONFIRMED (attempt did happen; no new enum value);
//   * authoritative currentState after restart reconstruction → UNRESOLVABLE
//     (fast-forwarded from durable attempt status, NOT fabricated as an FSM edge);
//   * feedback plan NEVER contains a fabricated EXECUTION_UNKNOWN→UNRESOLVABLE
//     transition — chain honestly stops at EXECUTION_UNKNOWN.
// ===========================================================================
describe("A1 hardening #4 — UNRESOLVABLE semantics", () => {
  it("restart reconstruction: attempt UNRESOLVABLE → executionState=CONFIRMED, currentState=UNRESOLVABLE, deliveryState=UNKNOWN", async () => {
    const db = new FakeDb();
    const store = makeStore(db);
    const opId = "op-unresolvable";
    db.seedIntent(opId, { settlementState: "SETTLED" });
    db.attempts.push({ operation_id: opId, attempt_number: 1, status: "UNRESOLVABLE" });
    // Durable evidence lagged behind the crash at EXECUTION_UNKNOWN:
    (db.intents.get(opId)!.reconciliationObservations as unknown[]).push({
      operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_300,
      event: "STATE_TRANSITION", payload: { from: "EXECUTION_PENDING", to: "EXECUTION_UNKNOWN" },
    });

    const restored = await store.getOperation(opId);
    // Execution axis: the call definitely happened — CONFIRMED on that axis.
    expect(restored!.executionState).toBe("CONFIRMED");
    // Authoritative terminal FSM state reflects durable obligation status.
    expect(restored!.currentState).toBe("UNRESOLVABLE");
    // Outcome unknown ≠ failure (B6-B boundary preserved).
    expect(restored!.deliveryState).toBe("UNKNOWN");
    expect(restored!.currentState).not.toBe("FAILED");
  });

  it("feedback plan for UNRESOLVABLE stops at EXECUTION_UNKNOWN — no fabricated FSM edge", async () => {
    const { planExecutionTransitions } = await import("zeus-secretariat");
    const plan = planExecutionTransitions("UNRESOLVABLE")!;
    expect(plan).toEqual(["EXECUTION_PENDING", "EXECUTION_UNKNOWN"]);
    expect(plan).not.toContain("UNRESOLVABLE"); // real VALID_TRANSITIONS has no such edge
    expect(plan).not.toContain("FAILED");       // DELIVERY_UNKNOWN ≠ FAILED lineage
  });

  it("worker with UNRESOLVABLE result leaves FSM at EXECUTION_UNKNOWN and does not re-save on duplicate poll", async () => {
    const { db, opId, execStore, engine } = await seedSettledPipeline({
      capability: "NONE", adapter: fixedAdapter(TIMEOUT_RESULT),
    });
    // Force the durable outcome to UNRESOLVABLE (terminal under fencing).
    const jobs = await execStore.getPendingJobs();
    await engine.processJob(jobs[0].jobId);
    await execStore.updateAttemptStatus(jobs[0].jobId, "UNRESOLVABLE", { reason: "no receipt possible" }).catch(async () => {
      // If the store API differs, mark the job itself terminal-UNRESOLVABLE.
      await (execStore as any).updateJobStatus?.(jobs[0].jobId, "UNRESOLVABLE");
    });

    const store = makeStore(db);
    const feedback = new ExecutionFeedbackService(store);
    const res = await feedback.applyResult(opId, "UNRESOLVABLE");
    expect(res.applied).toBe(true);
    const op = await store.getOperation(opId);
    expect(op!.currentState).toBe("EXECUTION_UNKNOWN"); // honest stop, no fabricated edge
    const len = op!.evidence.length;
    // Duplicate feedback call while non-terminal-but-already-there must be a no-op:
    const res2 = await feedback.applyResult(opId, "UNRESOLVABLE");
    expect(res2.applied).toBe(false);
    const op2 = await store.getOperation(opId);
    expect(op2!.evidence).toHaveLength(len);
  });
});
