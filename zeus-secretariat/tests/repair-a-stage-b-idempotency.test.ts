import type {
  DurableEvidenceStore,
  DurablePaymentIntent,
  EvidenceRecord,
  ExecuteRequest,
  Operation,
  PaymentAdapter,
  PaymentAuthorization,
  PaymentPolicy,
  PaymentSigner,
  PaymentSubmissionResult,
  PaymentRequirement,
  SettlementObservation,
  SigningContext,
} from "../src/core/types";
import { Secretariat } from "../src/core/state-machine";
import type { PaymentPayload, SettlementAdapter } from "../src/adapters/x402-facilitator-client";

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

class RepairAStore implements DurableEvidenceStore {
  private readonly intents = new Map<string, DurablePaymentIntent>();
  private readonly operations = new Map<string, Operation>();
  private readonly evidence = new Map<string, EvidenceRecord[]>();
  createPaymentIntentCalls = 0;
  updateAuthorizationCalls = 0;
  updateStatusCalls = 0;
  markNonceSignedCalls = 0;

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    this.createPaymentIntentCalls++;
    if ([...this.intents.values()].some(existing => existing.operationId === intent.operationId)) {
      throw new Error("DUPLICATE_OPERATION_ID");
    }
    this.intents.set(intent.paymentIntentId, { ...intent });
  }

  async getPaymentIntentByOperationId(operationId: string): Promise<DurablePaymentIntent | null> {
    for (const intent of this.intents.values()) {
      if (intent.operationId === operationId) return { ...intent };
    }
    return null;
  }

  async updatePaymentIntentAuthorization(
    paymentIntentId: string,
    fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">,
  ): Promise<void> {
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error("INTENT_NOT_FOUND");
    this.intents.set(paymentIntentId, { ...intent, ...fields, updatedAt: Date.now() });
    this.updateAuthorizationCalls++;
  }

  async updatePaymentIntentStatus(
    paymentIntentId: string,
    settlementState: DurablePaymentIntent["settlementState"],
  ): Promise<void> {
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error("INTENT_NOT_FOUND");
    this.intents.set(paymentIntentId, { ...intent, settlementState, updatedAt: Date.now() });
    this.updateStatusCalls++;
  }

  async markNonceSigned(): Promise<void> {
    this.markNonceSignedCalls++;
  }

  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }

  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async getOperationByRequestId(requestId: string): Promise<Operation | null> {
    for (const operation of this.operations.values()) {
      if (operation.requestId === requestId) return { ...operation };
    }
    return null;
  }

  async getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null> {
    for (const operation of this.operations.values()) {
      if (operation.clientId === clientId && operation.requestId === requestId) return { ...operation };
    }
    return null;
  }

  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, { ...operation });
  }

  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return this.evidence.get(operationId) ?? [];
  }

  async getOperationsByStatus(): Promise<Operation[]> {
    return [];
  }
  async getNonTerminalIntents(): Promise<DurablePaymentIntent[]> {
    return [];
  }
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<unknown> { return null; }
  async appendReconciliationObservation(): Promise<void> {}
  async getReconciliationObservations(): Promise<unknown[]> { return []; }
  async saveSettledEvidenceBundle(): Promise<void> {}
  async saveNotSettledEvidenceBundle(): Promise<void> {}
}

class RepairASettlementAdapter implements SettlementAdapter {
  submitCalls: Array<{ intent: DurablePaymentIntent; payload: PaymentPayload }> = [];

  async submit(intent: DurablePaymentIntent, payload: PaymentPayload) {
    this.submitCalls.push({ intent, payload });
    return { status: "SUBMITTED" as const, txHash: "0xtxhash", rawResponse: {} };
  }
}

class RepairALegacyAdapter implements PaymentAdapter {
  readonly network = "base-sepolia";
  createAuthorizationCalls = 0;

  async createAuthorization(
    _requirement: PaymentRequirement,
    _signer: PaymentSigner,
    _context: SigningContext,
  ): Promise<PaymentAuthorization> {
    this.createAuthorizationCalls++;
    throw new Error("Stage B must not use legacy authorization");
  }

  async submit(): Promise<PaymentSubmissionResult> {
    throw new Error("Stage B must not use legacy submission");
  }

  async observeSettlement(): Promise<SettlementObservation> {
    throw new Error("Stage B must not use legacy reconciliation");
  }
}

const signer: PaymentSigner = {
  signerType: "TEST",
  async getAddress() { return "0xTestPayer"; },
  async signPayment() { throw new Error("Stage A must not sign"); },
};

function makeRequest(requestId: string): ExecuteRequest {
  return {
    target: "https://seller.example.com/api",
    method: "GET",
    policy: {
      maxPrice: "1000000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: ["0xUSDC"],
      authorizationMode: "policy-bound",
    } satisfies PaymentPolicy,
    requestId,
    clientId: "client-repair-a",
    authorizer: "0xTestPayer",
  };
}

function makeSignedPayload(intent: DurablePaymentIntent, signature = "0xexternal-signature"): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: intent.network,
      amount: intent.value,
      asset: intent.asset,
      payTo: intent.payTo,
      maxTimeoutSeconds: intent.validBefore - intent.validAfter,
    },
    payload: {
      signature,
      authorization: {
        from: intent.authorizer,
        to: intent.payTo,
        value: intent.value,
        validAfter: String(intent.validAfter),
        validBefore: String(intent.validBefore),
        nonce: intent.nonce,
      },
    },
  };
}

describe("Repair A: idempotent Stage B retry", () => {
  let store: RepairAStore;
  let settlementAdapter: RepairASettlementAdapter;
  let legacyAdapter: RepairALegacyAdapter;
  let secretariat: Secretariat;

  beforeEach(() => {
    store = new RepairAStore();
    settlementAdapter = new RepairASettlementAdapter();
    legacyAdapter = new RepairALegacyAdapter();
    secretariat = new Secretariat({
      evidenceStore: store,
      signer,
      adapters: new Map([["base-sepolia", legacyAdapter]]),
      settlementAdapter,
    });
  });

  beforeEach(() => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(MOCK_X402_CHALLENGE), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
    (globalThis as typeof globalThis & { __repairAOriginalFetch?: typeof fetch }).__repairAOriginalFetch = originalFetch;
  });

  afterEach(() => {
    const state = globalThis as typeof globalThis & { __repairAOriginalFetch?: typeof fetch };
    if (state.__repairAOriginalFetch) globalThis.fetch = state.__repairAOriginalFetch;
    delete state.__repairAOriginalFetch;
  });

  async function createStageARequest(requestId: string) {
    const created = await secretariat.createRequest(makeRequest(requestId));
    expect(created.status).toBe("AWAITING_PAYMENT_SIGNATURE");
    if (created.status !== "AWAITING_PAYMENT_SIGNATURE") {
      throw new Error("Stage A did not await a signature");
    }
    const intent = await store.getPaymentIntentByOperationId(created.operationId);
    expect(intent).not.toBeNull();
    return { created, intent: intent! };
  }

  test("accepts the first signed Stage B payload using the persisted DPI and nonce", async () => {
    const { created, intent } = await createStageARequest("req-repair-a-first");
    const payload = makeSignedPayload(intent);

    const result = await secretariat.submitSignedPayment(created.requestId, payload);

    expect(result.operationId).toBe(created.operationId);
    expect(settlementAdapter.submitCalls).toHaveLength(1);
    expect(settlementAdapter.submitCalls[0].intent.paymentIntentId).toBe(intent.paymentIntentId);
    expect(settlementAdapter.submitCalls[0].intent.nonce).toBe(intent.nonce);
    expect(store.createPaymentIntentCalls).toBe(1);
    expect(store.updateAuthorizationCalls).toBe(1);
    expect(store.markNonceSignedCalls).toBe(1);
    expect(legacyAdapter.createAuthorizationCalls).toBe(0);
  });

  test("returns the existing result for an identical retry without authorization, submission, DPI, or nonce changes", async () => {
    const { created, intent } = await createStageARequest("req-repair-a-identical");
    const payload = makeSignedPayload(intent);
    const firstResult = await secretariat.submitSignedPayment(created.requestId, payload);
    const beforeRetryIntent = await store.getPaymentIntentByOperationId(created.operationId);
    const beforeRetryOperation = await store.getOperation(created.operationId);
    const counts = {
      submit: settlementAdapter.submitCalls.length,
      authorization: store.updateAuthorizationCalls,
      status: store.updateStatusCalls,
      nonce: store.markNonceSignedCalls,
      dpi: store.createPaymentIntentCalls,
    };

    const retryResult = await secretariat.submitSignedPayment(created.requestId, payload);

    expect(retryResult).toEqual(firstResult);
    expect(await store.getPaymentIntentByOperationId(created.operationId)).toEqual(beforeRetryIntent);
    expect(await store.getOperation(created.operationId)).toEqual(beforeRetryOperation);
    expect(settlementAdapter.submitCalls).toHaveLength(counts.submit);
    expect(store.updateAuthorizationCalls).toBe(counts.authorization);
    expect(store.updateStatusCalls).toBe(counts.status);
    expect(store.markNonceSignedCalls).toBe(counts.nonce);
    expect(store.createPaymentIntentCalls).toBe(counts.dpi);
  });

  test("rejects a changed signed payload without changing the existing economic state", async () => {
    const { created, intent } = await createStageARequest("req-repair-a-changed");
    const payload = makeSignedPayload(intent);
    await secretariat.submitSignedPayment(created.requestId, payload);
    const beforeRetryIntent = await store.getPaymentIntentByOperationId(created.operationId);
    const beforeRetryOperation = await store.getOperation(created.operationId);
    const submitCount = settlementAdapter.submitCalls.length;
    const authorizationCount = store.updateAuthorizationCalls;

    await expect(secretariat.submitSignedPayment(
      created.requestId,
      makeSignedPayload(intent, "0xchanged-signature"),
    )).rejects.toThrow("PAYMENT_PAYLOAD_RETRY_MISMATCH");

    expect(await store.getPaymentIntentByOperationId(created.operationId)).toEqual(beforeRetryIntent);
    expect(await store.getOperation(created.operationId)).toEqual(beforeRetryOperation);
    expect(settlementAdapter.submitCalls).toHaveLength(submitCount);
    expect(store.updateAuthorizationCalls).toBe(authorizationCount);
  });
});