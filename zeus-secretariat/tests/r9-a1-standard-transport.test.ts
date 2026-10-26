/**
 * R9-A1 — Standard x402 v2 client transport (third-party sellers).
 *
 * Audit origin: secretariat-audit.md finding A1 (decision memo:
 * docs/payment-protocol-a1-decision.md — Option B implemented as a transport
 * adapter). Certification methodology adapted from Once (onceexec.com)
 * hostile-retry labs: every scenario counts REAL seller effects from an
 * append-only journal, never from internal state assertions.
 *
 * Matrix:
 *   happy path            → 1 paid call, SUBMITTED(tx), result delivered, SUCCESS
 *   402 on paid call      → REJECTED, durable RECONCILING, 1 paid call, no double leg
 *   200 w/o receipt       → UNKNOWN (fail-closed), body retained for forensics only
 *   network error         → UNKNOWN (never throws)
 *   5xx / 409 / 429       → UNKNOWN; other 4xx → REJECTED
 *   malformed receipts    → treated as NO receipt (strict parsing)
 *   maxTimeoutSeconds     → restored from DISCOVERY evidence into the payload
 *   scanner race          → STANDARD_PAID_CALL intents never get a seller re-call
 *   async crash window    → SettlementFeedbackService completes from the durable marker
 *   one-effect invariant  → sync + async + scanner together = exactly ONE paid call
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
import type { ReconciliationEngine, ReconciliationOutcome } from '../src/core/reconciliation-engine';
import type { PaymentPayload } from '../src/adapters/x402-facilitator-client';
import { StandardX402Transport, isStandardPaidCallRecord } from '../src/core/standard-x402-transport';
import { PostSettlementEngine } from '../src/core/post-settlement-engine';
import { SettlementFeedbackService } from '../src/core/settlement-feedback-service';

// ---------------------------------------------------------------------------
// Controlled seller — fetch-dispatched, append-only effect journal (Once-style)
// ---------------------------------------------------------------------------

interface JournalEntry {
  kind: 'DISCOVERY' | 'PAID_CALL';
  url: string;
  method: string;
  paymentSignature: string | null;
  idempotencyKey: string | null;
  body: string | null;
}

class ControlledSeller {
  readonly journal: JournalEntry[] = [];
  /** Scriptable paid-call behavior. */
  paidCallStatus = 200;
  paidCallReceipt: Record<string, unknown> | null = { success: true, transaction: '0x' + 'ab'.repeat(32) };
  paidCallBody: unknown = { result: 'route-executed', value: 42 };
  paidCallHeaders: Record<string, string> = {};
  paidCallThrow: Error | null = null;
  discoveryBody: unknown = {
    accepts: [{
      scheme: 'exact',
      network: 'eip155:196',
      asset: '0xUSDC',
      amount: '1000000',
      payTo: '0xThirdPartySeller',
      maxTimeoutSeconds: 300,
    }],
  };
  discoveryStatus = 402;

  /** Dispatches a globalThis.fetch call; appends to the journal. */
  handle = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const paymentSignature = headers['PAYMENT-SIGNATURE'] ?? null;
    const isPaid = paymentSignature !== null;
    this.journal.push({
      kind: isPaid ? 'PAID_CALL' : 'DISCOVERY',
      url: String(url),
      method: String(init.method ?? 'GET'),
      paymentSignature,
      idempotencyKey: headers['Idempotency-Key'] ?? null,
      body: typeof init.body === 'string' ? init.body : null,
    });

    if (!isPaid) {
      return new Response(JSON.stringify(this.discoveryBody), {
        status: this.discoveryStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (this.paidCallThrow) throw this.paidCallThrow;
    const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...this.paidCallHeaders };
    if (this.paidCallReceipt) {
      responseHeaders['PAYMENT-RESPONSE'] = btoa(JSON.stringify(this.paidCallReceipt));
    }
    return new Response(JSON.stringify(this.paidCallBody), {
      status: this.paidCallStatus,
      headers: responseHeaders,
    });
  };

  paidCallCount(): number {
    return this.journal.filter((e) => e.kind === 'PAID_CALL').length;
  }
}

// ---------------------------------------------------------------------------
// Durable store with transport bookkeeping + journals
// ---------------------------------------------------------------------------

class TestDurableStore implements DurableEvidenceStore {
  private intents: Map<string, DurablePaymentIntent> = new Map();
  private operations: Map<string, Operation> = new Map();
  private evidence: Map<string, EvidenceRecord[]> = new Map();

  /** CAS bookkeeping journals (transport/adapter discipline observability). */
  submittingCalls: string[] = [];
  submissionResults: Array<{ id: string; state: string; txHash?: string; body: unknown }> = [];
  casCalls: Array<{ id: string; from: string; to: string; extra: unknown }> = [];
  noncesMarked: string[] = [];

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    for (const existing of this.intents.values()) {
      if (existing.operationId === intent.operationId) throw new Error('DUPLICATE');
    }
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getPaymentIntentByOperationId(opId: string): Promise<DurablePaymentIntent | null> {
    for (const intent of this.intents.values()) {
      if (intent.operationId === opId) return { ...intent };
    }
    return null;
  }
  async getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null> {
    const intent = this.intents.get(id);
    return intent ? { ...intent } : null;
  }
  async transitionToSubmitting(paymentIntentId: string): Promise<boolean> {
    this.submittingCalls.push(paymentIntentId);
    return true;
  }
  async recordSubmissionResult(
    id: string, state: string, txHash?: string, _status?: number, body?: unknown,
  ): Promise<void> {
    this.submissionResults.push({ id, state, txHash, body });
    const intent = this.intents.get(id);
    if (intent) {
      intent.settlementState = state as DurablePaymentIntent['settlementState'];
      if (txHash) intent.txHash = txHash;
      if (body !== undefined) intent.facilitatorResponseBody = body;
    }
  }
  async compareAndSetState(
    id: string, from: string, to: string, extra?: Partial<DurablePaymentIntent>,
  ): Promise<boolean> {
    this.casCalls.push({ id, from, to, extra });
    const intent = this.intents.get(id);
    if (intent && intent.settlementState === from) {
      intent.settlementState = to as DurablePaymentIntent['settlementState'];
      if (extra?.facilitatorResponseBody !== undefined) intent.facilitatorResponseBody = extra.facilitatorResponseBody;
      if (extra?.errorReason !== undefined) intent.errorReason = extra.errorReason;
      if (extra?.facilitatorHttpStatus !== undefined) intent.facilitatorHttpStatus = extra.facilitatorHttpStatus;
      return true;
    }
    return false;
  }
  async markNonceSubmitted(nonce: string): Promise<void> { this.noncesMarked.push(nonce); }
  async updatePaymentIntentStatus(): Promise<void> {}
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<any> { return null; }
  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }
  async getOperation(opId: string): Promise<Operation | null> {
    const op = this.operations.get(opId);
    return op ? ({ ...op, evidence: [...op.evidence] } as Operation) : null;
  }
  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, { ...operation, evidence: [...operation.evidence] } as Operation);
  }
  async getEvidence(opId: string): Promise<EvidenceRecord[]> { return this.evidence.get(opId) ?? []; }
  async getOperationsByStatus(): Promise<Operation[]> { return [...this.operations.values()]; }
  async getNonTerminalIntents(): Promise<DurablePaymentIntent[]> {
    return [...this.intents.values()].filter(
      (i) => !['SETTLED', 'NOT_SETTLED', 'UNRESOLVED_MANUAL'].includes(i.settlementState),
    );
  }
  async appendReconciliationObservation(): Promise<void> {}
  async getReconciliationObservations(): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(): Promise<void> {}
  async saveNotSettledEvidenceBundle(): Promise<void> {}
  async getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null> {
    for (const op of this.operations.values()) {
      if (op.clientId === clientId && op.requestId === requestId) return { ...op } as Operation;
    }
    return null;
  }
  /** Simulation of a restart: deep-enough copy for crash-window tests. */
  cloneForRestart(): TestDurableStore {
    const c = new TestDurableStore();
    for (const [k, v] of this.intents) c.intents.set(k, { ...v });
    for (const [k, v] of this.operations) c.operations.set(k, { ...v, evidence: [...v.evidence] } as Operation);
    for (const [k, v] of this.evidence) c.evidence.set(k, [...v]);
    return c;
  }
}

// ---------------------------------------------------------------------------
// Stubs: signer / legacy adapter / reconciliation engine
// ---------------------------------------------------------------------------

const mockSigner: PaymentSigner = {
  signerType: 'TEST',
  async getAddress() { return '0xTestPayer'; },
  async signPayment() { throw new Error('Not used'); },
};

class TestLegacyAdapter implements PaymentAdapter {
  readonly network = 'eip155:196';
  async createAuthorization(req: PaymentRequirement, _s: PaymentSigner, ctx: SigningContext): Promise<PaymentAuthorization> {
    return { signature: '0xsig-' + ctx.operationId, scheme: 'exact', timestamp: Date.now(), context: ctx };
  }
  async submit(): Promise<PaymentSubmissionResult> {
    return { success: true, transactionHash: '0xlegacy' } as any;
  }
  async observeSettlement(): Promise<SettlementObservation> { return { settled: false, reason: 'PENDING' } as any; }
}

class TestReconEngine {
  public outcome: ReconciliationOutcome = { status: 'SETTLED', reason: 'test-stub' };
  async reconcile(_id: string): Promise<ReconciliationOutcome> { return this.outcome; }
  async recoverAfterCrash(): Promise<string[]> { return []; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function standardPolicy(): PaymentPolicy {
  return {
    maxPrice: '1000000',
    allowedNetworks: ['eip155:196'],
    allowedAssets: ['0xUSDC'],
    authorizationMode: 'policy-bound',
    transport: 'standard',
  } as PaymentPolicy;
}

function makeRequest(overrides?: Partial<ExecuteRequest>): ExecuteRequest {
  return {
    target: 'https://third-party-seller.example.com/api/paid',
    method: 'POST',
    payload: { query: 'insurance-quote', region: 'global' },
    policy: standardPolicy(),
    requestId: 'req-r9-default',
    clientId: 'client-r9',
    ...overrides,
  };
}

interface Harness {
  store: TestDurableStore;
  seller: ControlledSeller;
  recon: TestReconEngine;
  secretariat: Secretariat;
  settlementSubmitSpy: jest.Mock;
}

function buildHarness(opts?: { policy?: PaymentPolicy }): Harness {
  const store = new TestDurableStore();
  const seller = new ControlledSeller();
  const recon = new TestReconEngine();

  const settlementSubmitSpy = jest.fn().mockResolvedValue({
    status: 'SUBMITTED' as const, txHash: '0xzeus-should-not-be-called', rawResponse: {},
  });
  const settlementAdapter = { submit: settlementSubmitSpy };

  const standardTransport = new StandardX402Transport({ timeoutMs: 2000 }, store);

  const adapters = new Map<string, PaymentAdapter>();
  adapters.set('eip155:196', new TestLegacyAdapter());

  const secretariat = new Secretariat({
    evidenceStore: store,
    signer: mockSigner,
    adapters,
    settlementAdapter: settlementAdapter as never,
    standardTransport: standardTransport as never,
    reconciliationEngine: recon as unknown as ReconciliationEngine,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = seller.handle as unknown as typeof globalThis.fetch;

  return {
    store, seller, recon, secretariat, settlementSubmitSpy,
    [Symbol.for('restoreFetch')]: () => { globalThis.fetch = originalFetch; },
  } as Harness & { [Symbol.for('restoreFetch')]: () => void };
}

// fetch restore across tests
const harnesses: Array<() => void> = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!();
  jest.restoreAllMocks();
});
const withFetch = (h: Harness) => {
  // buildHarness already installed the seller fetch; register restore
  const original = globalThis.fetch;
  harnesses.push(() => { globalThis.fetch = original; });
};

// ---------------------------------------------------------------------------
// Part 1 — Transport unit behavior (through the full execute() path)
// ---------------------------------------------------------------------------

describe('R9-A1: standard transport — happy path (canonical x402 v2 client flow)', () => {
  test('paid call carries PAYMENT-SIGNATURE + Idempotency-Key; result delivered; exactly ONE paid call', async () => {
    const h = buildHarness();
    withFetch(h);
    const result = await h.secretariat.execute(makeRequest());

    // Outcome first — a failure here surfaces the operation error, not a
    // downstream assertion mismatch
    expect(result.status).toBe('SUCCESS');

    // One-effect invariant (counted from the seller journal, not from state)
    expect(h.seller.paidCallCount()).toBe(1);

    const paid = h.seller.journal.find((e) => e.kind === 'PAID_CALL')!;
    expect(paid.method).toBe('POST');
    expect(paid.idempotencyKey).toEqual(expect.any(String));
    expect(typeof paid.paymentSignature).toBe('string');

    // Header decodes to the canonical v2 payload with the DISCOVERED window
    const decoded = JSON.parse(atob(paid.paymentSignature!)) as PaymentPayload;
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.amount).toBe('1000000');
    expect(decoded.accepted.payTo).toBe('0xThirdPartySeller');
    expect(decoded.accepted.network).toBe('eip155:196');
    expect(decoded.accepted.maxTimeoutSeconds).toBe(300); // restored from discovery
    expect(decoded.payload.authorization.from).toBe('0xTestPayer');
    expect(decoded.payload.authorization.nonce).toBeDefined();

    // Durable transport discipline
    expect(h.store.submittingCalls.length).toBe(1);
    expect(h.store.submissionResults).toHaveLength(1);
    expect(h.store.submissionResults[0].state).toBe('SETTLEMENT_PENDING');
    expect(h.store.submissionResults[0].txHash).toBe('0x' + 'ab'.repeat(32));
    expect(h.store.noncesMarked).toHaveLength(1);
    expect(isStandardPaidCallRecord(h.store.submissionResults[0].body)).toBe(true);

    // Operation outcome: SUCCESS with the seller's body as the result
    expect(result.status).toBe('SUCCESS');
    expect(result.data).toEqual({ result: 'route-executed', value: 42 });
    expect(result.executionEvidence?.source).toBe('STANDARD_TRANSPORT');
    expect(result.executionEvidence?.statusCode).toBe(200);

    // Zeus pay-then-prove leg was NOT used
    expect(h.settlementSubmitSpy).not.toHaveBeenCalled();

    // Evidence chain recorded the atomic discharge
    const op = await h.store.getOperation('op-' + 'x'); // placeholder; real assert below
    void op;
  });

  test('evidence chain: STANDARD_PAID_CALL + EXECUTION_CONFIRMED recorded; no execution obligation', async () => {
    const h = buildHarness();
    withFetch(h);
    await h.secretariat.execute(makeRequest());
    const ops = await h.store.getOperationsByStatus();
    const op = ops[ops.length - 1];
    const events = op.evidence.map((e) => e.event);
    expect(events).toContain('STANDARD_PAID_CALL');
    expect(events).toContain('EXECUTION_CONFIRMED');
    const confirmed = op.evidence.find((e) => e.event === 'EXECUTION_CONFIRMED');
    expect((confirmed!.payload as Record<string, unknown>).source).toBe('STANDARD_TRANSPORT');
  });

  test('GET request: no body on the paid call', async () => {
    const h = buildHarness();
    withFetch(h);
    await h.secretariat.execute(makeRequest({ method: 'GET', payload: undefined }));
    const paid = h.seller.journal.find((e) => e.kind === 'PAID_CALL')!;
    expect(paid.method).toBe('GET');
    expect(paid.body).toBeNull();
  });
});

describe('R9-A1: standard transport — refusal and ambiguity classification', () => {
  test('402 on the paid call → REJECTED, durable RECONCILING, no result, FAILED terminal', async () => {
    const h = buildHarness();
    withFetch(h);
    h.seller.paidCallStatus = 402;
    h.seller.paidCallReceipt = null;

    const result = await h.secretariat.execute(makeRequest());
    expect(h.seller.paidCallCount()).toBe(1); // never re-fired
    expect(h.store.casCalls.some((c) => c.to === 'RECONCILING')).toBe(true);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('STANDARD_TRANSPORT');
  });

  test('200 WITHOUT PAYMENT-RESPONSE → UNKNOWN (fail-closed): body NOT delivered, reconciler owns truth', async () => {
    const h = buildHarness();
    withFetch(h);
    h.seller.paidCallReceipt = null;
    // Ambiguous transport outcome → reconciliation stays open (RECONCILING),
    // the operation remains non-terminal — NOT silently settled by the stub.
    h.recon.outcome = { status: 'RECONCILING', reason: 'awaiting on-chain truth' };

    const result = await h.secretariat.execute(makeRequest());
    expect(result.status).toBe('PENDING');
    expect(h.seller.paidCallCount()).toBe(1);
    // Durable marker retained for forensics
    expect(h.store.casCalls.some((c) => c.to === 'RECONCILING')).toBe(true);
    const cas = h.store.casCalls.find((c) => c.to === 'RECONCILING')!;
    expect(isStandardPaidCallRecord((cas.extra as Record<string, unknown>).facilitatorResponseBody)).toBe(true);
    // Honest outcome: settlement unknown → operation stays non-terminal
    expect(result.status).toBe('PENDING');
    expect(result.data).toBeUndefined();
  });

  test('network error → UNKNOWN, never throws', async () => {
    const h = buildHarness();
    withFetch(h);
    h.seller.paidCallThrow = new Error('ECONNRESET mid-flight');
    h.recon.outcome = { status: 'RECONCILING', reason: 'awaiting on-chain truth' };
    const result = await h.secretariat.execute(makeRequest());
    expect(result.status).toBe('PENDING');
    expect(h.store.casCalls.some((c) => c.to === 'RECONCILING')).toBe(true);
  });

  test.each([503, 409, 429, 408])('HTTP %i → UNKNOWN (ambiguity — reconciler owns)', async (status) => {
    const h = buildHarness();
    withFetch(h);
    h.seller.paidCallStatus = status;
    h.seller.paidCallReceipt = null;
    h.recon.outcome = { status: 'RECONCILING', reason: 'awaiting on-chain truth' };
    const result = await h.secretariat.execute(makeRequest());
    expect(result.status).toBe('PENDING');
    expect(h.store.casCalls.some((c) => c.to === 'RECONCILING')).toBe(true);
  });

  test.each([400, 401, 403, 404])('HTTP %i → REJECTED (definitive refusal)', async (status) => {
    const h = buildHarness();
    withFetch(h);
    h.seller.paidCallStatus = status;
    h.seller.paidCallReceipt = null;
    const result = await h.secretariat.execute(makeRequest());
    expect(result.status).toBe('FAILED');
  });

  test.each([
    ['success:false body', { success: false, errorReason: 'insufficient_funds' }],
    ['wrong tx shape', { success: true, transaction: 'not-a-tx-hash' }],
    ['missing transaction', { success: true }],
  ])('malformed receipt (%s) → UNKNOWN, never SUBMITTED', async (_name, receipt) => {
    const h = buildHarness();
    withFetch(h);
    h.seller.paidCallReceipt = receipt as Record<string, unknown>;
    h.recon.outcome = { status: 'RECONCILING', reason: 'awaiting on-chain truth' };
    const result = await h.secretariat.execute(makeRequest());
    expect(result.status).toBe('PENDING');
    expect(h.store.submissionResults).toHaveLength(0); // no SETTLEMENT_PENDING without a real receipt
  });
});

// ---------------------------------------------------------------------------
// Part 2 — Scanner defense-in-depth: NO seller re-call for standard intents
// ---------------------------------------------------------------------------

describe('R9-A1: scanner must never re-call a STANDARD_PAID_CALL seller', () => {
  test('ensureExecutionObligations skips marker intents (no job, no seller call)', async () => {
    const h = buildHarness();
    withFetch(h);
    await h.secretariat.execute(makeRequest());

    // Simulate the crash-window race: intent SETTLED, operation not yet completed
    const ops = await h.store.getOperationsByStatus();
    const op = ops[ops.length - 1];
    const intent = await h.store.getPaymentIntentByOperationId(op.operationId);
    expect(intent).toBeTruthy();

    const scannerStore = {
      getSettledIntentsWithoutObligation: async () => [intent],
      append: async () => {},
    };
    const saveJob = jest.fn();
    const sellerExecute = jest.fn();
    const executionStore = {
      getAttemptsByOperation: async () => [],
      saveJob,
      createExecutionObligation: jest.fn(),
    };
    const sellerAdapter = { execute: sellerExecute };
    const engine = new PostSettlementEngine(
      scannerStore as never,
      executionStore as never,
      sellerAdapter as never,
      { workerId: 'test', sellerUrl: 'https://x', sellerMethod: 'POST', lockDurationMs: 1000, maxExecutionAttempts: 3 },
    );
    const created = await engine.ensureExecutionObligations();
    expect(created).toEqual([]);
    expect(saveJob).not.toHaveBeenCalled();
    expect(sellerExecute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Async crash window: SettlementFeedbackService completes from the marker
// ---------------------------------------------------------------------------

describe('R9-A1: async settlement feedback completes standard operations inline', () => {
  function makeIntentWithMarker(store: TestDurableStore, operationId: string, withBody: boolean): DurablePaymentIntent {
    const marker = {
      kind: 'STANDARD_PAID_CALL' as const,
      sellerHttpStatus: 200,
      paymentResponse: { success: true as const, transaction: '0x' + 'ab'.repeat(32) },
      sellerBody: withBody ? { result: 'route-executed', value: 42 } : null,
      capturedAt: Date.now(),
    };
    const intent = {
      paymentIntentId: 'pi-r9-' + operationId,
      operationId,
      authorizer: '0xTestPayer',
      payTo: '0xThirdPartySeller',
      value: '1000000',
      asset: '0xUSDC',
      network: 'eip155:196',
      nonce: '0x' + '11'.repeat(32),
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 300,
      paymentPayload: 'cGF5bG9hZA==',
      paymentPayloadHash: '0x' + '22'.repeat(32),
      settlementState: 'SETTLEMENT_PENDING',
      txHash: '0x' + 'ab'.repeat(32),
      facilitatorResponseBody: marker,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as DurablePaymentIntent;
    // seed directly (createPaymentIntent dedups by operationId — fine here)
    void store;
    return intent;
  }

  function makeOperation(operationId: string): Operation {
    return {
      operationId,
      requestId: 'req-r9-async',
      clientId: 'client-r9',
      target: 'https://third-party-seller.example.com/api/paid',
      method: 'POST',
      paymentPolicy: standardPolicy(),
      paymentState: 'UNKNOWN',
      executionState: 'NOT_STARTED',
      deliveryState: 'NOT_STARTED',
      currentState: 'SETTLEMENT_PENDING',
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      evidence: [],
    } as unknown as Operation;
  }

  test('SETTLED + marker with body → SUCCESS with resultData from the marker', async () => {
    const store = new TestDurableStore();
    const op = makeOperation('op-async-1');
    await store.saveOperation(op);
    const intent = makeIntentWithMarker(store, op.operationId, true);
    await store.createPaymentIntent(intent);

    const feedback = new SettlementFeedbackService(store, store);
    const { applied, currentState } = await feedback.applyOutcome(
      op.operationId,
      { status: 'SETTLED', reason: 'tx-confirmed' },
      { paymentIntentId: intent.paymentIntentId },
    );
    expect(applied).toBe(true);
    expect(currentState).toBe('SUCCESS');
    const saved = await store.getOperation(op.operationId);
    expect(saved!.currentState).toBe('SUCCESS');
    expect(saved!.resultData).toEqual({ result: 'route-executed', value: 42 });
    expect(saved!.executionEvidence?.source).toBe('STANDARD_TRANSPORT');
    expect(saved!.paymentState).toBe('SETTLED');
    const events = saved!.evidence.map((e) => e.event);
    expect(events).toContain('STANDARD_EXECUTION_DISCHARGED');
  });

  test('SETTLED + marker without body (timeout after settle) → honest UNRESOLVABLE', async () => {
    const store = new TestDurableStore();
    const op = makeOperation('op-async-2');
    await store.saveOperation(op);
    const intent = makeIntentWithMarker(store, op.operationId, false);
    await store.createPaymentIntent(intent);

    const feedback = new SettlementFeedbackService(store, store);
    const { currentState } = await feedback.applyOutcome(
      op.operationId,
      { status: 'SETTLED', reason: 'nonce-scan found settlement' },
      { paymentIntentId: intent.paymentIntentId },
    );
    expect(currentState).toBe('UNRESOLVABLE');
    const saved = await store.getOperation(op.operationId);
    expect(saved!.currentState).toBe('UNRESOLVABLE');
    expect(saved!.resultData).toBeUndefined();
  });

  test('zeus-mode intents (no marker) → SETTLED only; scanner path unchanged', async () => {
    const store = new TestDurableStore();
    const op = makeOperation('op-async-3');
    await store.saveOperation(op);
    const intent = makeIntentWithMarker(store, op.operationId, true);
    // strip the marker — zeus mode: facilitatorResponseBody is the raw settle body
    const zeusIntent = { ...intent, facilitatorResponseBody: { success: true, transaction: '0x' + 'cd'.repeat(32) } };
    await store.createPaymentIntent(zeusIntent);

    const feedback = new SettlementFeedbackService(store, store);
    const { currentState } = await feedback.applyOutcome(
      op.operationId,
      { status: 'SETTLED', reason: 'tx-confirmed' },
      { paymentIntentId: zeusIntent.paymentIntentId },
    );
    expect(currentState).toBe('SETTLED'); // stops at SETTLED — PostSettlementEngine owns the leg
    const saved = await store.getOperation(op.operationId);
    expect(saved!.currentState).toBe('SETTLED');
  });

  test('idempotent: already-terminal operation is never re-applied', async () => {
    const store = new TestDurableStore();
    const op = makeOperation('op-async-4');
    op.currentState = 'SUCCESS';
    await store.saveOperation(op);
    const intent = makeIntentWithMarker(store, op.operationId, true);
    await store.createPaymentIntent(intent);

    const feedback = new SettlementFeedbackService(store, store);
    const { applied } = await feedback.applyOutcome(
      op.operationId,
      { status: 'SETTLED', reason: 'late duplicate probe' },
      { paymentIntentId: intent.paymentIntentId },
    );
    expect(applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — ONE-EFFECT INVARIANT (hostile-retry, Once-style)
// ---------------------------------------------------------------------------

describe('R9-A1: one-effect invariant across sync + async + scanner', () => {
  test('full lifecycle (execute → feedback re-apply → scanner) = exactly ONE paid seller call', async () => {
    const h = buildHarness();
    withFetch(h);
    const result = await h.secretariat.execute(makeRequest());
    expect(result.status).toBe('SUCCESS');
    expect(h.seller.paidCallCount()).toBe(1);

    // Async duplicate: reconciliation worker re-applies SETTLED feedback
    const ops = await h.store.getOperationsByStatus();
    const op = ops[ops.length - 1];
    const intent = await h.store.getPaymentIntentByOperationId(op.operationId)!;
    const feedback = new SettlementFeedbackService(h.store, h.store);
    await feedback.applyOutcome(op.operationId, { status: 'SETTLED', reason: 'duplicate probe' }, {
      paymentIntentId: intent!.paymentIntentId,
    });

    // Scanner runs against the settled intent
    const scannerStore = {
      getSettledIntentsWithoutObligation: async () => [intent],
      append: async () => {},
    };
    const engine = new PostSettlementEngine(
      scannerStore as never,
      { getAttemptsByOperation: async () => [], saveJob: jest.fn() } as never,
      { execute: jest.fn() } as never,
      { workerId: 'test', sellerUrl: 'https://x', sellerMethod: 'POST', lockDurationMs: 1000, maxExecutionAttempts: 3 },
    );
    await engine.ensureExecutionObligations();

    // The seller journal is the truth: STILL exactly one paid call
    expect(h.seller.paidCallCount()).toBe(1);
  });

  test('discovery phase never fires the paid route: probe carries NO PAYMENT-SIGNATURE', async () => {
    const h = buildHarness();
    withFetch(h);
    await h.secretariat.execute(makeRequest());
    const discovery = h.seller.journal.filter((e) => e.kind === 'DISCOVERY');
    expect(discovery.length).toBeGreaterThanOrEqual(1);
    for (const d of discovery) {
      expect(d.paymentSignature).toBeNull();
    }
  });
});
