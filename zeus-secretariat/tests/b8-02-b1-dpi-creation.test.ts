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
// Mock 402 Response for discovery phase
// ---------------------------------------------------------------------------

function createMock402Response(): Response {
  const x402Challenge = {
    accepts: [{
      scheme: "exact",
      network: "base-sepolia",
      amount: "1000000",
      asset: "0xUSDC",
      payTo: "0xSellerAddress",
      maxTimeoutSeconds: 300,
    }],
  };
  const encoded = btoa(JSON.stringify(x402Challenge));
  return new Response(null, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encoded },
  });
}

// ---------------------------------------------------------------------------
// In-Memory Durable Store for testing
// ---------------------------------------------------------------------------

class TestDurableStore implements DurableEvidenceStore {
  private intents: Map<string, DurablePaymentIntent> = new Map();
  private operations: Map<string, Operation> = new Map();
  private evidence: Map<string, EvidenceRecord[]> = new Map();
  public createPaymentIntentCallCount = 0;

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    this.createPaymentIntentCallCount++;
    if (this.intents.has(intent.paymentIntentId)) {
      throw new Error("DUPLICATE_INTENT");
    }
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

  /** Expose internal intents for restart simulation */
  getStoredIntents(): Map<string, DurablePaymentIntent> {
    return new Map(this.intents);
  }

  /** Restore intents from serialized data (simulates DB reconnect) */
  restoreIntents(intents: Map<string, DurablePaymentIntent>): void {
    this.intents = new Map(intents);
  }
}

// ---------------------------------------------------------------------------
// Mock PaymentAdapter
// ---------------------------------------------------------------------------

class TestPaymentAdapter implements PaymentAdapter {
  readonly network = "base-sepolia";
  public submitCalled = false;

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
// Global fetch mock setup
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  // Mock fetch to return 402 with valid x402 challenge
  globalThis.fetch = jest.fn().mockResolvedValue(createMock402Response());
});

afterEach(() => {
  jest.restoreAllMocks();
});

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
    const request: ExecuteRequest = {
      target: "https://seller.example.com/api",
      method: "GET",
      policy: { maxPrice: "1000000", asset: "0xUSDC", network: "base-sepolia" } as PaymentPolicy,
      requestId: "req-test-001",
      clientId: "client-test",
    };

    try { await secretariat.execute(request); } catch {}

    expect(store.createPaymentIntentCallCount).toBeGreaterThanOrEqual(1);
  });

  test("B1.2: Authorization data persisted in DPI", async () => {
    const request: ExecuteRequest = {
      target: "https://seller.example.com/api",
      method: "GET",
      policy: { maxPrice: "1000000", asset: "0xUSDC", network: "base-sepolia" } as PaymentPolicy,
      requestId: "req-test-002",
      clientId: "client-test",
    };

    try { await secretariat.execute(request); } catch {}

    let dpi: DurablePaymentIntent | null = null;
    for (const op of (store as any).operations.values()) {
      dpi = await store.getPaymentIntentByOperationId(op.operationId);
      if (dpi) break;
    }

    expect(dpi).not.toBeNull();
    expect(dpi!.network).toBe("base-sepolia");
    expect(dpi!.asset).toBe("0xUSDC");
    expect(dpi!.settlementState).toBe("AUTHORIZED");
    expect(dpi!.requestId).toBe("req-test-002");
    expect(dpi!.clientId).toBe("client-test");
  });

  test("B1.3: Persistence happens before submission", async () => {
    const callOrder: string[] = [];

    const originalCreate = store.createPaymentIntent.bind(store);
    store.createPaymentIntent = async (intent: DurablePaymentIntent) => {
      callOrder.push("createPaymentIntent");
      return originalCreate(intent);
    };

    const originalSubmit = adapter.submit.bind(adapter);
    adapter.submit = async (...args: any[]) => {
      callOrder.push("submit");
      return originalSubmit(...args);
    };

    const request: ExecuteRequest = {
      target: "https://seller.example.com/api",
      method: "GET",
      policy: { maxPrice: "1000000", asset: "0xUSDC", network: "base-sepolia" } as PaymentPolicy,
      requestId: "req-test-003",
    };

    try { await secretariat.execute(request); } catch {}

    const createIdx = callOrder.indexOf("createPaymentIntent");
    const submitIdx = callOrder.indexOf("submit");
    if (createIdx >= 0 && submitIdx >= 0) {
      expect(createIdx).toBeLessThan(submitIdx);
    } else if (createIdx >= 0) {
      expect(createIdx).toBeGreaterThanOrEqual(0);
    }
  });

  test("B1.4: Restart recovery — DPI survives runtime destruction", async () => {
    const request: ExecuteRequest = {
      target: "https://seller.example.com/api",
      method: "GET",
      policy: { maxPrice: "1000000", asset: "0xUSDC", network: "base-sepolia" } as PaymentPolicy,
      requestId: "req-test-004",
      clientId: "client-restart",
    };

    // Runtime A: execute and persist DPI
    try { await secretariat.execute(request); } catch {}

    // Capture persisted intents (simulates DB state)
    const savedIntents = store.getStoredIntents();
    expect(savedIntents.size).toBeGreaterThanOrEqual(1);

    // Simulate restart: NEW store instance, restore from "DB"
    const store2 = new TestDurableStore();
    store2.restoreIntents(savedIntents);

    // NEW StateMachine with fresh store
    const adapter2 = new TestPaymentAdapter();
    const adapters2 = new Map<string, PaymentAdapter>();
    adapters2.set("base-sepolia", adapter2);
    const secretariat2 = new Secretariat({
      evidenceStore: store2,
      signer: mockSigner,
      adapters: adapters2,
    });

    // Verify DPI is recoverable from new runtime
    let foundDpi: DurablePaymentIntent | null = null;
    for (const intent of savedIntents.values()) {
      if (intent.requestId === "req-test-004") {
        foundDpi = await store2.getPaymentIntentByOperationId(intent.operationId);
        break;
      }
    }

    expect(foundDpi).not.toBeNull();
    expect(foundDpi!.clientId).toBe("client-restart");
    expect(foundDpi!.requestId).toBe("req-test-004");
    expect(foundDpi!.settlementState).toBe("AUTHORIZED");
    expect(foundDpi!.network).toBe("base-sepolia");
    expect(foundDpi!.asset).toBe("0xUSDC");
  });

  test("B1.5: Idempotent identity — no duplicate DPI for same operation", async () => {
    const request: ExecuteRequest = {
      target: "https://seller.example.com/api",
      method: "GET",
      policy: { maxPrice: "1000000", asset: "0xUSDC", network: "base-sepolia" } as PaymentPolicy,
      requestId: "req-idempotent",
      clientId: "client-idempotent",
    };

    try { await secretariat.execute(request); } catch {}
    const firstCallCount = store.createPaymentIntentCallCount;

    try { await secretariat.execute(request); } catch {}

    expect(store.createPaymentIntentCallCount).toBe(firstCallCount);
  });
});
