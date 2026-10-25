/**
 * F-112 (external audit 2026-10-26) — canonical x402 v2 facilitator wire,
 * honest protocol verdicts, and fencing-safe durable transitions.
 *
 * Verdicts under test (real X402FacilitatorClient + fetch stub):
 *   C-1  /settle body = { x402Version, paymentPayload, paymentRequirements }
 *        (the legacy {paymentHeader, resource, network} envelope is gone)
 *   H-5  200 + success:false  → REJECTED (protocol refusal, not a settlement)
 *   H-6  4xx (≠408/409/429)   → REJECTED (definitive);
 *        409/408/429/5xx      → UNKNOWN → durable RECONCILING
 *   H-7  CAS loss during RECONCILING transition must NOT blind-overwrite
 *        the durable state (fencing preserved)
 *   H-8  bookkeeping failure AFTER a 2xx settle must stay SUBMITTED —
 *        never blurred into NETWORK_ERROR
 */

import type {
  DurablePaymentIntent,
  DurableEvidenceStore,
} from "../src/core/types";
import {
  X402FacilitatorClient,
  buildFacilitatorRequest,
  type PaymentPayload,
  type SubmitResult,
} from "../src/adapters/x402-facilitator-client";

// ---------------------------------------------------------------------------
// Minimal durable store — records every transition so tests can assert the
// durable story, including CAS losses.
// ---------------------------------------------------------------------------

class RecordingStore implements DurableEvidenceStore {
  readonly intents = new Map<string, DurablePaymentIntent>();
  readonly casCalls: Array<{ from: string; to: string }> = [];
  readonly statusWrites: Array<{ to: string }> = [];
  recordedSubmissions: Array<{ state: string; txHash?: string }> = [];
  nonceSubmitted: string[] = [];
  /** When true, compareAndSetState throws (simulates losing a concurrent race). */
  failCas = false;

  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    for (const i of this.intents.values()) if (i.operationId === opId) return { ...i };
    return null;
  }
  async transitionToSubmitting(paymentIntentId: string): Promise<boolean> {
    const i = this.intents.get(paymentIntentId);
    if (!i || i.settlementState !== "AUTHORIZED") return false;
    i.settlementState = "SUBMITTING";
    return true;
  }
  async compareAndSetState(
    _intentId: string,
    expectedState: string,
    newState: string,
    _extra?: Partial<DurablePaymentIntent>,
  ): Promise<boolean> {
    if (this.failCas) throw new Error("CAS_LOST");
    this.casCalls.push({ from: expectedState, to: newState });
    const i = this.intents.get(_intentId);
    if (i && i.settlementState === expectedState) i.settlementState = newState;
    return true;
  }
  async updatePaymentIntentStatus(
    _intentId: string,
    status: string,
    _extra?: Record<string, unknown>,
  ): Promise<void> {
    this.statusWrites.push({ to: status });
  }
  async recordSubmissionResult(
    paymentIntentId: string,
    newState: string,
    txHash?: string,
  ): Promise<boolean> {
    if (this.failBookkeeping) throw new Error("BOOKKEEPING_DOWN");
    this.recordedSubmissions.push({ state: newState, txHash });
    const i = this.intents.get(paymentIntentId);
    if (i) i.settlementState = newState;
    return true;
  }
  failBookkeeping = false;
  async markNonceSubmitted(nonce: string): Promise<void> { this.nonceSubmitted.push(nonce); }

  // Unused interface surface (never touched by the facilitator client).
  async append(): Promise<void> {}
  async getOperation(): Promise<null> { return null; }
  async saveOperation(): Promise<void> {}
  async getEvidence(): Promise<[]> { return []; }
  async getOperationsByStatus(): Promise<[]> { return []; }
  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getOperationByClientAndRequestId(): Promise<null> { return null; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYLOAD: PaymentPayload = {
  x402Version: 2,
  resource: { url: "https://seller.example/resource" },
  accepted: {
    scheme: "exact",
    network: "eip155:196",
    amount: "10000",
    asset: "0x74b7f16337b8972027f6196a17a631ac6de26d22",
    payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  },
  payload: {
    signature: "0xsig",
    authorization: {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xcccccccccccccccccccccccccccccccccccccccc",
      value: "10000",
      validAfter: "1700000000",
      validBefore: "1700003600",
      nonce: "0x" + "1".repeat(64),
    },
  },
};

function makeIntent(): DurablePaymentIntent {
  return {
    paymentIntentId: "dpi-f112-" + Math.random().toString(36).slice(2, 8),
    operationId: "op-f112-" + Math.random().toString(36).slice(2, 8),
    requestId: "req-f112",
    clientId: "client-f112",
    authorizer: PAYLOAD.payload.authorization.from,
    payTo: PAYLOAD.accepted.payTo,
    value: PAYLOAD.accepted.amount,
    asset: PAYLOAD.accepted.asset,
    network: PAYLOAD.accepted.network,
    nonce: PAYLOAD.payload.authorization.nonce,
    validAfter: Number(PAYLOAD.payload.authorization.validAfter),
    validBefore: Number(PAYLOAD.payload.authorization.validBefore),
    settlementState: "AUTHORIZED",
  } as DurablePaymentIntent;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;
let lastBody: Record<string, unknown> = {};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastBody = {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (jest.fn(async (_url: string, init?: RequestInit) => {
    lastBody = JSON.parse(String(init?.body ?? "{}"));
    return jsonResponse(status, body);
  }) as unknown) as typeof fetch;
}

// ---------------------------------------------------------------------------
// C-1 — canonical v2 wire
// ---------------------------------------------------------------------------

describe("F-112/C-1: canonical x402 v2 /settle wire", () => {
  test("buildFacilitatorRequest carries x402Version + paymentPayload + paymentRequirements", () => {
    const req = buildFacilitatorRequest(PAYLOAD);
    expect(req.x402Version).toBe(2);
    expect(req.paymentPayload).toEqual(PAYLOAD);
    expect(req.paymentRequirements.payTo).toBe(PAYLOAD.accepted.payTo);
    expect(req.paymentRequirements.amount).toBe(PAYLOAD.accepted.amount);
    expect(req.paymentRequirements.asset).toBe(PAYLOAD.accepted.asset);
    expect(req.paymentRequirements.network).toBe(PAYLOAD.accepted.network);
    expect(req.paymentRequirements.resource?.url).toBe(PAYLOAD.resource?.url);
    expect(req.paymentRequirements.extra?.name).toBe("USD Coin");
    // legacy fields must be gone
    expect((req as any).paymentHeader).toBeUndefined();
    expect((req as any).resource).toBeUndefined();
  });

  test("submit() sends the canonical envelope on the wire", async () => {
    const store = new RecordingStore();
    const client = new X402FacilitatorClient({ baseUrl: "https://fac.example" }, store);
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    stubFetch(200, { success: true, transaction: "0x" + "ab".repeat(32) });
    const result = await client.submit(intent, PAYLOAD);

    expect(result.status).toBe("SUBMITTED");
    expect(lastBody.x402Version).toBe(2);
    expect((lastBody as any).paymentPayload.accepted.payTo).toBe(PAYLOAD.accepted.payTo);
    expect((lastBody as any).paymentRequirements.payTo).toBe(PAYLOAD.accepted.payTo);
    expect((lastBody as any).paymentHeader).toBeUndefined();
    // spec field is `transaction` — extracted as txHash
    expect((result as any).txHash).toBe("0x" + "ab".repeat(32));
  });
});

// ---------------------------------------------------------------------------
// H-5 — 200 + success:false is a refusal
// ---------------------------------------------------------------------------

describe("F-112/H-5: 200 success:false", () => {
  test("REJECTED with errorReason; durable RECONCILING; no SETTLEMENT_PENDING", async () => {
    const store = new RecordingStore();
    const client = new X402FacilitatorClient({ baseUrl: "https://fac.example" }, store);
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    stubFetch(200, { success: false, errorReason: "insufficient_funds" });
    const result = await client.submit(intent, PAYLOAD);

    expect(result.status).toBe("REJECTED");
    if (result.status === "REJECTED") {
      expect(result.reason).toBe("insufficient_funds");
    }
    expect(store.recordedSubmissions).toHaveLength(0);
    expect(store.casCalls).toEqual([{ from: "SUBMITTING", to: "RECONCILING" }]);
  });
});

// ---------------------------------------------------------------------------
// H-6 — status classification mirrors the protocol
// ---------------------------------------------------------------------------

describe("F-112/H-6: definitive 4xx vs transient/ambiguous", () => {
  test.each([400, 403, 422])("HTTP %i → REJECTED", async (status) => {
    const store = new RecordingStore();
    const client = new X402FacilitatorClient({ baseUrl: "https://fac.example" }, store);
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    stubFetch(status, { error: "invalid_exact_evm_payload_signature" });
    const result = await client.submit(intent, PAYLOAD);
    expect(result.status).toBe("REJECTED");
  });

  test.each([409, 408, 429, 500, 503])("HTTP %i → UNKNOWN (reconciler owns it)", async (status) => {
    const store = new RecordingStore();
    const client = new X402FacilitatorClient({ baseUrl: "https://fac.example" }, store);
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    stubFetch(status, status === 409
      ? { success: false, errorReason: "authorization_used" }
      : { error: "boom" });
    const result = await client.submit(intent, PAYLOAD);
    expect(result.status).toBe("UNKNOWN");
    expect(store.casCalls).toEqual([{ from: "SUBMITTING", to: "RECONCILING" }]);
  });
});

// ---------------------------------------------------------------------------
// H-7 — CAS loss must not blind-overwrite
// ---------------------------------------------------------------------------

describe("F-112/H-7: fencing on CAS loss", () => {
  test("CAS failure during RECONCILING transition: no blind status write, no throw", async () => {
    const store = new RecordingStore();
    store.failCas = true;
    const client = new X402FacilitatorClient({ baseUrl: "https://fac.example" }, store);
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    stubFetch(500, { error: "boom" });
    const result: SubmitResult = await client.submit(intent, PAYLOAD);

    expect(result.status).toBe("UNKNOWN");
    // the legacy fallback called updatePaymentIntentStatus unconditionally —
    // that write must NOT have happened.
    expect(store.statusWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H-8 — bookkeeping failure after a real settle stays SUBMITTED
// ---------------------------------------------------------------------------

describe("F-112/H-8: post-settle bookkeeping failure", () => {
  test("recordSubmissionResult throws after 2xx → still SUBMITTED + SETTLEMENT_PENDING CAS", async () => {
    const store = new RecordingStore();
    const client = new X402FacilitatorClient({ baseUrl: "https://fac.example" }, store);
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    stubFetch(200, { success: true, transaction: "0x" + "cd".repeat(32) });
    store.failBookkeeping = true;
    const result = await client.submit(intent, PAYLOAD);

    // Money may have moved — the outcome must NOT be blurred into
    // NETWORK_ERROR/UNKNOWN.
    expect(result.status).toBe("SUBMITTED");
    expect(store.casCalls).toEqual([{ from: "SUBMITTING", to: "SETTLEMENT_PENDING" }]);
  });
});
