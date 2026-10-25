/**
 * F-108 + F-109 regression tests (external audit 2026-10-26, Major + Minor).
 *
 * F-108 (Major): the Stage B authorization used TWO blind writes
 * (updatePaymentIntentAuthorization + updatePaymentIntentStatus). Two
 * concurrent callers that both passed the PENDING_SIGNATURE check (TOCTOU)
 * could (a) overwrite each other's signed payload (last-writer-wins) and
 * (b) REGRESS an intent a concurrent submission had already advanced
 * (SUBMITTING/SETTLEMENT_PENDING → AUTHORIZED), re-opening the submission
 * window. Fix: authorizePaymentIntent() — ONE CAS-guarded statement; the
 * payload is immutable once bound; conflicts fail closed.
 *
 * F-109 (Minor): the auto (custodial) flow created the intent ALREADY
 * AUTHORIZED while it still carried the unsigned SIGNING placeholder payload,
 * then swapped the payload via a blind write. Fix: the intent is born
 * PENDING_SIGNATURE and the placeholder swap + AUTHORIZED flip happen in the
 * same atomic CAS.
 *
 * Store-level pins run against InMemoryEvidenceStore (mirrors
 * PostgresEvidenceStore semantics; the live-PG variant stays on the PG stand).
 */

import { describe, it, expect } from '@jest/globals';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store';
import { Secretariat } from '../src/core/state-machine';
import type {
  DurablePaymentIntent,
  EvidenceRecord,
  ExecuteRequest,
  Operation,
  PaymentPolicy,
  PaymentSigner,
  PaymentRequirement,
  PaymentAuthorization,
  PaymentSubmissionResult,
  SettlementObservation,
  SigningContext,
  PaymentAdapter,
  DurableEvidenceStore,
} from '../src/core/types';
import type { PaymentPayload, SettlementAdapter } from '../src/adapters/x402-facilitator-client';
import { keccak256, toBytes } from 'viem';

const payloadHash = (s: string) => keccak256(toBytes(s));

// ---------------------------------------------------------------------------
// Part A — InMemoryEvidenceStore.authorizePaymentIntent contract
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<DurablePaymentIntent> = {}): DurablePaymentIntent {
  const now = Date.now();
  return {
    paymentIntentId: `intent-${now}-${Math.random().toString(36).slice(2)}`,
    operationId: `op-${now}-${Math.random().toString(36).slice(2)}`,
    settlementState: 'PENDING_SIGNATURE',
    authorizer: '0xPayer',
    payTo: '0xPayee',
    value: '1000000',
    asset: '0xUSDC',
    network: 'base-sepolia',
    nonce: `0x${now.toString(16)}${Math.random().toString(16).slice(2, 10)}`,
    validAfter: Math.floor(now / 1000) - 3600,
    validBefore: Math.floor(now / 1000) + 3600,
    paymentPayload: 'placeholder-SIGNING',
    paymentPayloadHash: '0xplaceholder-hash',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('F-108: InMemoryEvidenceStore.authorizePaymentIntent CAS contract', () => {
  it('binds payload + AUTHORIZED atomically from PENDING_SIGNATURE (returns true)', async () => {
    const store = new InMemoryEvidenceStore();
    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    const won = await store.authorizePaymentIntent(intent.paymentIntentId, {
      paymentPayload: 'signed-payload-A',
      paymentPayloadHash: '0xhash-A',
    }, 'PENDING_SIGNATURE');

    expect(won).toBe(true);
    const after = await store.getPaymentIntentById(intent.paymentIntentId);
    expect(after!.settlementState).toBe('AUTHORIZED');
    expect(after!.paymentPayloadHash).toBe('0xhash-A');
    expect(after!.paymentPayload).toBe('signed-payload-A');
  });

  it('CAS loss with the IDENTICAL payload hash returns false and never overwrites', async () => {
    const store = new InMemoryEvidenceStore();
    const intent = makeIntent({ settlementState: 'AUTHORIZED', paymentPayloadHash: '0xhash-A', paymentPayload: 'signed-payload-A' });
    await store.createPaymentIntent(intent);

    const won = await store.authorizePaymentIntent(intent.paymentIntentId, {
      paymentPayload: 'signed-payload-A-replayed',
      paymentPayloadHash: '0xhash-A',
    }, 'PENDING_SIGNATURE');

    expect(won).toBe(false);
    const after = await store.getPaymentIntentById(intent.paymentIntentId);
    // first writer's payload bytes stay durable — the replay must not touch them
    expect(after!.paymentPayload).toBe('signed-payload-A');
  });

  it('CAS loss with a DIFFERENT payload throws CONFLICT and never overwrites (payload immutability)', async () => {
    const store = new InMemoryEvidenceStore();
    const intent = makeIntent({ settlementState: 'AUTHORIZED', paymentPayloadHash: '0xhash-A', paymentPayload: 'signed-payload-A' });
    await store.createPaymentIntent(intent);

    await expect(store.authorizePaymentIntent(intent.paymentIntentId, {
      paymentPayload: 'signed-payload-B',
      paymentPayloadHash: '0xhash-B',
    }, 'PENDING_SIGNATURE')).rejects.toThrow('PAYMENT_INTENT_AUTHORIZATION_CONFLICT');

    const after = await store.getPaymentIntentById(intent.paymentIntentId);
    expect(after!.paymentPayloadHash).toBe('0xhash-A');
    expect(after!.paymentPayload).toBe('signed-payload-A');
  });

  it('refuses to REGRESS a submission-in-flight intent: SUBMITTING stays SUBMITTING (F-108 state regression)', async () => {
    const store = new InMemoryEvidenceStore();
    const intent = makeIntent({ settlementState: 'SUBMITTING', paymentPayloadHash: '0xhash-A', paymentPayload: 'signed-payload-A' });
    await store.createPaymentIntent(intent);

    // A stale Stage B caller (loaded the intent while it was PENDING_SIGNATURE)
    // replays its payload against the intent that already moved to SUBMITTING.
    const wonSame = await store.authorizePaymentIntent(intent.paymentIntentId, {
      paymentPayload: 'signed-payload-A2',
      paymentPayloadHash: '0xhash-A',
    }, 'PENDING_SIGNATURE');
    expect(wonSame).toBe(false); // idempotent handover, NO write, NO regression

    await expect(store.authorizePaymentIntent(intent.paymentIntentId, {
      paymentPayload: 'signed-payload-B',
      paymentPayloadHash: '0xhash-B',
    }, 'PENDING_SIGNATURE')).rejects.toThrow('PAYMENT_INTENT_AUTHORIZATION_CONFLICT');

    const after = await store.getPaymentIntentById(intent.paymentIntentId);
    expect(after!.settlementState).toBe('SUBMITTING');
    expect(after!.paymentPayloadHash).toBe('0xhash-A');
  });

  it('terminal intents: identical payload → false, different payload → CONFLICT', async () => {
    const store = new InMemoryEvidenceStore();
    const settled = makeIntent({ settlementState: 'SETTLED', paymentPayloadHash: '0xhash-A' });
    await store.createPaymentIntent(settled);
    await expect(store.authorizePaymentIntent(settled.paymentIntentId, {
      paymentPayload: 'x', paymentPayloadHash: '0xhash-A',
    }, 'PENDING_SIGNATURE')).resolves.toBe(false);
    await expect(store.authorizePaymentIntent(settled.paymentIntentId, {
      paymentPayload: 'x', paymentPayloadHash: '0xhash-B',
    }, 'PENDING_SIGNATURE')).rejects.toThrow('PAYMENT_INTENT_AUTHORIZATION_CONFLICT');
  });

  it('throws INTENT_NOT_FOUND for a missing intent', async () => {
    const store = new InMemoryEvidenceStore();
    await expect(store.authorizePaymentIntent('intent-missing', {
      paymentPayload: 'x', paymentPayloadHash: '0xhash',
    }, 'PENDING_SIGNATURE')).rejects.toThrow('INTENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Part B — state-machine Stage B: concurrent conflicting payloads race
// ---------------------------------------------------------------------------

const MOCK_X402_CHALLENGE = {
  accepts: [{
    scheme: 'exact',
    network: 'base-sepolia',
    asset: '0xUSDC',
    amount: '1000000',
    payTo: '0xSellerAddress',
    maxTimeoutSeconds: 300,
  }],
};

function sha16(s: string): string {
  return payloadHash(s);
}

/**
 * A store that faithfully mirrors the PostgreSQL CAS semantics AND keeps the
 * legacy blind pair (the pre-fix write path). Which path the state machine
 * takes is exactly what this suite pins: post-fix code must use the CAS.
 * The barrier simulates PG row-lock ordering: caller #2 passes its
 * PENDING_SIGNATURE check BEFORE caller #1's CAS commits — the classic
 * TOCTOU window that used to let caller #2 overwrite caller #1's payload.
 */
class RacingStageBStore implements DurableEvidenceStore {
  private readonly intents = new Map<string, DurablePaymentIntent>();
  private readonly operations = new Map<string, Operation>();
  private readonly evidence = new Map<string, EvidenceRecord[]>();
  public authorizeCalls = 0;
  public blindAuthorizationCalls = 0;
  public blindStatusCalls = 0;
  public markNonceSignedCalls = 0;
  // F-108 race barrier: armed ONLY by the deterministic TOCTOU test. While
  // disarmed, authorizePaymentIntent runs its real CAS unblocked.
  public armRaceBarrier = false;
  private releaseFirst?: () => void;
  private firstPaused?: Promise<void>;

  // ---- durable intent plumbing ----
  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    if ([...this.intents.values()].some(e => e.operationId === intent.operationId)) {
      throw new Error('DUPLICATE_OPERATION_ID');
    }
    this.intents.set(intent.paymentIntentId, { ...intent });
  }
  async getPaymentIntentByOperationId(operationId: string): Promise<DurablePaymentIntent | null> {
    for (const i of this.intents.values()) if (i.operationId === operationId) return { ...i };
    return null;
  }
  async getPaymentIntentById(id: string): Promise<DurablePaymentIntent | null> {
    return this.intents.get(id) ?? null;
  }

  // ---- the pre-fix BLIND pair (kept deliberately blind — this IS the bug) ----
  async updatePaymentIntentAuthorization(
    paymentIntentId: string,
    fields: Pick<DurablePaymentIntent, 'paymentPayload' | 'paymentPayloadHash'>,
  ): Promise<void> {
    this.blindAuthorizationCalls++;
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error('INTENT_NOT_FOUND');
    this.intents.set(paymentIntentId, { ...intent, ...fields, updatedAt: Date.now() });
  }
  async updatePaymentIntentStatus(paymentIntentId: string, status: DurablePaymentIntent['settlementState']): Promise<void> {
    this.blindStatusCalls++;
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error('INTENT_NOT_FOUND');
    this.intents.set(paymentIntentId, { ...intent, settlementState: status, updatedAt: Date.now() });
  }

  // ---- the post-fix CAS (PG row-lock semantics with a deterministic barrier) ----
  async authorizePaymentIntent(
    paymentIntentId: string,
    fields: Pick<DurablePaymentIntent, 'paymentPayload' | 'paymentPayloadHash'>,
    expectedState: DurablePaymentIntent['settlementState'] = 'PENDING_SIGNATURE',
  ): Promise<boolean> {
    this.authorizeCalls++;
    if (this.armRaceBarrier) {
      if (this.authorizeCalls === 1) {
        // Pause caller #1 INSIDE its CAS until caller #2 has also passed the
        // PENDING_SIGNATURE check and entered the CAS — the TOCTOU overlap.
        this.firstPaused = new Promise<void>(res => { this.releaseFirst = res; });
        await this.firstPaused;
      } else if (this.authorizeCalls === 2) {
        this.releaseFirst?.();
        // Yield so caller #1's continuation (queued first) runs its CAS first —
        // mirroring PG lock acquisition order.
        await new Promise(res => setImmediate(res));
      }
    }
    const intent = this.intents.get(paymentIntentId);
    if (!intent) throw new Error('INTENT_NOT_FOUND: ' + paymentIntentId);
    const conflict = () => new Error(
      `PAYMENT_INTENT_AUTHORIZATION_CONFLICT: intent is ${intent.settlementState} with a different payload`,
    );
    if (['SETTLED', 'NOT_SETTLED', 'UNRESOLVED_MANUAL'].includes(intent.settlementState)) {
      if (intent.paymentPayloadHash === fields.paymentPayloadHash) return false;
      throw conflict();
    }
    if (intent.settlementState === expectedState) {
      this.intents.set(paymentIntentId, {
        ...intent,
        paymentPayload: fields.paymentPayload,
        paymentPayloadHash: fields.paymentPayloadHash,
        settlementState: 'AUTHORIZED',
        updatedAt: Date.now(),
      });
      return true;
    }
    if (intent.paymentPayloadHash === fields.paymentPayloadHash) return false;
    throw conflict();
  }

  async markNonceSigned(): Promise<void> { this.markNonceSignedCalls++; }
  async markNonceSubmitted(): Promise<void> {}
  async markNonceSettled(): Promise<void> {}
  async reserveNonce(): Promise<void> {}
  async getNonce(): Promise<unknown> { return null; }

  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }
  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }
  async getOperationByRequestId(requestId: string): Promise<Operation | null> {
    for (const op of this.operations.values()) if (op.requestId === requestId) return { ...op };
    return null;
  }
  async getOperationByClientAndRequestId(clientId: string, requestId: string): Promise<Operation | null> {
    for (const op of this.operations.values()) if (op.clientId === clientId && op.requestId === requestId) return { ...op };
    return null;
  }
  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, { ...operation });
  }
  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return this.evidence.get(operationId) ?? [];
  }
  async getOperationsByStatus(): Promise<Operation[]> { return []; }
  async getNonTerminalIntents(): Promise<DurablePaymentIntent[]> { return []; }
  async appendReconciliationObservation(): Promise<void> {}
  async getReconciliationObservations(): Promise<unknown[]> { return []; }
  async saveSettledEvidenceBundle(): Promise<void> {}
  async saveNotSettledEvidenceBundle(): Promise<void> {}
}

class RecordingSettlementAdapter implements SettlementAdapter {
  submitCalls: Array<{ intent: DurablePaymentIntent; payload: PaymentPayload }> = [];
  async submit(intent: DurablePaymentIntent, payload: PaymentPayload) {
    this.submitCalls.push({ intent, payload });
    return { status: 'SUBMITTED' as const, txHash: '0xtxhash', rawResponse: {} };
  }
}

const stageBSigner: PaymentSigner = {
  signerType: 'TEST',
  async getAddress() { return '0xTestPayer'; },
  async signPayment() { throw new Error('Stage B must not sign'); },
};

function makeStageBRequest(requestId: string): ExecuteRequest {
  return {
    target: 'https://seller.example.com/api',
    method: 'GET',
    policy: {
      maxPrice: '1000000',
      allowedNetworks: ['base-sepolia'],
      allowedAssets: ['0xUSDC'],
      authorizationMode: 'policy-bound',
    } satisfies PaymentPolicy,
    requestId,
    clientId: 'client-f108',
    authorizer: '0xTestPayer',
  };
}

function makeSignedPayload(intent: DurablePaymentIntent, signature: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
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

describe('F-108: Stage B concurrent conflicting payloads (deterministic TOCTOU race)', () => {
  let store: RacingStageBStore;
  let settlementAdapter: RecordingSettlementAdapter;
  let secretariat: Secretariat;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    store = new RacingStageBStore();
    store.armRaceBarrier = true;
    settlementAdapter = new RecordingSettlementAdapter();
    secretariat = new Secretariat({
      evidenceStore: store,
      signer: stageBSigner,
      adapters: new Map(),
      settlementAdapter,
    } as any);
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(MOCK_X402_CHALLENGE), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('the FIRST bound payload is immutable — the loser conflicts, no overwrite, no state regression', async () => {
    const created = await secretariat.createRequest(makeStageBRequest('req-f108-race'));
    if (created.status !== 'AWAITING_PAYMENT_SIGNATURE') throw new Error('expected Stage A handoff');
    const intent = await store.getPaymentIntentByOperationId(created.operationId!);
    expect(intent).not.toBeNull();

    const payloadA = makeSignedPayload(intent!, '0xsig-A');
    const payloadB = makeSignedPayload(intent!, '0xsig-B');

    // Attach handlers to BOTH promises immediately (allSettled) so the loser's
    // rejection is never unhandled while the winner's pipeline drains.
    const [resA, resB] = await Promise.allSettled([
      secretariat.submitSignedPayment(created.requestId!, payloadA),
      secretariat.submitSignedPayment(created.requestId!, payloadB),
    ]);

    // Caller A wins the CAS; caller B must fail closed with a conflict.
    expect(resA.status).toBe('fulfilled');
    expect(resB.status).toBe('rejected');
    if (resB.status === 'rejected') {
      expect(String((resB.reason as Error)?.message)).toContain('PAYMENT_INTENT_AUTHORIZATION_CONFLICT');
    }
    const resultA = (resA as PromiseFulfilledResult<Awaited<ReturnType<typeof secretariat.submitSignedPayment>>>).value;
    expect(resultA.operationId).toBe(created.operationId);

    // The durable payload is A's — B's payload was NEVER bound.
    const after = await store.getPaymentIntentByOperationId(created.operationId!);
    expect(after!.paymentPayload).toBe(JSON.stringify(payloadA));
    expect(after!.paymentPayloadHash).toBe(sha16(JSON.stringify(payloadA)));
    expect(after!.settlementState).toBe('AUTHORIZED');

    // The CAS path was used; the blind pair was NOT.
    expect(store.authorizeCalls).toBe(2);
    expect(store.blindAuthorizationCalls).toBe(0);
    expect(store.blindStatusCalls).toBe(0);
    // Exactly one submission — the winner's.
    expect(settlementAdapter.submitCalls).toHaveLength(1);
  });

  it('regression probe: with the CAS unavailable the blind pair is used and the race overwrites (documents the old bug)', async () => {
    // Sanity pin: a store WITHOUT the CAS primitive still works through the
    // legacy path (backward compatibility), where the overwrite race exists
    // by construction — this is why the CAS is REQUIRED for production PG.
    const legacyStore = new RacingStageBStore();
    // Shadow the prototype method: typeof store.authorizePaymentIntent !== 'function'
    // forces the state machine onto the legacy blind pair.
    (legacyStore as unknown as Record<string, unknown>).authorizePaymentIntent = undefined;
    const legacySecretariat = new Secretariat({
      evidenceStore: legacyStore,
      signer: stageBSigner,
      adapters: new Map(),
      settlementAdapter,
    } as any);
    const created = await legacySecretariat.createRequest(makeStageBRequest('req-f108-legacy'));
    if (created.status !== 'AWAITING_PAYMENT_SIGNATURE') throw new Error('expected Stage A handoff');
    const intent = await legacyStore.getPaymentIntentByOperationId(created.operationId!);
    expect(intent).not.toBeNull();

    const result = await legacySecretariat.submitSignedPayment(created.requestId!, makeSignedPayload(intent!, '0xsig-legacy'));
    expect(result.operationId).toBe(created.operationId);
    expect(legacyStore.blindAuthorizationCalls).toBe(1);
    expect(legacyStore.blindStatusCalls).toBe(1);
    expect((await legacyStore.getPaymentIntentByOperationId(created.operationId!))!.settlementState).toBe('AUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Part C — auto (custodial) flow: F-109 atomic authorization
// ---------------------------------------------------------------------------

const autoSigner: PaymentSigner = {
  signerType: 'TEST',
  async getAddress() { return '0xTestPayer'; },
  async signPayment(request: { operationId: string; payer: string; nonce: string }) {
    return {
      operationId: request.operationId,
      payer: request.payer,
      nonce: request.nonce,
      signature: '0xauto-signature-' + request.nonce.slice(0, 8),
      signedAt: new Date().toISOString(),
    };
  },
} as unknown as PaymentSigner;

describe('F-109: auto flow authorization atomicity', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(MOCK_X402_CHALLENGE), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  function buildAutoHarness() {
    const store = new RacingStageBStore();
    const settlementAdapter = new RecordingSettlementAdapter();
    const legacyAdapter: PaymentAdapter = {
      network: 'base-sepolia',
      // canonicalV2 keeps using the network adapter for createAuthorization;
      // only submission goes through the SettlementAdapter.
      async createAuthorization(_req: PaymentRequirement, _signer: PaymentSigner, ctx: SigningContext): Promise<PaymentAuthorization> {
        return {
          signature: '0xauto-signature-' + ctx.nonce!.slice(2, 10),
          scheme: 'exact',
          timestamp: Date.now(),
          context: ctx,
        };
      },
      async submit(): Promise<PaymentSubmissionResult> { throw new Error('not used'); },
      async observeSettlement(): Promise<SettlementObservation> { throw new Error('not used'); },
    };
    const secretariat = new Secretariat({
      evidenceStore: store,
      signer: autoSigner,
      adapters: new Map([['base-sepolia', legacyAdapter]]),
      settlementAdapter,
    } as any);
    return { store, settlementAdapter, secretariat };
  }

  it('the intent is born PENDING_SIGNATURE and flips to AUTHORIZED in ONE atomic CAS', async () => {
    const { store, settlementAdapter, secretariat } = buildAutoHarness();

    const result = await secretariat.execute(makeStageBRequest('req-f109-auto'));

    expect(result.operationId).toBeDefined();
    expect(settlementAdapter.submitCalls).toHaveLength(1);

    // F-109 core pin: the DPI is NO LONGER born AUTHORIZED with an unsigned
    // SIGNING placeholder — create-time state is PENDING_SIGNATURE, and the
    // single CAS binds payload + AUTHORIZED atomically.
    expect(store.blindAuthorizationCalls).toBe(0);
    expect(store.blindStatusCalls).toBe(0);
    expect(store.authorizeCalls).toBe(1);

    const after = await store.getPaymentIntentByOperationId(result.operationId);
    expect(after).not.toBeNull();
    expect(after!.settlementState).toBe('AUTHORIZED');
    expect(after!.paymentPayload).not.toContain('SIGNING');
    expect(JSON.parse(after!.paymentPayload!).payload.signature).toBe(settlementAdapter.submitCalls[0].payload.payload.signature);
  });

  it('a lost signing race keeps the DURABLE payload and records PAYMENT_AUTHORIZATION_CAS_LOSS', async () => {
    const { store, settlementAdapter, secretariat } = buildAutoHarness();

    // Simulate a concurrent winner: create the operation via Stage A, then
    // advance the intent to AUTHORIZED with a DIFFERENT payload before the
    // signing attempt of this call lands.
    const created = await secretariat.createRequest(makeStageBRequest('req-f109-race'));
    if (created.status !== 'AWAITING_PAYMENT_SIGNATURE') throw new Error('expected Stage A handoff');
    const intent = await store.getPaymentIntentByOperationId(created.operationId!);
    expect(intent).not.toBeNull();

    const winnerPayload = makeSignedPayload(intent!, '0xwinner-signature');
    await store.authorizePaymentIntent(intent!.paymentIntentId, {
      paymentPayload: JSON.stringify(winnerPayload),
      paymentPayloadHash: sha16(JSON.stringify(winnerPayload)),
    }, 'PENDING_SIGNATURE');

    const result = await secretariat.execute(makeStageBRequest('req-f109-race'));

    // No throw; the winner's payload survived byte-for-byte; the submission
    // rode the SAME EIP-3009 authorization binding (unique op → same nonce).
    const after = await store.getPaymentIntentByOperationId(created.operationId!);
    expect(after!.paymentPayload).toBe(JSON.stringify(winnerPayload));
    expect(settlementAdapter.submitCalls).toHaveLength(1);
    expect(settlementAdapter.submitCalls[0].payload.payload.authorization.nonce).toBe(
      winnerPayload.payload.authorization.nonce,
    );
    expect(result.operationId).toBe(created.operationId);
  });
});
