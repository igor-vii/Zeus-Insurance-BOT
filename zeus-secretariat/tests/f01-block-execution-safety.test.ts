/**
 * Block-1 regression tests (external audit 2026-10-25): execution safety.
 *
 * F-01 — the atomic settlement→execution handoff must carry the PAID
 *        target/method/payload, the DISCOVERED recovery capability
 *        (fail-closed to NONE) and the configured attempt bound.
 * F-02 — a successful result retrieval resolves DELIVERY_UNKNOWN → SUCCESS
 *        atomically with the job closure, fenced to the retrieval job.
 * F-03 — an outcome whose authoritative write was rejected is NEVER reported
 *        as success.
 * F-04 — attempt mutations are fenced to the SPECIFIC recovery job (jobId),
 *        not merely to the operation.
 * F-06 — the retrieval HTTP-404 observation loop is bounded by maxAttempts
 *        and ends in an explicit UNRESOLVABLE decision.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Secretariat } from '../src/core/state-machine';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store';
import { MockPaymentAdapter } from '../src/adapters';
import {
  PostSettlementEngine,
  InMemoryExecutionStore,
  type RecoveryJob,
  type ExecutionAttempt,
} from '../src/core/post-settlement-engine';
import { MockSellerExecutionAdapter } from '../src/adapters/seller-execution-adapter';
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
  return btoa(
    JSON.stringify({
      accepts: [
        { scheme: 'mock', network: 'mock-network', asset: 'MOCK', amount, payTo: 'seller123' },
      ],
    }),
  );
}

function paid402Response(opts: { recoveryCapability?: string } = {}) {
  return {
    status: 402,
    ok: false,
    json: async () => { throw new Error('no JSON body'); },
    headers: {
      get: (name: string) => {
        if (name === 'PAYMENT-REQUIRED') return x402Challenge('0.5');
        if (name === 'X-Recovery-Capability') return opts.recoveryCapability ?? null;
        return null;
      },
      entries: () => [] as [string, string][],
    },
  };
}

describe('F-01: atomic handoff carries paid target/method/payload, discovered capability, configured bound', () => {
  let store: InMemoryEvidenceStore;
  let captured: { job?: RecoveryJob; attempt?: ExecutionAttempt };

  beforeEach(() => {
    store = new InMemoryEvidenceStore();
    captured = {};
  });

  async function runExecute(opts: { maxExecutionAttempts?: number; recoveryCapability?: string }) {
    const executionStore = new InMemoryExecutionStore();
    const handoff = {
      async settleAndCreateExecutionObligation(
        _paymentIntentId: string,
        _operationId: string,
        _evidence: unknown,
        job: RecoveryJob,
        attempt: ExecutionAttempt,
      ): Promise<boolean> {
        captured.job = job;
        captured.attempt = attempt;
        await executionStore.saveJob(job);
        await executionStore.saveAttempt(attempt);
        return true;
      },
    };
    const secretariat = new Secretariat({
      evidenceStore: store,
      signer: new MockSigner(),
      adapters: new Map([['mock-network', new MockPaymentAdapter({ network: 'mock-network', simulateSettlement: true, settlementDelay: 0, failProbability: 0 })]]),
      settlementAdapter: { async submit() { return { status: 'SUBMITTED' as const, txHash: '0xmocktx' }; } } as any,
      reconciliationEngine: {
        async reconcile() { return { status: 'SETTLED', evidence: { txHash: '0xmocktx' } }; },
        async persistObservation() {}, async scheduleNextProbe() {},
      } as any,
      atomicSettlementHandoff: handoff as any,
      maxExecutionAttempts: opts.maxExecutionAttempts,
    });

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = jest.fn().mockResolvedValue(paid402Response({ recoveryCapability: opts.recoveryCapability }));
    try {
      const request = {
        target: 'https://paid-seller.example/api/resource',
        method: 'PUT',
        payload: { qty: 42 },
        clientId: 'client-f01',
        requestId: `req-f01-${opts.recoveryCapability ?? 'none'}-${opts.maxExecutionAttempts ?? 'default'}`,
        policy: { maxPrice: '1.0', allowedNetworks: ['mock-network'], allowedAssets: ['MOCK'], authorizationMode: 'policy-bound' as const },
      };
      return await secretariat.execute(request as any);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('attempt hits the paid target/method/payload — not config fallbacks', async () => {
    await runExecute({ recoveryCapability: 'EXECUTION_IDEMPOTENT' });
    expect(captured.attempt).toBeDefined();
    expect(captured.attempt!.requestUrl).toBe('https://paid-seller.example/api/resource');
    expect(captured.attempt!.requestMethod).toBe('PUT');
    expect(captured.attempt!.requestBody).toEqual({ qty: 42 });
    // F-01 №2: the DISCOVERED capability is carried through, not hardcoded.
    expect((captured.job!.metadata as any).capability).toBe('EXECUTION_IDEMPOTENT');
  });

  it('fail-closed: without a discovered capability the recovery capability is NONE', async () => {
    await runExecute({});
    expect((captured.job!.metadata as any).capability).toBe('NONE');
  });

  it('job bound honors the configured maxExecutionAttempts (no hardcoded 3)', async () => {
    await runExecute({ maxExecutionAttempts: 7 });
    expect(captured.job!.maxAttempts).toBe(7);
    await runExecute({ maxExecutionAttempts: 2 });
    expect(captured.job!.maxAttempts).toBe(2);
  });
});

describe('F-02: retrieval success atomically resolves DELIVERY_UNKNOWN → SUCCESS', () => {
  function makeEngineWithRetrieval(sellerBehavior: { forceStatusCode: number }) {
    const executionStore = new InMemoryExecutionStore();
    const seller = new MockSellerExecutionAdapter();
    seller.setBehavior({ forceStatusCode: sellerBehavior.forceStatusCode, responseBody: { result: 'ok' } });
    const engine = new PostSettlementEngine(
      { append: async () => {}, getOperation: async () => null } as any,
      executionStore,
      seller,
      { workerId: 'test', sellerUrl: 'https://seller.example', sellerMethod: 'POST' },
    );
    return { executionStore, engine };
  }

  async function seedRetrievalScenario(executionStore: InMemoryExecutionStore) {
    const attempt: ExecutionAttempt = {
      attemptId: 'att-f02', operationId: 'op-f02', executionId: 'op-f02',
      attemptNumber: 1, status: 'DELIVERY_UNKNOWN',
      requestUrl: 'https://paid-seller.example/api/resource', requestMethod: 'POST',
      idempotencyKey: 'op-f02', createdAt: Date.now(),
    };
    await executionStore.saveAttempt(attempt);
    const job: RecoveryJob = {
      jobId: 'job-f02', operationId: 'op-f02', jobType: 'RETRIEVAL', status: 'PENDING',
      priority: 1, maxAttempts: 3, currentAttempt: 0,
      metadata: { capability: 'RESULT_RETRIEVAL', originalJobId: 'job-exec-f02' },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await executionStore.saveJob(job);
    return { attempt, job };
  }

  it('SUCCESS retrieval: attempt → SUCCESS and job → COMPLETED in one step', async () => {
    const { executionStore, engine } = makeEngineWithRetrieval({ forceStatusCode: 200 });
    const { job } = await seedRetrievalScenario(executionStore);

    const outcome = await engine.processJob(job.jobId);
    expect(outcome.success).toBe(true);
    expect(outcome.finalStatus).toBe('SUCCESS');

    const attemptAfter = await executionStore.getAttemptById('att-f02');
    expect(attemptAfter!.status).toBe('SUCCESS');
    const jobAfter = await executionStore.getJob('job-f02');
    expect(jobAfter!.status).toBe('COMPLETED');
  });

  it('REJECTED transition is never reported as success (F-02 + F-03)', async () => {
    const { executionStore, engine } = makeEngineWithRetrieval({ forceStatusCode: 200 });
    const { job } = await seedRetrievalScenario(executionStore);
    // Sabotage ONLY the atomic resolution: pretend the owning job lost the
    // fence (resolution rejected) while the seller DID return the result.
    (executionStore as any).resolveRetrievalSuccessIfOwner = async () => false;

    const outcome = await engine.processJob(job.jobId);
    expect(outcome.success).toBe(false);
    expect(outcome.finalStatus).toBe('RUNNING');
    // The job must NOT be closed as COMPLETED behind the rejection.
    const jobAfter = await executionStore.getJob('job-f02');
    expect(jobAfter!.status).not.toBe('COMPLETED');
  });
});

describe('F-06: retrieval 404 loop is bounded and ends UNRESOLVABLE', () => {
  it('requeues on 404 until maxAttempts, then closes UNRESOLVABLE', async () => {
    const executionStore = new InMemoryExecutionStore();
    const seller = new MockSellerExecutionAdapter();
    seller.setBehavior({ forceStatusCode: 404 });
    const engine = new PostSettlementEngine(
      { append: async () => {} } as any,
      executionStore,
      seller,
      { workerId: 'test', sellerUrl: 'https://seller.example', sellerMethod: 'POST' },
    );

    const attempt: ExecutionAttempt = {
      attemptId: 'att-f06', operationId: 'op-f06', executionId: 'op-f06',
      attemptNumber: 1, status: 'DELIVERY_UNKNOWN',
      requestUrl: 'https://paid-seller.example/api/resource', requestMethod: 'POST',
      idempotencyKey: 'op-f06', createdAt: Date.now(),
    };
    await executionStore.saveAttempt(attempt);
    const job: RecoveryJob = {
      jobId: 'job-f06', operationId: 'op-f06', jobType: 'RETRIEVAL', status: 'PENDING',
      priority: 1, maxAttempts: 3, currentAttempt: 0,
      metadata: { capability: 'RESULT_RETRIEVAL' },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await executionStore.saveJob(job);

    // Observation 1 and 2: 404 → requeue PENDING.
    const first = await engine.processJob(job.jobId);
    expect(first.finalStatus).toBe('DELIVERY_UNKNOWN');
    expect((await executionStore.getJob(job.jobId))!.status).toBe('PENDING');

    const second = await engine.processJob(job.jobId);
    expect(second.finalStatus).toBe('DELIVERY_UNKNOWN');

    // Observation 3 (maxAttempts reached): explicit UNRESOLVABLE — no more loops.
    const third = await engine.processJob(job.jobId);
    expect(third.finalStatus).toBe('UNRESOLVABLE');
    const jobAfter = await executionStore.getJob(job.jobId);
    expect(jobAfter!.status).toBe('UNRESOLVABLE');
  });
});

describe('F-03: no outcome may be published when the authoritative write is rejected', () => {
  it('executeAttempt throws ATTEMPT_PERSIST_REJECTED when the store rejects the write', async () => {
    const seller = new MockSellerExecutionAdapter();
    seller.setBehavior({ forceStatusCode: 200, responseBody: { done: true } });
    const rejectingStore = {
      getAttemptById: async () => ({
        attemptId: 'att', operationId: 'op', executionId: 'op', attemptNumber: 1,
        status: 'PENDING', idempotencyKey: 'op', createdAt: Date.now(),
      }),
      markAttemptInProgress: async () => true,
      updateAttemptStatus: async () => false, // fence lost / terminal
      } as any;
    const engine = new PostSettlementEngine(
      { append: async () => {} } as any,
      rejectingStore,
      seller,
      { workerId: 'test', sellerUrl: 'https://seller.example', sellerMethod: 'POST' },
    );

    await expect(engine.executeAttempt('att', 1, 'job')).rejects.toThrow('ATTEMPT_PERSIST_REJECTED');
  });

  it('processJob does not report SUCCESS when the job write is rejected', async () => {
    const executionStore = new InMemoryExecutionStore();
    const seller = new MockSellerExecutionAdapter();
    seller.setBehavior({ forceStatusCode: 200, responseBody: { done: true } });
    const engine = new PostSettlementEngine(
      { append: async () => {} } as any,
      executionStore,
      seller,
      { workerId: 'test', sellerUrl: 'https://seller.example', sellerMethod: 'POST' },
    );

    const attempt: ExecutionAttempt = {
      attemptId: 'att-f03', operationId: 'op-f03', executionId: 'op-f03',
      attemptNumber: 1, status: 'PENDING', requestUrl: 'https://seller.example/x',
      requestMethod: 'POST', idempotencyKey: 'op-f03', createdAt: Date.now(),
    };
    await executionStore.saveAttempt(attempt);
    const job: RecoveryJob = {
      jobId: 'job-f03', operationId: 'op-f03', jobType: 'EXECUTION', status: 'PENDING',
      priority: 0, maxAttempts: 3, currentAttempt: 0,
      metadata: { capability: 'EXECUTION_IDEMPOTENT' },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await executionStore.saveJob(job);

    // Sabotage ONLY the job closure: the attempt write and the seller call
    // succeed, but the fenced job closure is rejected.
    (executionStore as any).updateJobStatus = async () => false;

    const outcome = await engine.processJob('job-f03');
    // The seller call succeeded, but the closure was rejected → NO success.
    expect(outcome.success).toBe(false);
    expect(outcome.finalStatus).toBe('RUNNING');
  });
});

describe('F-04: attempt mutations are fenced to the specific jobId', () => {
  it('a fence from job A does not authorize a mutation bound to job B', async () => {
    const executionStore = new InMemoryExecutionStore();
    const attempt: ExecutionAttempt = {
      attemptId: 'att-f04', operationId: 'op-f04', executionId: 'op-f04',
      attemptNumber: 1, status: 'PENDING', idempotencyKey: 'op-f04', createdAt: Date.now(),
    };
    await executionStore.saveAttempt(attempt);
    const jobA: RecoveryJob = {
      jobId: 'job-A', operationId: 'op-f04', jobType: 'EXECUTION', status: 'RUNNING',
      priority: 0, maxAttempts: 3, currentAttempt: 5, createdAt: Date.now(), updatedAt: Date.now(),
    };
    const jobB: RecoveryJob = {
      jobId: 'job-B', operationId: 'op-f04', jobType: 'RETRIEVAL', status: 'RUNNING',
      priority: 1, maxAttempts: 3, currentAttempt: 2, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await executionStore.saveJob(jobA);
    await executionStore.saveJob(jobB);

    // Fence 5 belongs to job A: bound to B → rejected.
    await expect(
      executionStore.updateAttemptStatus('att-f04', 'HTTP_FAILURE', 5, { errorReason: 'x' }, 'job-B'),
    ).resolves.toBe(false);
    // Bound to A (the actual owner of generation 5) → accepted.
    await expect(
      executionStore.updateAttemptStatus('att-f04', 'ATTEMPTED', 5, undefined, 'job-A'),
    ).resolves.toBe(true);
  });
});
