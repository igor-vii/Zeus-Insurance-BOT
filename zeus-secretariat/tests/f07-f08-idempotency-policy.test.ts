/**
 * Block-2 regression tests (external audit 2026-10-25):
 * idempotency, money policy, SQL field preservation.
 *
 * F-07 — a clientId-derived logical id (`cid:${clientId}`) may resolve to the
 *        SAME operation only for the SAME paid contract (target/method). A
 *        different request from the same requestId-less client is a client
 *        bug → REQUEST_COLLISION, never silent reuse.
 * F-08 — maxPrice is money: invalid formats REJECT the policy (no NaN
 *        no-op), decimal comparisons are exact scaled-BigInt (no float),
 *        mixed-unit (smallest-unit integer vs human decimal) comparisons are
 *        rejected as INCOMPARABLE_UNITS instead of silently compared.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Secretariat } from '../src/core/state-machine';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store';
import { MockPaymentAdapter } from '../src/adapters';
import { PaymentSigner, SigningContext, PaymentRequirement, PaymentAuthorization } from '../src/core/types';

class MockSigner implements PaymentSigner {
  async getAddress(): Promise<string> {
    return '0xTestPayer';
  }
  async signPayment(_requirement: PaymentRequirement, _context: SigningContext): Promise<PaymentAuthorization> {
    return {
      signature: '0xmocksig',
      scheme: 'exact',
      timestamp: Date.now(),
      context: { operationId: _context.operationId, requirement: _requirement, nonce: _context.nonce },
      authorizer: '0xTestPayer',
      payTo: _requirement.payee,
      value: _requirement.amount,
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 300,
    } as unknown as PaymentAuthorization;
  }
}

function x402Challenge(amount: string): string {
  return btoa(JSON.stringify({
    accepts: [
      { scheme: 'mock', network: 'mock-network', asset: 'MOCK', amount, payTo: 'seller123' },
    ],
  }));
}

function paid402Response(amount: string) {
  return {
    status: 402,
    ok: false,
    json: async () => { throw new Error('no JSON body'); },
    headers: {
      get: (name: string) => (name === 'PAYMENT-REQUIRED' ? x402Challenge(amount) : null),
      entries: () => [] as [string, string][],
    },
  };
}

function makeSecretariat(store: InMemoryEvidenceStore): Secretariat {
  return new Secretariat({
    evidenceStore: store,
    signer: new MockSigner(),
    adapters: new Map([['mock-network', new MockPaymentAdapter({ network: 'mock-network', simulateSettlement: true, settlementDelay: 0, failProbability: 0 })]]),
    settlementAdapter: { async submit() { return { status: 'SUBMITTED' as const, txHash: '0xmocktx' }; } } as any,
    reconciliationEngine: {
      async reconcile() { return { status: 'SETTLED', evidence: { txHash: '0xmocktx' } }; },
      async persistObservation() {}, async scheduleNextProbe() {},
    } as any,
    atomicSettlementHandoff: { async settleAndCreateExecutionObligation() { return true; } } as any,
  });
}

describe('F-07: clientId-derived logical id cannot silently serve a DIFFERENT request', () => {
  let store: InMemoryEvidenceStore;
  let secretariat: Secretariat;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    store = new InMemoryEvidenceStore();
    secretariat = makeSecretariat(store);
    originalFetch = globalThis.fetch;
  });

  const policy = {
    maxPrice: '10.0',
    allowedNetworks: ['mock-network'],
    allowedAssets: ['MOCK'],
    authorizationMode: 'policy-bound' as const,
  };

  it('same clientId + no requestId + DIFFERENT target → REQUEST_COLLISION (not silent reuse)', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(paid402Response('0.5'));
    try {
      await secretariat.execute({
        target: 'https://seller-a.example/resource',
        method: 'POST',
        clientId: 'agent-1',
        policy,
      } as any);

      // Second, genuinely different request from the same client, still
      // without requestId: must NOT collapse into the first operation.
      await expect(
        secretariat.execute({
          target: 'https://seller-b.example/other',
          method: 'POST',
          clientId: 'agent-1',
          policy,
        } as any),
      ).rejects.toThrow(/REQUEST_COLLISION/);

      // Same for a method change on the same target.
      await expect(
        secretariat.execute({
          target: 'https://seller-a.example/resource',
          method: 'DELETE',
          clientId: 'agent-1',
          policy,
        } as any),
      ).rejects.toThrow(/REQUEST_COLLISION/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retry of the SAME contract (target/method) stays idempotent (B8-001 preserved)', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(paid402Response('0.5'));
    try {
      const first = await secretariat.execute({
        target: 'https://seller-a.example/resource',
        method: 'POST',
        clientId: 'agent-2',
        policy,
      } as any);
      const second = await secretariat.execute({
        target: 'https://seller-a.example/resource/',
        method: 'post', // case + trailing slash normalization
        clientId: 'agent-2',
        policy,
      } as any);
      expect((second as any).operationId).toBe((first as any).operationId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('explicit requestIds keep different logical requests separate (contract unchanged)', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(paid402Response('0.5'));
    try {
      const first = await secretariat.execute({
        target: 'https://seller-a.example/resource',
        method: 'POST',
        clientId: 'agent-3',
        requestId: 'req-3a',
        policy,
      } as any);
      const second = await secretariat.execute({
        target: 'https://seller-b.example/other',
        method: 'POST',
        clientId: 'agent-3',
        requestId: 'req-3b',
        policy,
      } as any);
      expect((second as any).operationId).not.toBe((first as any).operationId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('F-08: maxPrice policy comparison is exact and fail-closed', () => {
  let store: InMemoryEvidenceStore;
  let secretariat: Secretariat;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    store = new InMemoryEvidenceStore();
    secretariat = makeSecretariat(store);
    originalFetch = globalThis.fetch;
  });

  async function runAgainst(amount: string, maxPrice: string): Promise<{ policyRejected: boolean; rejectedReason?: string; policyPassed: boolean }> {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(paid402Response(amount));
    try {
      const result = await secretariat.execute({
        target: `https://seller.example/resource-${amount}-${maxPrice}`,
        method: 'POST',
        clientId: `client-${amount}-${maxPrice}`,
        policy: {
          maxPrice,
          allowedNetworks: ['mock-network'],
          allowedAssets: ['MOCK'],
          authorizationMode: 'policy-bound',
        },
      } as any);
      const evidence = ((result as any).evidence ?? []) as Array<{ event: string; payload?: any }>;
      const rejected = evidence.find((e) => e.event === 'POLICY_REJECTED');
      const passed = evidence.some((e) => e.event === 'POLICY_VALIDATION_PASSED');
      return { policyRejected: Boolean(rejected), rejectedReason: rejected?.payload?.reason, policyPassed: passed };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('decimal vs decimal: 0.9 <= 1.0 passes; 1.5 > 1.0 rejects (exact, no float)', async () => {
    const pass = await runAgainst('0.9', '1.0');
    expect(pass.policyPassed).toBe(true);
    expect(pass.policyRejected).toBe(false);

    const reject = await runAgainst('1.5', '1.0');
    expect(reject.policyRejected).toBe(true);
    expect(reject.rejectedReason).toMatch(/exceeds maxPrice/);
  });

  it('integer smallest-units vs integer limit: exact BigInt comparison', async () => {
    const pass = await runAgainst('500000', '1000000');
    expect(pass.policyPassed).toBe(true);
    expect(pass.policyRejected).toBe(false);

    const reject = await runAgainst('1000001', '1000000');
    expect(reject.policyRejected).toBe(true);
    expect(reject.rejectedReason).toMatch(/exceeds maxPrice/);
  });

  it('mixed units (integer amount vs decimal maxPrice) → INCOMPARABLE_UNITS, fail closed', async () => {
    const result = await runAgainst('500000', '1.0');
    expect(result.policyRejected).toBe(true);
    expect(result.rejectedReason).toMatch(/INCOMPARABLE_UNITS/);
  });

  it('malformed maxPrice ("abc", "1.2.3") → policy rejected, never a silent pass', async () => {
    for (const bad of ['abc', '1.2.3', '', '1e9']) {
      const result = await runAgainst('0.1', bad);
      expect(result.policyRejected).toBe(true);
      expect(result.rejectedReason).toMatch(/Invalid maxPrice format/);
    }
  });

  it('precision beyond float64: 0.1+0.2-style traps compare exactly', async () => {
    // 10000000000000000.01 > 10000000000000000.00 — indistinguishable in float64.
    const reject = await runAgainst('10000000000000000.01', '10000000000000000.00');
    expect(reject.policyRejected).toBe(true);
    expect(reject.rejectedReason).toMatch(/exceeds maxPrice/);

    const pass = await runAgainst('10000000000000000.00', '10000000000000000.01');
    expect(pass.policyPassed).toBe(true);
    expect(pass.policyRejected).toBe(false);
  });
});
