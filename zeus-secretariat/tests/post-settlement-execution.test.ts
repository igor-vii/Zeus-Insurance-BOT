/**
 * Zeus Secretariat V0 — Phase 2.4 Tests
 *
 * AJ: Settled → successful seller execution
 * AK: Timeout after payment → DELIVERY_UNKNOWN (no new payment)
 * AL: Idempotent retry — stable key, single payment
 * AM: Result retrieval — observation, not re-execution
 * AN: NONE guard — no blind retry on DELIVERY_UNKNOWN
 * AO: Crash recovery after settlement
 * AP: HTTP 5xx stored as separate fact from timeout
 * AQ: Concurrent workers — only one claims the job
 */

import {
  PostSettlementEngine,
  InMemoryExecutionStore,
  type ExecutionCapability,
} from "../src/core/post-settlement-engine";
import { MockSellerExecutionAdapter } from "../src/adapters/seller-execution-adapter";
import type {
  DurableEvidenceStore,
  PaymentIntent,
  EvidenceRecord,
  Operation,
  OperationStatus,
} from "../src/core/types";

// ---------------------------------------------------------------------------
// Minimal in-memory payment store for tests
// ---------------------------------------------------------------------------

class TestPaymentStore implements DurableEvidenceStore {
  private intents: Map<string, PaymentIntent> = new Map();
  private evidence: Map<string, EvidenceRecord[]> = new Map();

  async append(record: EvidenceRecord): Promise<void> {
    const list = this.evidence.get(record.operationId) ?? [];
    list.push(record);
    this.evidence.set(record.operationId, list);
  }
  async getOperation(_id: string): Promise<Operation | null> { return null; }
  async saveOperation(_op: Operation): Promise<void> {}
  async getEvidence(id: string): Promise<EvidenceRecord[]> { return this.evidence.get(id) ?? []; }
  async getOperationsByStatus(_s: OperationStatus): Promise<Operation[]> { return []; }

  async createPaymentIntent(intent: any): Promise<void> {
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getPaymentIntentByOperationId(opId: string): Promise<any> {
    for (const i of this.intents.values()) if (i.operationId === opId) return { ...i };
    return null;
  }
  async updatePaymentIntentStatus(id: string, status: any, extra?: any): Promise<void> {
    const i = this.intents.get(id);
    if (i) { i.status = status; if (extra?.txHash) i.txHash = extra.txHash; }
  }
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<null> { return null; }
  async markNonceSigned(): Promise<void> {}
  async markNonceSubmitted(): Promise<void> {}
  async markNonceSettled(): Promise<void> {}
  async createIntentWithNonce(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettledIntent(operationId: string): PaymentIntent {
  return {
    paymentIntentId: `intent-${operationId}`,
    operationId,
    status: "SETTLED",
    payer: "0xPayer",
    payTo: "0xPayee",
    value: "1000000",
    nonce: "0xnonce",
    txHash: "0xtxhash",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeEngine(
  sellerBehavior: any = {},
  capability: ExecutionCapability = "EXECUTION_IDEMPOTENT",
) {
  const paymentStore = new TestPaymentStore();
  const executionStore = new InMemoryExecutionStore();
  const seller = new MockSellerExecutionAdapter(sellerBehavior);
  const engine = new PostSettlementEngine(paymentStore, executionStore, seller, {
    workerId: "worker-1",
    sellerUrl: "https://seller.example.com/execute",
    resultRetrievalUrl: "https://seller.example.com/result",
  });
  return { paymentStore, executionStore, seller, engine, capability };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 2.4: Post-Settlement Execution & Recovery", () => {

  // ---- Test AJ: Settled → successful seller execution ----

  test("AJ: settled intent leads to successful seller execution", async () => {
    const opId = "op-aj-success";
    const { paymentStore, executionStore, seller, engine } = makeEngine({ forceStatusCode: 200 });

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const { attemptId, jobId } = await engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT", { action: "deliver" });

    const result = await engine.processJob(jobId);

    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("SUCCESS");
    expect(seller.getCallCount()).toBe(1);

    const attempts = await executionStore.getAttemptsByOperation(opId);
    expect(attempts[0].status).toBe("SUCCESS");
    expect(attempts[0].responseStatusCode).toBe(200);
  });

  // ---- Test AK: Timeout after payment → DELIVERY_UNKNOWN ----

  test("AK: timeout after payment results in DELIVERY_UNKNOWN, no new payment", async () => {
    const opId = "op-ak-timeout";
    const { paymentStore, seller, engine } = makeEngine({ forceTimeout: true });

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const { jobId } = await engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT");
    const result = await engine.processJob(jobId);

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe("DELIVERY_UNKNOWN");
    expect(seller.getCallCount()).toBe(1);

    // Verify no new payment was created
    const intent = await paymentStore.getPaymentIntentByOperationId(opId);
    expect(intent!.status).toBe("SETTLED"); // unchanged — no new payment
  });

  // ---- Test AL: Idempotent retry — stable key, single payment ----

  test("AL: idempotent retry uses same key, payment submitted only once", async () => {
    const opId = "op-al-idempotent";
    let callCount = 0;
    const { paymentStore, seller, engine } = makeEngine({});

    // First call times out, second succeeds
    const originalExecute = seller.execute.bind(seller);
    seller.execute = async (req) => {
      callCount++;
      if (callCount === 1) {
        return { kind: "DELIVERY_UNKNOWN" as const, reason: "TIMEOUT" as const, error: "timeout", durationMs: 30000 };
      }
      return originalExecute(req);
    };
    seller.setBehavior({ forceStatusCode: 200 });

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const { jobId } = await engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT", { action: "deliver" });

    // First process → timeout → re-queued
    await engine.processJob(jobId);

    // Second process → success with SAME idempotency key
    const result = await engine.processJob(jobId);

    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("SUCCESS");

    // INV-9: Same idempotency key on both calls
    expect(seller.callLog[0].idempotencyKey).toBe(seller.callLog[1].idempotencyKey);
    expect(seller.callLog[0].idempotencyKey).toBe(opId); // stable = operationId

    // Payment was submitted only once (settled intent unchanged)
    const intent = await paymentStore.getPaymentIntentByOperationId(opId);
    expect(intent!.status).toBe("SETTLED");
  });

  // ---- Test AM: Result retrieval — observation, not re-execution ----

  test("AM: result retrieval uses GET, does not re-execute original request", async () => {
    const opId = "op-am-retrieval";
    const { paymentStore, seller, engine } = makeEngine({});

    // First call times out
    let callNum = 0;
    const originalExecute = seller.execute.bind(seller);
    seller.execute = async (req) => {
      callNum++;
      if (callNum === 1) {
        return { kind: "DELIVERY_UNKNOWN" as const, reason: "TIMEOUT" as const, error: "timeout", durationMs: 30000 };
      }
      // Retrieval call — should be GET
      return {
        kind: "SUCCESS" as const,
        statusCode: 200,
        body: { result: "completed" },
        headers: {},
        durationMs: 50,
      };
    };

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const { jobId } = await engine.initiateExecution(opId, "RESULT_RETRIEVAL", { action: "deliver" });

    // First process → timeout → creates retrieval job
    await engine.processJob(jobId);

    // Find the retrieval job
    const allJobs = Array.from((engine as any).executionStore.jobs.values());
    const retrievalJob = allJobs.find((j: any) => j.jobType === "RETRIEVAL");
    expect(retrievalJob).toBeDefined();

    // Process retrieval job
    const result = await engine.processJob((retrievalJob as any)?.jobId);

    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("SUCCESS");

    // INV-11: Second call was GET (retrieval), not POST (re-execution)
    expect(seller.callLog[1].method).toBe("GET");
    expect(seller.callLog[0].method).toBe("POST");
  });

  // ---- Test AN: NONE guard — no blind retry ----

  test("AN: NONE capability + DELIVERY_UNKNOWN = UNRESOLVABLE, zero retries", async () => {
    const opId = "op-an-none-guard";
    const { paymentStore, seller, engine } = makeEngine({ forceTimeout: true }, "NONE");

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const { jobId } = await engine.initiateExecution(opId, "NONE", { action: "deliver" });
    const result = await engine.processJob(jobId);

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe("UNRESOLVABLE");

    // INV-10: Only ONE call to seller, never retried
    expect(seller.getCallCount()).toBe(1);
  });

  // ---- Test AO: Crash recovery after settlement ----

  test("AO: crash recovery resumes pending execution without new payment", async () => {
    const opId = "op-ao-crash-recovery";
    const { paymentStore, executionStore, seller, engine } = makeEngine({ forceStatusCode: 200 });

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    // Simulate: init execution, then "crash" before processing
    const { jobId } = await engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT", { action: "deliver" });

    // "Crash" — job is still PENDING in DB
    const job = await executionStore.getJob(jobId);
    expect(job!.status).toBe("PENDING");

    // "Restart" — recover pending jobs
    const recovered = await engine.recoverPendingJobs();

    expect(recovered.length).toBe(1);
    expect(recovered[0]).toContain("SUCCESS");

    // Seller called exactly once (no duplicate payment)
    expect(seller.getCallCount()).toBe(1);

    // Payment still SETTLED (no new payment created)
    const intent = await paymentStore.getPaymentIntentByOperationId(opId);
    expect(intent!.status).toBe("SETTLED");
  });

  // ---- Test AP: HTTP 5xx stored separately from timeout ----

  test("AP: HTTP 5xx is HTTP_FAILURE, not DELIVERY_UNKNOWN", async () => {
    const opId = "op-ap-5xx";
    const { paymentStore, executionStore, seller, engine } = makeEngine({ forceStatusCode: 500 });

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const { jobId } = await engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT");
    const result = await engine.processJob(jobId);

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe("HTTP_FAILURE");

    // Verify the attempt recorded HTTP_FAILURE, not DELIVERY_UNKNOWN
    const attempts = await executionStore.getAttemptsByOperation(opId);
    expect(attempts[0].status).toBe("HTTP_FAILURE");
    expect(attempts[0].responseStatusCode).toBe(500);

    // Evidence contains raw result BEFORE interpretation (INV-13)
    const evidence = await paymentStore.getEvidence(opId);
    const rawEvidence = evidence.find(e => e.event === "EXECUTION_RESULT_RAW");
    expect(rawEvidence).toBeDefined();
    expect((rawEvidence!.payload as any).result.kind).toBe("HTTP_FAILURE");
  });

  // ---- Test AQ: Concurrent workers — only one claims the job ----

  test("AQ: concurrent workers — only one processes the job", async () => {
    const opId = "op-aq-concurrent";
    const paymentStore = new TestPaymentStore();
    const executionStore = new InMemoryExecutionStore();
    const seller = new MockSellerExecutionAdapter({ forceStatusCode: 200, delayMs: 50 });

    await paymentStore.createPaymentIntent(makeSettledIntent(opId));

    const engine1 = new PostSettlementEngine(paymentStore, executionStore, seller, {
      workerId: "worker-1",
      sellerUrl: "https://seller.example.com/execute",
    });

    const engine2 = new PostSettlementEngine(paymentStore, executionStore, seller, {
      workerId: "worker-2",
      sellerUrl: "https://seller.example.com/execute",
    });

    const { jobId } = await engine1.initiateExecution(opId, "EXECUTION_IDEMPOTENT");

    // Both workers try to process simultaneously
    const [result1, result2] = await Promise.all([
      engine1.processJob(jobId),
      engine2.processJob(jobId),
    ]);

    // Exactly one succeeds, the other gets false
    const successes = [result1, result2].filter(r => r.success);
    expect(successes.length).toBe(1);

    // Seller called exactly once (not twice)
    expect(seller.getCallCount()).toBe(1);
  });

  // ---- Test AR: INV-8 — cannot execute without settlement ----

  test("AR: INV-8 — execution rejected if intent is not SETTLED", async () => {
    const opId = "op-ar-no-settlement";
    const { paymentStore, engine } = makeEngine();

    // Create intent with AUTHORIZED status (not SETTLED)
    await paymentStore.createPaymentIntent({
      ...makeSettledIntent(opId),
      status: "AUTHORIZED",
    });

    await expect(
      engine.initiateExecution(opId, "EXECUTION_IDEMPOTENT"),
    ).rejects.toThrow("INV-8_VIOLATION");
  });

  async transitionToSubmitting(id: string): Promise<boolean> {
    return this.compareAndSetState(id, "AUTHORIZED", "SUBMITTING");
  }
  async recordSubmissionResult(id: string, ns: any, txHash?: string, hs?: number, body?: unknown): Promise<boolean> {
    return this.compareAndSetState(id, "SUBMITTING", ns, { txHash: txHash ?? undefined } as any);
  }
  async getPaymentIntentById(id: string): Promise<any> {
    for (const i of this.intents.values()) { if ((i as any).paymentIntentId === id) return JSON.parse(JSON.stringify(i)); }
    return null;
  }
  async getNonTerminalIntents(): Promise<any[]> {
    const nt = ["SUBMITTING","SUBMITTED","SETTLEMENT_PENDING","RECONCILING"];
    return Array.from(this.intents.values()).filter((i:any)=>nt.includes(i.settlementState??i.status)).map((i:any)=>JSON.parse(JSON.stringify(i)));
  }
  async compareAndSetState(id: string, exp: any, nxt: any, extra?: any): Promise<boolean> {
    const i = this.intents.get(id); if (!i) return false;
    if ((i as any).settlementState !== exp && (i as any).status !== exp) return false;
    if ((i as any).settlementState !== undefined) (i as any).settlementState = nxt; else (i as any).status = nxt;
    if (extra?.txHash) (i as any).txHash = extra.txHash; return true;
  }
  async canCreateNewPayment(opId: string): Promise<boolean> {
    for (const i of this.intents.values()) { if ((i as any).operationId === opId) { const s = (i as any).settlementState ?? (i as any).status; return s === "NOT_SETTLED"; } }
    return true;
  }
  async appendReconciliationObservation(_o: any): Promise<void> {}
  async getReconciliationObservations(_id: string): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(id: string, b: any): Promise<void> { const i = this.intents.get(id); if (i) (i as any).settledEvidenceBundle = b; }
  async saveNotSettledEvidenceBundle(id: string, b: any): Promise<void> { const i = this.intents.get(id); if (i) (i as any).notSettledEvidenceBundle = b; }

}
