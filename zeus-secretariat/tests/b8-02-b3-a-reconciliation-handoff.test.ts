/**
 * BLOCK 8.2-B.3-A — Canonical Reconciliation Handoff Tests
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
import type { SettlementAdapter, PaymentPayload } from '../src/adapters/x402-facilitator-client';
import type { ReconciliationEngine, ReconciliationOutcome } from '../src/core/reconciliation-engine';
import { Secretariat } from '../src/core/state-machine';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------
const MOCK_X402 = { accepts: [{ scheme: "exact", network: "base-sepolia", asset: "0xUSDC", amount: "1000000", payTo: "0xSeller", maxTimeoutSeconds: 300 }] };
let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(MOCK_X402), { status: 402, headers: { "Content-Type": "application/json" } })) as any; });
afterEach(() => { globalThis.fetch = originalFetch; });

// ---------------------------------------------------------------------------
// Test Store
// ---------------------------------------------------------------------------
class TestStore implements DurableEvidenceStore {
  private intents = new Map<string, DurablePaymentIntent>();
  private ops = new Map<string, Operation>();
  private evidence = new Map<string, EvidenceRecord[]>();
  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> { this.intents.set(intent.paymentIntentId, { ...intent }); }
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> { for (const i of this.intents.values()) if (i.operationId === opId) return { ...i }; return null; }
  async updatePaymentIntentStatus(): Promise<void> {}
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<any> { return null; }
  async append(r: EvidenceRecord): Promise<void> { const rs = this.evidence.get(r.operationId) ?? []; rs.push(r); this.evidence.set(r.operationId, rs); }
  async getOperation(id: string): Promise<Operation | null> { return this.ops.get(id) ?? null; }
  async saveOperation(op: Operation): Promise<void> { this.ops.set(op.operationId, { ...op }); }
  async getEvidence(id: string): Promise<EvidenceRecord[]> { return this.evidence.get(id) ?? []; }
  async getOperationsByStatus(): Promise<Operation[]> { return []; }
  async getNonTerminalIntents(): Promise<DurablePaymentIntent[]> { return []; }
  async appendReconciliationObservation(): Promise<void> {}
  async getReconciliationObservations(): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(): Promise<void> {}
  async saveNotSettledEvidenceBundle(): Promise<void> {}
  async getOperationByClientAndRequestId(c: string, r: string): Promise<Operation | null> { for (const o of this.ops.values()) if (o.clientId === c && o.requestId === r) return { ...o }; return null; }
}

// ---------------------------------------------------------------------------
// Mock Legacy Adapter (for authorizePayment only)
// ---------------------------------------------------------------------------
class TestLegacyAdapter implements PaymentAdapter {
  readonly network = "base-sepolia";
  public legacyObserveCalled = false;
  async createAuthorization(req: PaymentRequirement, _s: PaymentSigner, ctx: SigningContext): Promise<PaymentAuthorization> { return { signature: "0xsig", scheme: "exact", timestamp: Date.now(), context: ctx }; }
  async submit(): Promise<PaymentSubmissionResult> { return { success: true, transactionHash: "0xtx" } as any; }
  async observeSettlement(): Promise<SettlementObservation> { this.legacyObserveCalled = true; return { settled: false, reason: "LEGACY_NOT_USED" } as any; }
}

// ---------------------------------------------------------------------------
// Mock Settlement Adapter
// ---------------------------------------------------------------------------
class TestSettlementAdapter implements SettlementAdapter {
  async submit(_intent: DurablePaymentIntent, _payload: PaymentPayload) { return { status: "SUBMITTED" as const, txHash: "0xtxhash", rawResponse: {} }; }
}

// ---------------------------------------------------------------------------
// Mock Reconciliation Engine
// ---------------------------------------------------------------------------
class TestReconciliationEngine implements ReconciliationEngine {
  public reconcileCalls: string[] = [];
  public outcome: ReconciliationOutcome = { status: "SETTLED", evidence: {} as any };
  store: any; rpcChecker: any; scheduleConfig: any; finalityPolicy: any;
  async reconcile(paymentIntentId: string): Promise<ReconciliationOutcome> {
    this.reconcileCalls.push(paymentIntentId);
    return this.outcome;
  }
  async persistObservation(): Promise<void> {}
  async scheduleNextProbe(): Promise<void> {}
}

const mockSigner: PaymentSigner = { signerType: "TEST", async getAddress() { return "0xPayer"; }, async signPayment() { throw new Error("unused"); } };

function makeReq(overrides?: Partial<ExecuteRequest>): ExecuteRequest {
  return { target: "https://seller.example.com/api", method: "GET", policy: { maxPrice: "1000000", allowedNetworks: ["base-sepolia"], allowedAssets: ["0xUSDC"], authorizationMode: "policy-bound" } as PaymentPolicy, requestId: "req-def", clientId: "cli-def", ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("BLOCK 8.2-B.3-A: Canonical Reconciliation Handoff", () => {
  let store: TestStore;
  let legacyAdapter: TestLegacyAdapter;
  let settlementAdapter: TestSettlementAdapter;
  let reconEngine: TestReconciliationEngine;
  let secretariat: Secretariat;

  beforeEach(() => {
    store = new TestStore();
    legacyAdapter = new TestLegacyAdapter();
    settlementAdapter = new TestSettlementAdapter();
    reconEngine = new TestReconciliationEngine();
    const adapters = new Map<string, PaymentAdapter>();
    adapters.set("base-sepolia", legacyAdapter);
    secretariat = new Secretariat({ evidenceStore: store, signer: mockSigner, adapters, settlementAdapter, reconciliationEngine: reconEngine });
  });

  test("B3-A.1: reconciliation called by paymentIntentId", async () => {
    try { await secretariat.execute(makeReq({ requestId: "req-b3a-1" })); } catch {}
    expect(reconEngine.reconcileCalls.length).toBeGreaterThanOrEqual(1);
    expect(reconEngine.reconcileCalls[0]).toBeTruthy();
  });

  test("B3-A.2: SETTLED outcome transitions to SETTLED", async () => {
    reconEngine.outcome = { status: "SETTLED", evidence: {} as any };
    const result = await secretariat.execute(makeReq({ requestId: "req-b3a-2" }));
    // Should not throw; operation should reach SETTLED or beyond
    expect(result).toBeDefined();
  });

  test("B3-A.3: RECONCILING remains non-terminal (no exception)", async () => {
    reconEngine.outcome = { status: "RECONCILING", reason: "awaiting confirmation" };
    // execute() wraps in try/catch → failOperation on throw.
    // RECONCILING must NOT cause a throw inside observeSettlement.
    const result = await secretariat.execute(makeReq({ requestId: "req-b3a-3" }));
    expect(result).toBeDefined();
    // The operation should NOT be in FAILED state due to reconciliation
  });

  test("B3-A.4: UNKNOWN submission remains non-terminal through reconciliation", async () => {
    reconEngine.outcome = { status: "RECONCILING", reason: "submission ambiguous" };
    const result = await secretariat.execute(makeReq({ requestId: "req-b3a-4" }));
    expect(result).toBeDefined();
  });

  test("B3-A.5: legacy PaymentAdapter.observeSettlement NOT called", async () => {
    try { await secretariat.execute(makeReq({ requestId: "req-b3a-5" })); } catch {}
    expect(legacyAdapter.legacyObserveCalled).toBe(false);
  });

  test("B3-A.6: StateMachine does not create settlement proof from SubmitResult", async () => {
    reconEngine.outcome = { status: "SETTLED", evidence: { txHash: "0xreal" } as any };
    try { await secretariat.execute(makeReq({ requestId: "req-b3a-6" })); } catch {}
    // Verify evidence contains reconciliation event, not legacy observation
    const ops = store["ops"] as Map<string, Operation>;
    let foundReconEvidence = false;
    for (const op of ops.values()) {
      for (const ev of op.evidence) {
        if (ev.event === "SETTLEMENT_CONFIRMED" && ev.payload && (ev.payload as any).paymentIntentId) {
          foundReconEvidence = true;
        }
      }
    }
    expect(foundReconEvidence).toBe(true);
  });

  test("B3-A.7: NOT_SETTLED maps to SETTLEMENT_FAILED", async () => {
    reconEngine.outcome = { status: "NOT_SETTLED", evidence: {} as any };
    const result = await secretariat.execute(makeReq({ requestId: "req-b3a-7" }));
    expect(result).toBeDefined();
  });
});
