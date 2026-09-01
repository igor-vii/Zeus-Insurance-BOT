/**
 * BLOCK 8.2-B.3-B1 — Identity Handoff Regression Tests
 *
 * Proves that paymentIntentId and operationId are correctly separated
 * at the settlement → execution handoff boundary.
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
// Test Store with identity tracking
// ---------------------------------------------------------------------------
class IdentityTestStore implements DurableEvidenceStore {
  private intents = new Map<string, DurablePaymentIntent>();
  private ops = new Map<string, Operation>();
  private evidence = new Map<string, EvidenceRecord[]>();
  public settleAndCreateCalls: Array<{ paymentIntentId: string; operationId: string }> = [];

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    for (const i of this.intents.values()) if (i.operationId === opId) return { ...i }; return null;
  }
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

  // Atomic handoff mock — tracks which IDs were passed
  async settleAndCreateExecutionObligation(
    paymentIntentId: string,
    operationId: string,
    _evidence: unknown,
    _job: unknown,
    _attempt: unknown,
  ): Promise<boolean> {
    this.settleAndCreateCalls.push({ paymentIntentId, operationId });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------
class TestLegacyAdapter implements PaymentAdapter {
  readonly network = "base-sepolia";
  async createAuthorization(req: PaymentRequirement, _s: PaymentSigner, ctx: SigningContext): Promise<PaymentAuthorization> { return { signature: "0xsig", scheme: "exact", timestamp: Date.now(), context: ctx }; }
  async submit(): Promise<PaymentSubmissionResult> { return { success: true, transactionHash: "0xtx" } as any; }
  async observeSettlement(): Promise<SettlementObservation> { return { settled: false, reason: "LEGACY" } as any; }
}

class TestSettlementAdapter implements SettlementAdapter {
  async submit(_intent: DurablePaymentIntent, _payload: PaymentPayload) { return { status: "SUBMITTED" as const, txHash: "0xtxhash", rawResponse: {} }; }
}

class TestReconEngine implements ReconciliationEngine {
  store: any; rpcChecker: any; scheduleConfig: any; finalityPolicy: any;
  async reconcile(_id: string): Promise<ReconciliationOutcome> { return { status: "SETTLED", evidence: {} as any }; }
  async persistObservation(): Promise<void> {}
  async scheduleNextProbe(): Promise<void> {}
}

const mockSigner: PaymentSigner = { signerType: "TEST", async getAddress() { return "0xPayer"; }, async signPayment() { throw new Error("unused"); } };

function makeReq(overrides?: Partial<ExecuteRequest>): ExecuteRequest {
  return { target: "https://seller.example.com/api", method: "GET", policy: { maxPrice: "1000000", allowedNetworks: ["base-sepolia"], allowedAssets: ["0xUSDC"], authorizationMode: "policy-bound" } as PaymentPolicy, requestId: "req-id", clientId: "cli-id", ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("BLOCK 8.2-B.3-B1: Identity Handoff Correctness", () => {
  let store: IdentityTestStore;
  let secretariat: Secretariat;

  beforeEach(() => {
    store = new IdentityTestStore();
    const adapters = new Map<string, PaymentAdapter>();
    adapters.set("base-sepolia", new TestLegacyAdapter());
    secretariat = new Secretariat({
      evidenceStore: store,
      signer: mockSigner,
      adapters,
      settlementAdapter: new TestSettlementAdapter(),
      reconciliationEngine: new TestReconEngine(),
    });
  });

  test("B3-B1.1: settleAndCreateExecutionObligation receives DISTINCT paymentIntentId and operationId", async () => {
    try { await secretariat.execute(makeReq({ requestId: "req-identity-1" })); } catch {}

    expect(store.settleAndCreateCalls.length).toBeGreaterThanOrEqual(1);
    const call = store.settleAndCreateCalls[0];

    // CRITICAL: paymentIntentId must NOT equal operationId
    // paymentIntentId starts with "pi_", operationId starts with "op_"
    expect(call.paymentIntentId).not.toBe(call.operationId);
    expect(call.paymentIntentId).toMatch(/^pi_/);
    expect(call.operationId).toMatch(/^op_/);
  });

  test("B3-B1.2: execution entities use operationId, not paymentIntentId", async () => {
    try { await secretariat.execute(makeReq({ requestId: "req-identity-2" })); } catch {}

    const call = store.settleAndCreateCalls[0];
    expect(call).toBeDefined();

    // Verify operationId is a valid op_ identifier
    expect(call.operationId).toMatch(/^op_/);

    // Verify paymentIntentId matches what was persisted in DPI
    const dpi = await store.getPaymentIntentByOperationId(call.operationId);
    expect(dpi).not.toBeNull();
    expect(call.paymentIntentId).toBe(dpi!.paymentIntentId);
  });

  test("B3-B1.3: evidence records contain both identities", async () => {
    try { await secretariat.execute(makeReq({ requestId: "req-identity-3" })); } catch {}

    // Find DURABLE_EXECUTION_OBLIGATION_CREATED evidence
    let foundEvidence = false;
    for (const op of store["ops"].values()) {
      for (const ev of op.evidence) {
        if (ev.event === "DURABLE_EXECUTION_OBLIGATION_CREATED") {
          const payload = ev.payload as Record<string, unknown>;
          expect(payload.paymentIntentId).toBeDefined();
          expect(payload.executionId).toBeDefined();
          expect(payload.paymentIntentId).not.toBe(payload.executionId);
          foundEvidence = true;
        }
      }
    }
    expect(foundEvidence).toBe(true);
  });
});
