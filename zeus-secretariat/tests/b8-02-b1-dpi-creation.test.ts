/**
 * BLOCK 8.2-B.1 — DurablePaymentIntent Creation & Persistence Tests
 *
 * Verifies:
 *   - DPI created after authorization
 *   - DPI persisted before any settlement submission
 *   - Authorization data preserved in DPI
 *   - Idempotent identity (no duplicate DPI)
 *   - Crash/restart recovery
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

// ---------------------------------------------------------------------------
// Mock fetch — returns valid 402 with x402 challenge body
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

function createMock402Response(): Response {
  return new Response(JSON.stringify(MOCK_X402_CHALLENGE), {
    status: 402,
    statusText: "Payment Required",
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValue(createMock402Response());
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// In-Memory Durable Store for testing
// ---------------------------------------------------------------------------

class TestDurableStore implements DurableEvidenceStore {
  private intents: Map<string, DurablePaymentIntent> = new Map();
  private operations: Map<string, Operation> = new Map();
  private evidence: Map<string, EvidenceRecord[]> = new Map();
  public createPaymentIntentCallCount = 0;
  public createPaymentIntentCallLog: DurablePaymentIntent[] = [];

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    this.createPaymentIntentCallCount++;
    this.createPaymentIntentCallLog.push({ ...intent });
    // Check duplicates by operationId
    for (const existing of this.intents.values()) {
      if (existing.operationId === intent.operationId) {
        throw new Error("DUPLICATE_OPERATION_ID");
      }
    }
    this.intents.set(intent.paymentIntentId, { ...intent });
  }

  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    for (const intent of this.intents.values()) {
      if (intent.operationId === opId) return { ...intent };
    }
    return null;
  }

  /** Simulate restart: return a NEW store instance with same persisted data */
  cloneForRestart(): TestDurableStore {
    const cloned = new TestDurableStore();
    for (const [k, v] of this.intents) cloned.intents.set(k, { ...v });
    for (const [k, v] of this.operations) cloned.operations.set(k, { ...v });
    for (const [k, v] of this.evidence) cloned.evidence.set(k, [...v]);
    return cloned;
  }

  async updatePaymentIntentStatus(): Promise<void> {}
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<any> { return null; }
  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }
  async getOperation(opId: string): Promise<Operation | null> {
    return this.operations.get(opId) ?? null;
  }
  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, { ...operation });
  }
  async getEvidence(opId: string): Promise<EvidenceRecord[]> {
    return this.evidence.get(opId) ?? [];
  }
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
// Mock PaymentAdapter
// ---------------------------------------------------------------------------

class TestPaymentAdapter implements PaymentAdapter {
  readonly network = "base-sepolia";
  public submitCalled = false;
  public submitCallOrder: string[] = [];

  async createAuthorization(
    requirement: PaymentRequirement,
    _signer: PaymentSigner,
    context: SigningContext,
  ): Promise<PaymentAuthorization> {
    return {
      signature: "0xtest-signature-" + context.operationId,
      scheme: "exact",
      timestamp: Date.now(),
      context,
    };
  }

  async submit(): Promise<PaymentSubmissionResult> {
    this.submitCalled = true;
    return { success: true, transactionHash: "0xtxhash" } as any;
  }

  async observeSettlement(): Promise<SettlementObservation> {
    return { settled: false, reason: "PENDING" } as any;
  }
}

// ---------------------------------------------------------------------------
// Mock Signer
// ---------------------------------------------------------------------------

const mockSigner: PaymentSigner = {
  signerType: "TEST",
  async getAddress() { return "0xTestPayer"; },
  async signPayment() {
    throw new Error("Not used in legacy path");
  },
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRequest(overrides?: Partial<ExecuteRequest>): ExecuteRequest {
  return {
    target: "https://seller.example.com/api",
    method: "GET",
    policy: {
      maxPrice: "1000000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: ["0xUSDC"],
      authorizationMode: "policy-bound",
    } as PaymentPolicy,
    requestId: "req-default",
    clientId: "client-default",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BLOCK 8.2-B.1: DurablePaymentIntent Creation & Persistence", () => {
  let store: TestDurableStore;
  let adapter: TestPaymentAdapter;
  let secretariat: Secretariat;

  beforeEach(() => {
    store = new TestDurableStore();
    adapter = new TestPaymentAdapter();
    const adapters = new Map<string, PaymentAdapter>();
    adapters.set("base-sepolia", adapter);
    secretariat = new Secretariat({
      evidenceStore: store,
      signer: mockSigner,
      adapters,
    });
  });

  test("B1.1: DPI created after authorization", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b1-1" })); } catch {}
    expect(store.createPaymentIntentCallCount).toBeGreaterThanOrEqual(1);
  });

  test("B1.2: Authorization data persisted in DPI", async () => {
    try { await secretariat.execute(makeRequest({ requestId: "req-b1-2" })); } catch {}

    const dpi = store.createPaymentIntentCallLog[0];
    expect(dpi).toBeDefined();
    expect(dpi.network).toBe("base-sepolia");
    expect(dpi.asset).toBe("0xUSDC");
    expect(dpi.settlementState).toBe("AUTHORIZED");
    expect(dpi.requestId).toBe("req-b1-2");
    expect(dpi.clientId).toBe("client-default");
    expect(dpi.payTo).toBe("0xSellerAddress");
    expect(dpi.value).toBe("1000000");
  });

  test("B1.3: Persistence happens before submission", async () => {
    const callOrder: string[] = [];

    const origCreate = store.createPaymentIntent.bind(store);
    store.createPaymentIntent = async (intent: DurablePaymentIntent) => {
      callOrder.push("createPaymentIntent");
      return origCreate(intent);
    };

    const origSubmit = adapter.submit.bind(adapter);
    adapter.submit = async (...args: any[]) => {
      callOrder.push("submit");
      return origSubmit(...args);
    };

    try { await secretariat.execute(makeRequest({ requestId: "req-b1-3" })); } catch {}

    const createIdx = callOrder.indexOf("createPaymentIntent");
    const submitIdx = callOrder.indexOf("submit");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    if (submitIdx >= 0) {
      expect(createIdx).toBeLessThan(submitIdx);
    }
  });

  test("B1.4: Restart recovery — DPI survives runtime destruction", async () => {
    // Runtime A: execute and persist DPI
    try { await secretariat.execute(makeRequest({ requestId: "req-b1-4", clientId: "client-restart" })); } catch {}

    // Verify DPI exists in Runtime A store
    expect(store.createPaymentIntentCallCount).toBeGreaterThanOrEqual(1);

    // Simulate restart: create NEW store with same persisted data
    const restartedStore = store.cloneForRestart();

    // Create NEW Secretariat instance (Runtime B)
    const adapters2 = new Map<string, PaymentAdapter>();
    adapters2.set("base-sepolia", new TestPaymentAdapter());
    const secretariat2 = new Secretariat({
      evidenceStore: restartedStore,
      signer: mockSigner,
      adapters: adapters2,
    });

    // Find the operation from Runtime A
    let foundOpId: string | null = null;
    for (const op of restartedStore["operations"].values()) {
      if (op.requestId === "req-b1-4") {
        foundOpId = op.operationId;
        break;
      }
    }
    expect(foundOpId).not.toBeNull();

    // Recover DPI from restarted store using operationId
    const recoveredDpi = await restartedStore.getPaymentIntentByOperationId(foundOpId!);
    expect(recoveredDpi).not.toBeNull();
    expect(recoveredDpi!.requestId).toBe("req-b1-4");
    expect(recoveredDpi!.clientId).toBe("client-restart");
    expect(recoveredDpi!.settlementState).toBe("AUTHORIZED");
    expect(recoveredDpi!.network).toBe("base-sepolia");
    expect(recoveredDpi!.asset).toBe("0xUSDC");
    expect(recoveredDpi!.payTo).toBe("0xSellerAddress");
    expect(recoveredDpi!.value).toBe("1000000");
  });

  test("B1.5: Idempotent identity — no duplicate DPI for same request", async () => {
    const req = makeRequest({ requestId: "req-idempotent", clientId: "client-idempotent" });

    // First execution
    try { await secretariat.execute(req); } catch {}
    const firstCallCount = store.createPaymentIntentCallCount;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    // Second execution with same identity — 8.1-A idempotency returns existing operation
    try { await secretariat.execute(req); } catch {}

    // createPaymentIntent should NOT have been called again
    expect(store.createPaymentIntentCallCount).toBe(firstCallCount);
  });
});
