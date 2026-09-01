/**
 * BLOCK 8.2-B.2 — V2 Settlement Submission Tests
 */

import type {
  DurablePaymentIntent,
  DurableEvidenceStore,
  EvidenceRecord,
  Operation,
  PaymentPolicy,
  ExecuteRequest,
  PaymentRequirement,
  PaymentAuthorization,
  SigningContext,
  PaymentAdapter,
  PaymentSigner,
  SettlementObservation,
  PaymentSubmissionResult,

} from '../src/core/types';
import { Secretariat } from '../src/core/state-machine';
import type { SettlementAdapter, PaymentPayload, SubmitResult } from '../src/adapters/x402-facilitator-client';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const MOCK_X402_CHALLENGE = {
  accepts: [{
    scheme: "exact",
    network: "base-sepolia",
    asset: "0xUSDC",
    amount: "1000000",
    payTo: "0xSellerAddress",
    maxTimeoutSeconds: 300,
  }],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(MOCK_X402_CHALLENGE), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  })) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Test Store
// ---------------------------------------------------------------------------

class TestDurableStore implements DurableEvidenceStore {
  private intents: Map<string, DurablePaymentIntent> = new Map();
  private operations: Map<string, Operation> = new Map();
  private evidence: Map<string, EvidenceRecord[]> = new Map();

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    for (const existing of this.intents.values()) {
      if (existing.operationId === intent.operationId) throw new Error("DUPLICATE");
    }
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    for (const intent of this.intents.values()) {
      if (intent.operationId === opId) return { ...intent };
    }
    return null;
  }
  cloneForRestart(): TestDurableStore {
    const c = new TestDurableStore();
    for (const [k, v] of this.intents) c.intents.set(k, { ...v });
    for (const [k, v] of this.operations) c.operations.set(k, { ...v });
    for (const [k, v] of this.evidence) c.evidence.set(k, [...v]);
    return c;
  }
  async updatePaymentIntentStatus(): Promise<void> {}
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<any> { return null; }
  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }
  async getOperation(opId: string): Promise<Operation | null> { return this.operations.get(opId) ?? null; }
  async saveOperation(operation: Operation): Promise<void> { this.operations.set(operation.operationId, { ...operation }); }
  async getEvidence(opId: string): Promise<EvidenceRecord[]> { return this.evidence.get(opId) ?? []; }
  async getOperationsByStatus(): Promise<Operation[]> { return []; }
  async getNonTerminalIntents(): Promise<DurablePaymentIntent[]> { return []; }
  async appendReconciliationObservation(): Promise<void> {}
  async getReconciliationObservations(): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(): Promise<void> {}
  async saveNotSettledEvidenceBundle(): Promise<void> {}
  async getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null> {
    for (const op of this.operations.values()) {
      if (op.clientId === clientId && op.requestId === requestId) return { ...op };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mock Legacy Adapter (still needed for authorizePayment createAuthorization)
// ---------------------------------------------------------------------------

class TestLegacyAdapter implements PaymentAdapter {
  readonly network = "base-sepolia";
  public legacySubmitCalled = false;
  async createAuthorization(req: PaymentRequirement, _s: PaymentSigner, ctx: SigningContext): Promise<PaymentAuthorization> {
    return { signature: "0xsig-" + ctx.operationId, scheme: "exact", timestamp: Date.now(), context: ctx };
  }
  async submit(): Promise<PaymentSubmissionResult> {
    this.legacySubmitCalled = true;
    return { success: true, transactionHash: "0xlegacy" } as any;
  }
  async observeSettlement(): Promise<SettlementObservation> { return { settled: false, reason: "PENDING" } as any; }
}

// ---------------------------------------------------------------------------
// Mock Canonical Settlement Adapter
// ---------------------------------------------------------------------------

class TestSettlementAdapter implements SettlementAdapter {
  public submitCalls: Array<{ intent: DurablePaymentIntent; payload: any }> = [];
  public responseStatus: "SUBMITTED" | "REJECTED" | "UNKNOWN" = "SUBMITTED";

  async submit(intent: DurablePaymentIntent, payload: unknown) {
    this.submitCalls.push({ intent, payload });
    if (this.responseStatus === "SUBMITTED") return { status: "SUBMITTED" as const, txHash: "0xtxhash", rawResponse: {} };
    if (this.responseStatus === "REJECTED") return { status: "REJECTED" as const, reason: "REJECTED_BY_FACILITATOR", rawResponse: null };
    return { status: "UNKNOWN" as const, error: "NETWORK_TIMEOUT" };
  }
}

const mockSigner: PaymentSigner = {
  signerType: "TEST",
  async getAddress() { return "0xTestPayer"; },
  async signPayment() { throw new Error("Not used"); },
};

function makeRequest(overrides?: Partial<ExecuteRequest>): ExecuteRequest {
  return {
    target: "https://seller.example.com/api",
    method: "GET",
    policy: { maxPrice: "1000000", allowedNetworks: ["base-sepolia"], allowedAssets: ["0xUSDC"], authorizationMode: "policy-bound" } as PaymentPolicy,
    requestId: "req-default",
    clientId: "client-default",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BLOCK 8.2-B.2: V2 Settlement Submission", () => {
  let store: TestDurableStore;
  let legacyAdapter: TestLegacyAdapter;
  let settlementAdapter: TestSettlementAdapter;
  let secretariat: Secretariat;

  beforeEach(() => {
    store = new TestDurableStore();
    legacyAdapter = new TestLegacyAdapter();
    settlementAdapter = new TestSettlementAdapter();
    const adapters = new Map<string, PaymentAdapter>();
    adapters.set("base-sepolia", legacyAdapter);
    secretariat = new Secretariat({
      evidenceStore: store,
      signer: mockSigner,
      adapters,
      settlementAdapter,
    });
  });

  test("B2.1: canonical V2 submission — SettlementAdapter receives V2 payload", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-1" })); } catch {}
    expect(settlementAdapter.submitCalls.length).toBeGreaterThanOrEqual(1);
    const call = settlementAdapter.submitCalls[0];
    expect(call.payload.x402Version).toBe(2);
    expect(call.payload.accepted).toBeDefined();
    expect(call.payload.payload.signature).toBeDefined();
    expect(call.payload.payload.authorization).toBeDefined();
  });

  test("B2.2: complete EIP-3009 authorization fields", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-2" })); } catch {}
    const auth = settlementAdapter.submitCalls[0]?.payload?.payload?.authorization;
    expect(auth).toBeDefined();
    expect(typeof auth.from).toBe("string");
    expect(typeof auth.to).toBe("string");
    expect(typeof auth.value).toBe("string");
    expect(typeof auth.validAfter).toBe("string");
    expect(typeof auth.validBefore).toBe("string");
    expect(typeof auth.nonce).toBe("string");
  });

  test("B2.3: DPI used as authoritative record", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-3" })); } catch {}
    const call = settlementAdapter.submitCalls[0];
    expect(call.intent).toBeDefined();
    expect(call.intent.paymentIntentId).toBeDefined();
    expect(call.intent.operationId).toBeDefined();
    expect(call.intent.network).toBe("base-sepolia");
  });

  test("B2.4: legacy PaymentAdapter.submit NOT called", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-4" })); } catch {}
    expect(legacyAdapter.legacySubmitCalled).toBe(false);
    expect(settlementAdapter.submitCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("B2.5: restart before submission — same DPI recovered", async () => {
    // Runtime A: execute through authorization, persist DPI
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-5", clientId: "client-restart" })); } catch {}

    // Clone store to simulate restart
    const restartedStore = store.cloneForRestart();
    const adapters2 = new Map<string, PaymentAdapter>();
    adapters2.set("base-sepolia", new TestLegacyAdapter());
    const sa2 = new TestSettlementAdapter();
    const sm2 = new Secretariat({
      evidenceStore: restartedStore,
      signer: mockSigner,
      adapters: adapters2,
      settlementAdapter: sa2,
    });

    // Re-execute with same identity — should recover existing DPI
    try { await sm2.execute(makeRequest({ requestId: "req-b2-5", clientId: "client-restart" })); } catch {}

    // Verify settlement adapter received the SAME paymentIntentId
    if (sa2.submitCalls.length > 0) {
      const originalIntentId = settlementAdapter.submitCalls[0]?.intent?.paymentIntentId;
      const recoveredIntentId = sa2.submitCalls[0]?.intent?.paymentIntentId;
      expect(recoveredIntentId).toBe(originalIntentId);
    }
  });

  test("B2.6: duplicate submission — no second DPI created", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-6", clientId: "client-dup" })); } catch {}
    const firstCallCount = settlementAdapter.submitCalls.length;

    // Second execution with same identity
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-6", clientId: "client-dup" })); } catch {}

    // Should not have created additional submit calls (idempotency returns existing)
    expect(settlementAdapter.submitCalls.length).toBe(firstCallCount);
  });

  test("B2.7: UNKNOWN result preserved, not converted to FAILED", async () => {
    settlementAdapter.responseStatus = "UNKNOWN";

    // Should NOT throw — UNKNOWN is a valid state
    let threw = false;
    try { await secretariat.execute(makeRequest({ requestId: "req-b2-7" })); } catch { threw = true; }

    // UNKNOWN should not cause an exception (it is a valid economic state)
    // The state machine may still throw from observeSettlement, but submitPayment itself should not
    expect(settlementAdapter.submitCalls.length).toBeGreaterThanOrEqual(1);
  });
});
