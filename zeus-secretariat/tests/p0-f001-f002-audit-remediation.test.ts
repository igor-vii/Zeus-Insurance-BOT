/**
 * P0 REMEDIATION — external audit Blockers F-001 + F-002
 *
 * F-001: a SETTLED intent could remain FOREVER without an execution job.
 *   Root cause: unfenced saveAttempt() → saveJob() pair + a scanner that
 *   excluded intents which already had an attempt. Fix: atomic
 *   saveAttemptWithJob() + scanner self-heal (link missing job to the
 *   surviving attempt).
 * F-002: a terminal NOT_SETTLED was declared without an actual
 *   AuthorizationUsed scan — "scanComplete: true" was self-asserted, block
 *   data was zeroed. Fix: real multi-provider scan BEFORE the CAS, honest
 *   evidence, fail closed on incomplete/disagreeing scans, real §11-D
 *   freshness gate.
 *
 * Proves:
 *   F001-1: initiateExecution persists BOTH rows via the atomic primitive
 *   F001-2: injected failure inside the atomic write leaves NO partial state
 *   F001-3: legacy orphan (attempt without job) is repaired, idempotently
 *   F001-4: terminal-attempt orphan gets a COMPLETED marker (never re-executed)
 *   F001-5: LIVE PG — fault-injection between the two inserts → full rollback
 *   F001-6: LIVE PG — scanner re-selects SETTLED+orphan intent and heals it
 *   F002-1: NEGATIVE (audit-mandated): NOT_SETTLED impossible with ZERO scan calls
 *   F002-2: NOT_SETTLED evidence carries real block data + scan summary (no zeros)
 *   F002-3: INCOMPLETE scan → RECONCILING, no terminal CAS, new payments stay blocked
 *   F002-4: DISAGREEING scan → RECONCILING
 *   F002-5: EVENT_FOUND → §17 txHash recovery (NOT_SETTLED forbidden on found event)
 *   F002-6: §11-D real freshness gate: stale / missing blockData / unknown provider
 */

import { PostSettlementEngine, InMemoryExecutionStore } from "../src/core/post-settlement-engine";
import type { ExecutionAttempt, RecoveryJob } from "../src/core/post-settlement-engine";
import { ReconciliationEngine } from "../src/core/reconciliation-engine";
import { MockMultiRpcChecker, MultiRpcChecker } from "../src/core/multi-rpc-checker";
import type { DurablePaymentIntent, NotSettledEvidenceBundle } from "../src/core/types";
import { sql } from "drizzle-orm";

// ===========================================================================
// F-001 engine-level tests (in-memory)
// ===========================================================================

/**
 * Payment-store stub that mirrors the production scanner semantics:
 * returns SETTLED intents that have NO durable EXECUTION job
 * (PostgresStore.getSettledIntentsWithoutObligation does this in SQL).
 */
class EnginePaymentStoreStub {
  readonly intents: DurablePaymentIntent[] = [];
  readonly evidence: any[] = [];
  constructor(private readonly exec: InMemoryExecutionStore) {}
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    // INV-8 gate: the engine refuses to execute unless the intent is SETTLED.
    // Explicit intents first, otherwise any queried operation is treated as
    // settled (engine-level tests only exercise the execution mechanics).
    const explicit = this.intents.find(i => i.operationId === opId);
    if (explicit) return explicit;
    return {
      paymentIntentId: `pi-${opId}`,
      operationId: opId,
      settlementState: "SETTLED",
    } as DurablePaymentIntent;
  }
  async append(record: any): Promise<void> { this.evidence.push(record); }
  async getEvidence(_id: string): Promise<any[]> { return this.evidence; }
  async getSettledIntentsWithoutObligation(): Promise<DurablePaymentIntent[]> {
    const hasExecutionJob = new Set<string>();
    for (const job of this.exec.jobs.values()) {
      if (job.jobType === "EXECUTION") hasExecutionJob.add(job.operationId);
    }
    return this.intents.filter(i => i.settlementState === "SETTLED" && !hasExecutionJob.has(i.operationId));
  }
}

function makeExecutionEngine(exec: InMemoryExecutionStore): PostSettlementEngine {
  const payStore = new EnginePaymentStoreStub(exec);
  return new PostSettlementEngine(payStore as any, exec, {} as any, {
    workerId: "f001-test",
    sellerUrl: "http://seller.test/deliver",
  });
}

function makeJob(operationId: string, overrides: Partial<RecoveryJob> = {}): RecoveryJob {
  const now = Date.now();
  return {
    jobId: `rj-${now}-${Math.random().toString(36).slice(2)}`,
    operationId,
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

function makeAttempt(operationId: string, overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  const now = Date.now();
  return {
    attemptId: `att-${now}-${Math.random().toString(36).slice(2)}`,
    operationId,
    executionId: operationId,
    attemptNumber: 1,
    status: "PENDING",
    idempotencyKey: operationId,
    createdAt: now,
    ...overrides,
  };
}

describe("P0 F-001: atomic execution obligation (engine level)", () => {
  test("F001-1: initiateExecution persists BOTH attempt and job via the atomic primitive", async () => {
    const exec = new InMemoryExecutionStore();
    const engine = makeExecutionEngine(exec);

    const { attemptId, jobId } = await engine.initiateExecution("op-f001-1", "EXECUTION_IDEMPOTENT", { hello: "world" });

    expect(exec.attempts.has(attemptId)).toBe(true);
    expect(exec.jobs.has(jobId)).toBe(true);
    const attempt = exec.attempts.get(attemptId)!;
    const job = exec.jobs.get(jobId)!;
    expect(attempt.status).toBe("PENDING");
    expect(attempt.idempotencyKey).toBe("op-f001-1"); // INV: stable execution identity
    expect(job.jobType).toBe("EXECUTION");
    expect(job.status).toBe("PENDING");
    expect(job.operationId).toBe("op-f001-1");
  });

  test("F001-2: injected failure inside the atomic write → NO partial state (fail closed)", async () => {
    const exec = new InMemoryExecutionStore();
    const engine = makeExecutionEngine(exec);

    // Simulate the exact fault class from the audit: the write fails midway
    // (the production transaction would roll back). The engine MUST leave
    // neither row behind — previously saveAttempt() persisted while
    // saveJob() failed, creating a permanent orphan.
    (exec as any).saveAttemptWithJob = async () => {
      throw new Error("INJECTED_CRASH_BETWEEN_WRITES");
    };

    await expect(engine.initiateExecution("op-f001-2", "EXECUTION_IDEMPOTENT")).rejects.toThrow(
      "INJECTED_CRASH_BETWEEN_WRITES",
    );

    expect(exec.attempts.size).toBe(0);
    expect(exec.jobs.size).toBe(0);
  });

  test("F001-3: legacy orphan (attempt without job) is repaired by the scanner, idempotently", async () => {
    const exec = new InMemoryExecutionStore();
    const engine = makeExecutionEngine(exec);

    // Recreate the pre-fix orphan state: an attempt row WITHOUT any job.
    const orphan = makeAttempt("op-f001-3", { attemptId: "att-f001-3-orphan" });
    await exec.saveAttempt(orphan);

    const payStore = (engine as any).paymentStore as EnginePaymentStoreStub;
    payStore.intents.push({
      paymentIntentId: "pi-f001-3",
      operationId: "op-f001-3",
      settlementState: "SETTLED",
    } as DurablePaymentIntent);

    const created = await engine.ensureExecutionObligations();
    expect(created).toHaveLength(1);
    expect(created[0]).toContain("op-f001-3");
    expect(created[0]).toContain(":repaired");

    const jobs = Array.from(exec.jobs.values());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING");
    expect(jobs[0].operationId).toBe("op-f001-3");
    const meta = jobs[0].metadata as any;
    expect(meta.repairedLegacyOrphan).toBe(true);
    expect(meta.linkedAttemptId).toBe("att-f001-3-orphan");
    expect(meta.linkedAttemptStatus).toBe("PENDING");

    // Obligation repaired evidence is on the audit trail
    const repairedEvidence = payStore.evidence.find(e => e.event === "EXECUTION_OBLIGATION_REPAIRED");
    expect(repairedEvidence).toBeDefined();

    // Idempotent: the intent left the scanner window — nothing new created
    const created2 = await engine.ensureExecutionObligations();
    expect(created2).toHaveLength(0);
    expect(exec.jobs.size).toBe(1);
  });

  test("F001-4: terminal-attempt orphan gets a COMPLETED marker job (never re-executed)", async () => {
    const exec = new InMemoryExecutionStore();
    const engine = makeExecutionEngine(exec);

    const orphan = makeAttempt("op-f001-4", { attemptId: "att-f001-4-orphan", status: "SUCCESS" });
    await exec.saveAttempt(orphan);

    const payStore = (engine as any).paymentStore as EnginePaymentStoreStub;
    payStore.intents.push({
      paymentIntentId: "pi-f001-4",
      operationId: "op-f001-4",
      settlementState: "SETTLED",
    } as DurablePaymentIntent);

    const created = await engine.ensureExecutionObligations();
    expect(created).toHaveLength(1);

    const job = Array.from(exec.jobs.values())[0];
    expect(job.status).toBe("COMPLETED");
    expect((job.metadata as any).repairedLegacyOrphan).toBe(true);
    expect((job.metadata as any).linkedAttemptStatus).toBe("SUCCESS");
  });
});

// ===========================================================================
// F-002 engine-level tests (mock checker, no network)
// ===========================================================================

class ReconStoreStub {
  private intents: Map<string, DurablePaymentIntent> = new Map();
  private evidence: Map<string, any[]> = new Map();

  async append(record: any): Promise<void> {
    const list = this.evidence.get(record.operationId) ?? [];
    list.push(record);
    this.evidence.set(record.operationId, list);
  }
  async getOperation(_id: string): Promise<null> { return null; }
  async saveOperation(_op: any): Promise<void> {}
  async getEvidence(id: string): Promise<any[]> { return this.evidence.get(id) ?? []; }
  async getOperationsByStatus(_status: string): Promise<any[]> { return []; }
  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    for (const i of this.intents.values()) if (i.operationId === opId) return { ...i };
    return null;
  }
  async updatePaymentIntentStatus(id: string, status: any, extra?: any): Promise<void> {
    const i = this.intents.get(id);
    if (!i) throw new Error("NOT_FOUND");
    i.settlementState = status;
    if (extra) Object.assign(i, extra);
    i.updatedAt = Date.now();
  }
  async compareAndSetState(intentId: string, expectedState: any, newState: any, extra?: any): Promise<boolean> {
    const intent = this.intents.get(intentId);
    if (!intent || intent.settlementState !== expectedState) return false;
    intent.settlementState = newState;
    if (extra) Object.assign(intent, extra);
    intent.updatedAt = Date.now();
    return true;
  }
  async canCreateNewPayment(operationId: string): Promise<boolean> {
    for (const i of this.intents.values()) {
      if (i.operationId === operationId) return i.settlementState === "NOT_SETTLED";
    }
    return true;
  }
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<null> { return null; }
  async markNonceSigned(): Promise<void> {}
  async markNonceSubmitted(): Promise<void> {}
  async markNonceSettled(): Promise<void> {}
  async createIntentWithNonce(): Promise<void> {}
  async appendReconciliationObservation(_obs: any): Promise<void> {}
  async getReconciliationObservations(_id: string): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(id: string, bundle: any): Promise<void> {
    const intent = this.intents.get(id);
    if (intent) (intent as any).settledEvidenceBundle = bundle;
  }
  async saveNotSettledEvidenceBundle(id: string, bundle: any): Promise<void> {
    const intent = this.intents.get(id);
    if (intent) (intent as any).notSettledEvidenceBundle = bundle;
  }
  async transitionToSubmitting(id: string): Promise<boolean> {
    return this.compareAndSetState(id, "AUTHORIZED", "SUBMITTING");
  }
  async recordSubmissionResult(id: string, newState: any, txHash?: string): Promise<boolean> {
    return this.compareAndSetState(id, "SUBMITTING", newState, { txHash: txHash ?? undefined });
  }
  async getPaymentIntentById(id: string): Promise<any> {
    const i = this.intents.get(id);
    return i ? JSON.parse(JSON.stringify(i)) : null;
  }
  async getNonTerminalIntents(): Promise<any[]> {
    const nonTerminal = ["SUBMITTING", "SUBMITTED", "SETTLEMENT_PENDING", "RECONCILING"];
    return Array.from(this.intents.values()).filter(i => nonTerminal.includes(i.settlementState));
  }
  getIntent(id: string): DurablePaymentIntent | undefined { return this.intents.get(id); }
}

const PROVIDER_CONFIGS = [
  { providerId: "test-alchemy", underlyingProvider: "alchemy", rpcUrl: "mock://a", maxStalenessBlocks: 5 },
  { providerId: "test-infura", underlyingProvider: "infura", rpcUrl: "mock://b", maxStalenessBlocks: 5 },
];

function makeIntent(overrides: Partial<DurablePaymentIntent> = {}): DurablePaymentIntent {
  const now = Math.floor(Date.now() / 1000);
  return {
    paymentIntentId: `pi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    operationId: `op-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    authorizer: "0xAuthorizer",
    payTo: "0xPayee",
    value: "1000000",
    asset: "0xUSDC",
    network: "base-sepolia",
    nonce: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`,
    validAfter: now - 3600,
    validBefore: now + 3600,
    paymentPayload: "base64payload",
    paymentPayloadHash: "0xhash",
    settlementState: "RECONCILING",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as DurablePaymentIntent;
}

async function setupNotSettledCandidate() {
  const store = new ReconStoreStub();
  const checker = new MockMultiRpcChecker(PROVIDER_CONFIGS);
  const engine = new ReconciliationEngine(store, checker as any);
  const intent = makeIntent({
    settlementState: "RECONCILING",
    validBefore: Math.floor(Date.now() / 1000) - 3600, // expired
  });
  await store.createPaymentIntent(intent);
  checker.setAuthResult(intent.nonce, false); // unanimous false
  return { store, checker, engine, intent };
}

describe("P0 F-002: honest NOT_SETTLED proof (engine level)", () => {
  test("F002-1: NEGATIVE (audit-mandated) — NOT_SETTLED is impossible with ZERO scan calls", async () => {
    const { store, checker, engine, intent } = await setupNotSettledCandidate();
    const outcome = await engine.reconcile(intent.paymentIntentId);

    expect(outcome.status).toBe("NOT_SETTLED");
    // THE AUDIT'S NEGATIVE TEST: if the engine ever reaches a terminal
    // NOT_SETTLED, at least one REAL scan must have been executed.
    // With the pre-fix engine this counter stayed at 0.
    expect(checker.scanAuthorizationUsedCallCount).toBeGreaterThanOrEqual(1);
    expect(store.getIntent(intent.paymentIntentId)!.settlementState).toBe("NOT_SETTLED");
  });

  test("F002-2: evidence carries real block data and a per-provider scan summary (no zeros)", async () => {
    const { store, engine, intent } = await setupNotSettledCandidate();
    await engine.reconcile(intent.paymentIntentId);

    const bundle = (store.getIntent(intent.paymentIntentId) as any)
      .notSettledEvidenceBundle as NotSettledEvidenceBundle;
    expect(bundle).toBeDefined();
    expect(bundle.scanComplete).toBe(true);
    expect(bundle.authorizationUsedScanResult).toBe("SCAN_COMPLETE_EMPTY");

    // The scan summary documents the ACTUAL scan — not a self-asserted label
    expect(bundle.authorizationUsedScan?.outcome).toBe("SCAN_COMPLETE_EMPTY");
    expect(bundle.authorizationUsedScan?.observations.length).toBeGreaterThanOrEqual(2);
    for (const o of bundle.authorizationUsedScan!.observations) {
      expect(o.scanned).toBe(true); // every provider actually executed the scan
      expect(o.toBlock).toBeGreaterThan(0);
    }

    // Block data is REAL (pre-fix it was unconditionally zeroed)
    expect(bundle.rpcObservations.length).toBeGreaterThanOrEqual(2);
    for (const obs of bundle.rpcObservations) {
      expect(obs.blockNumber).toBeGreaterThan(0);
      expect(obs.chainHead).toBeGreaterThan(0);
      expect(obs.stalenessBlocks).toBeGreaterThanOrEqual(0);
    }
  });

  test("F002-3: INCOMPLETE scan → RECONCILING; no terminal CAS; new payments stay blocked", async () => {
    const { store, checker, engine, intent } = await setupNotSettledCandidate();
    checker.setScanOutcome(intent.nonce, "INCOMPLETE"); // one provider failed to scan

    const outcome = await engine.reconcile(intent.paymentIntentId);
    expect(outcome.status).toBe("RECONCILING");
    expect(String((outcome as any).reason)).toContain("INCOMPLETE");

    // No terminal transition happened
    expect(store.getIntent(intent.paymentIntentId)!.settlementState).toBe("RECONCILING");
    expect((store.getIntent(intent.paymentIntentId) as any).notSettledEvidenceBundle).toBeUndefined();

    // §3 economic safety: while unresolved, a new payment is NOT allowed
    expect(await store.canCreateNewPayment(intent.operationId)).toBe(false);
  });

  test("F002-4: DISAGREEING scan → RECONCILING (providers contradict each other)", async () => {
    const { store, checker, engine, intent } = await setupNotSettledCandidate();
    checker.setScanOutcome(intent.nonce, "DISAGREEMENT");

    const outcome = await engine.reconcile(intent.paymentIntentId);
    expect(outcome.status).toBe("RECONCILING");
    expect(store.getIntent(intent.paymentIntentId)!.settlementState).toBe("RECONCILING");
  });

  test("F002-5: EVENT_FOUND → §17 txHash recovery; NOT_SETTLED on a found event is forbidden", async () => {
    const { store, checker, engine, intent } = await setupNotSettledCandidate();
    checker.setScanOutcome(intent.nonce, "EVENT_FOUND", {
      transactionHash: "0xscanfound",
      blockNumber: 90,
      logIndex: 0,
    });
    checker.setTxResult("0xscanfound", {
      confirmed: false,
      status: "reverted",
      blockNumber: 90,
      logs: [],
    });
    let txChecks = 0;
    const origCheck = checker.checkTransaction.bind(checker);
    (checker as any).checkTransaction = async (h: string) => {
      txChecks += 1;
      return origCheck(h);
    };

    const outcome = await engine.reconcile(intent.paymentIntentId);

    // The engine followed the recovered transaction (§17) instead of
    // declaring NOT_SETTLED on a consumed authorization.
    expect(txChecks).toBeGreaterThanOrEqual(1);
    expect(outcome.status).toBe("NOT_SETTLED"); // via §9: transaction reverted
    expect(store.getIntent(intent.paymentIntentId)!.txHash).toBe("0xscanfound");
  });
});

describe("P0 F-002: §11-D real freshness gate (production checker)", () => {
  const checker = new MultiRpcChecker([
    { providerId: "alchemy-1", underlyingProvider: "alchemy", rpcUrl: "http://127.0.0.1:1", maxStalenessBlocks: 5 },
    { providerId: "infura-1", underlyingProvider: "infura", rpcUrl: "http://127.0.0.1:2", maxStalenessBlocks: 5 },
  ]);
  const expired = Math.floor(Date.now() / 1000) - 3600;
  const now = Math.floor(Date.now() / 1000);
  const base = { agreement: "UNANIMOUS" as const, unanimousValue: false as const };
  const obs = (providerId: string, blockData?: { blockNumber: number; chainHead: number; stalenessBlocks: number }) => ({
    providerId,
    underlyingProvider: providerId.split("-")[0],
    result: false as const,
    observedAt: Date.now(),
    ...(blockData ? { blockData } : {}),
  });

  test("F002-6a: fresh blockData within the staleness budget → allowed", () => {
    const authResult = {
      ...base,
      observations: [
        obs("alchemy-1", { blockNumber: 100, chainHead: 100, stalenessBlocks: 0 }),
        obs("infura-1", { blockNumber: 100, chainHead: 100, stalenessBlocks: 2 }),
      ],
    };
    const verdict = checker.canDeclareNotSettled(authResult as any, expired, now);
    expect(verdict.allowed).toBe(true);
  });

  test("F002-6b: stale provider (beyond maxStalenessBlocks) → blocked", () => {
    const authResult = {
      ...base,
      observations: [
        obs("alchemy-1", { blockNumber: 90, chainHead: 100, stalenessBlocks: 10 }), // budget 5
        obs("infura-1", { blockNumber: 100, chainHead: 100, stalenessBlocks: 0 }),
      ],
    };
    const verdict = checker.canDeclareNotSettled(authResult as any, expired, now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("§11-D");
    expect(verdict.reason).toContain("stale");
  });

  test("F002-6c: missing blockData → blocked (cannot prove WHEN the state was read)", () => {
    const authResult = {
      ...base,
      observations: [
        obs("alchemy-1", undefined), // no block context
        obs("infura-1", { blockNumber: 100, chainHead: 100, stalenessBlocks: 0 }),
      ],
    };
    const verdict = checker.canDeclareNotSettled(authResult as any, expired, now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("§11-D");
    expect(verdict.reason).toContain("no fresh block data");
  });

  test("F002-6d: unknown provider (no staleness budget) → blocked", () => {
    const authResult = {
      ...base,
      observations: [
        obs("ghost-1", { blockNumber: 100, chainHead: 100, stalenessBlocks: 0 }),
        obs("infura-1", { blockNumber: 100, chainHead: 100, stalenessBlocks: 0 }),
      ],
    };
    const verdict = checker.canDeclareNotSettled(authResult as any, expired, now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("§11-D");
  });
});

// ===========================================================================
// F-001 live PostgreSQL tests (run when DATABASE_URL is provisioned)
// ===========================================================================

function resultRows<T = any>(result: any): T[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/** Drizzle wraps driver/inner errors — walk the cause chain for the marker. */
function errorText(err: any, depth = 0): string {
  if (!err || depth > 6) return "";
  return `${err.message ?? ""} ${errorText(err.cause, depth + 1)}`;
}

// Live tests require a REAL PostgreSQL endpoint — a placeholder non-postgres
// URL (e.g. file:) must skip cleanly instead of failing on connection errors.
const dbUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbUrl.startsWith("postgres") ? describe : describe.skip;

describeIfDb("P0 F-001: live PostgreSQL (fault-injection + scanner self-heal)", () => {
  let db: any;
  let PES: any;
  let PVS: any;

  beforeAll(async () => {
    const mod = await import("@workspace/db");
    db = mod.db;
    PES = mod.PostgresExecutionStore;
    PVS = mod.PostgresEvidenceStore;
  });

  test("F001-5: injected failure BETWEEN the two inserts → full rollback (no orphan)", async () => {
    const now = Date.now();
    const opId = `op-f001-fi-${now}`;
    const job = makeJob(opId, { jobId: `rj-f001-fi-${now}` });
    const att = makeAttempt(opId, { attemptId: `att-f001-fi-${now}` });
    const exec = new PES(db);

    // Fault-injection exactly BETWEEN the two writes: the 2nd insert inside
    // the transaction throws, emulating the audit's crash scenario.
    const realTransaction = db.transaction.bind(db);
    let inserts = 0;
    (db as any).transaction = async (cb: any) =>
      realTransaction(async (tx: any) => {
        const realInsert = tx.insert.bind(tx);
        tx.insert = (...args: any[]) => {
          inserts += 1;
          if (inserts === 2) throw new Error("INJECTED_CRASH_BETWEEN_WRITES");
          return realInsert(...args);
        };
        return cb(tx);
      });

    let caught: any = null;
    try {
      await exec.saveAttemptWithJob(att, job);
    } catch (e) {
      caught = e;
    }
    (db as any).transaction = realTransaction; // restore before assertions

    expect(errorText(caught)).toContain("INJECTED_CRASH_BETWEEN_WRITES");

    // THE F-001 INVARIANT: no partial state. The job insert rolled back too —
    // an orphan (attempt without job) is now IMPOSSIBLE by construction.
    const rjAfter = await db.execute(sql`SELECT job_id FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    expect(resultRows(rjAfter)).toHaveLength(0);
    const eaAfter = await db.execute(sql`SELECT attempt_id FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    expect(resultRows(eaAfter)).toHaveLength(0);

    // Recovery: the same call succeeds after the transient failure and
    // creates BOTH rows.
    await exec.saveAttemptWithJob(att, job);
    const rjOk = await db.execute(sql`SELECT job_id, operation_id FROM recovery_jobs WHERE job_id = ${job.jobId}`);
    expect(resultRows(rjOk)).toHaveLength(1);
    expect(resultRows(rjOk)[0].operation_id).toBe(opId);
    const eaOk = await db.execute(sql`SELECT attempt_id, operation_id FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    expect(resultRows(eaOk)).toHaveLength(1);
    expect(resultRows(eaOk)[0].operation_id).toBe(opId);

    // Cleanup
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${att.attemptId}`);
    await db.execute(sql`DELETE FROM recovery_jobs WHERE job_id = ${job.jobId}`);
  });

  test("F001-6: scanner re-selects SETTLED intent with orphan attempt and heals it", async () => {
    const now = Date.now();
    const opId = `op-f001-orphan-${now}`;
    const piId = `pi-f001-orphan-${now}`;
    const attId = `att-f001-orphan-${now}`;

    // Setup: SETTLED intent + orphan attempt WITHOUT any recovery job —
    // the exact state the pre-fix crash window produced and the pre-fix
    // scanner excluded forever.
    await db.execute(sql`
      INSERT INTO payment_intents (payment_intent_id, operation_id, authorizer, pay_to, value, asset, network, nonce, valid_after, valid_before, payment_payload, payment_payload_hash, settlement_state, created_at, updated_at, version)
      VALUES (${piId}, ${opId}, 'test-authorizer', '0xTestPayTo', '0.000001', 'USDC', 'base-sepolia', '0', 0, 9999999999, '{}', '0xhash', ${"SETTLED"}, NOW(), NOW(), 1)
      ON CONFLICT (payment_intent_id) DO UPDATE SET settlement_state = ${"SETTLED"}
    `);
    await db.execute(sql`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES (${attId}, ${opId}, ${opId}, 1, ${"PENDING"}, ${opId}, NOW())
    `);

    const paymentStore = new PVS(db);
    const exec = new PES(db);
    const engine = new PostSettlementEngine(paymentStore as any, exec as any, {} as any, {
      workerId: "f001-scanner-test",
      sellerUrl: "http://seller.test/deliver",
    });

    // Pre-fix, the scanner's second NOT EXISTS(execution_attempts) clause
    // EXCLUDED this intent permanently. Now it must surface.
    const selected = await (paymentStore as any).getSettledIntentsWithoutObligation();
    expect(selected.some((i: any) => i.operationId === opId)).toBe(true);

    const created = await engine.ensureExecutionObligations();
    const mine = created.filter(c => c.startsWith(opId));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain(":repaired");

    const jobRow = await db.execute(sql`
      SELECT job_id, status, metadata FROM recovery_jobs
      WHERE operation_id = ${opId} AND job_type = ${"EXECUTION"}
    `);
    expect(resultRows(jobRow)).toHaveLength(1);
    expect(resultRows(jobRow)[0].status).toBe("PENDING");
    expect(resultRows(jobRow)[0].metadata?.repairedLegacyOrphan).toBe(true);
    expect(resultRows(jobRow)[0].metadata?.linkedAttemptId).toBe(attId);

    // Idempotent: the healed intent left the scanner window
    const created2 = await engine.ensureExecutionObligations();
    expect(created2.filter(c => c.startsWith(opId))).toHaveLength(0);

    // Cleanup
    await db.execute(sql`DELETE FROM recovery_jobs WHERE operation_id = ${opId} AND job_type = ${"EXECUTION"}`);
    await db.execute(sql`DELETE FROM execution_attempts WHERE attempt_id = ${attId}`);
    await db.execute(sql`DELETE FROM payment_intents WHERE payment_intent_id = ${piId}`);
  });
});
