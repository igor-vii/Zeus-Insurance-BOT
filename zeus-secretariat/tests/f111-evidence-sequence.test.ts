/**
 * F-111 regression tests (external audit 2026-10-26, Minor).
 *
 * EvidenceRecord.sequence (Repair C3) was assigned by the state machine's
 * recordEvidence() only. The two remaining producers appended UNSEQUENCED
 * records:
 *   - ExecutionFeedbackService.pushEvidence()       (STATE_TRANSITION, …)
 *   - PostSettlementEngine.appendEvidence()         (EXECUTION_*, RETRIEVAL_*)
 * which degraded both the durable identity (payload-hash fallback) and the
 * chronological ordering in PostgresEvidenceStore.getEvidence(), and made the
 * retrieval dedup key (`t<ts>|phase|event`) able to DROP a distinct record
 * sharing event+millisecond with another. Both producers now assign the same
 * per-operation sequence, and the PG retrieval keys records by the FULL
 * record-derived identity (live-PG variant on the PG stand).
 */

import { describe, it, expect } from '@jest/globals';
import { ExecutionFeedbackService } from '../src/core/execution-feedback-service';
import { PostSettlementEngine } from '../src/core/post-settlement-engine';
import type {
  DurablePaymentIntent,
  EvidenceRecord,
  Operation,
  PostSettlementConfig,
} from '../src/core/types';

describe('F-111: evidence producers assign a per-operation sequence', () => {
  it('ExecutionFeedbackService evidence is sequenced consecutively from the operation tail', async () => {
    const operations = new Map<string, Operation>();
    const op: Operation = {
      operationId: 'op-f111-feedback',
      requestId: 'req-f111-feedback',
      clientId: 'client-f111',
      target: 'https://seller.example.com/api',
      method: 'GET',
      paymentState: 'SETTLED',
      executionState: 'NOT_STARTED',
      deliveryState: 'NOT_STARTED',
      currentState: 'SETTLED',
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      // Pre-existing durable history tail: next sequence must continue from here.
      evidence: [
        {
          operationId: 'op-f111-feedback',
          phase: 'SETTLEMENT',
          timestamp: Date.now() - 1000,
          event: 'SETTLEMENT_CONFIRMED',
          payload: {},
          sequence: 0,
        },
      ],
    };
    operations.set(op.operationId, op);
    const svc = new ExecutionFeedbackService({
      getOperation: async (id) => operations.get(id) ?? null,
      saveOperation: async (o) => { operations.set(o.operationId, { ...o }); },
    });

    await svc.applyResult('op-f111-feedback', 'SUCCESS', { jobId: 'job-f111' });

    const stored = operations.get('op-f111-feedback')!;
    const pushed = stored.evidence.filter(e => e.event === 'STATE_TRANSITION');
    expect(pushed.length).toBe(4);
    pushed.forEach((rec, idx) => {
      expect(typeof rec.sequence).toBe('number');
      expect(rec.sequence).toBe(1 + idx); // continues the durable tail (0-based, next = 1)
    });
  });

  it('PostSettlementEngine.appendEvidence derives the next sequence from the durable evidence view', async () => {
    const appended: EvidenceRecord[] = [];
    const durableTail: EvidenceRecord[] = [
      { operationId: 'op-f111-engine', phase: 'PAYMENT', timestamp: 1, event: 'PAYMENT_SUBMITTED', payload: {}, sequence: 0 },
      { operationId: 'op-f111-engine', phase: 'SETTLEMENT', timestamp: 2, event: 'SETTLEMENT_CONFIRMED', payload: {}, sequence: 1 },
      { operationId: 'op-f111-engine', phase: 'SETTLEMENT', timestamp: 3, event: 'RECONCILIATION_SKIPPED', payload: {}, sequence: 2 },
    ];
    const paymentStore = {
      append: async (record: EvidenceRecord) => { appended.push(record); },
      getEvidence: async (operationId: string) =>
        [...durableTail, ...appended.filter(r => r.operationId === operationId)],
    } as unknown as import('../src/core/types').DurableEvidenceStore;

    const engine = new PostSettlementEngine(
      paymentStore,
      { saveAttempt: async () => {}, saveAttemptWithJob: async () => ({ jobId: 'j', attemptId: 'a' }) } as any,
      {} as any,
      { workerId: 'worker-f111' } as PostSettlementConfig,
    );

    await (engine as unknown as { appendEvidence: (op: string, ev: string, p: unknown) => Promise<void> })
      .appendEvidence('op-f111-engine', 'EXECUTION_INITIATED', { attemptId: 'a-1' });

    expect(appended).toHaveLength(1);
    expect(appended[0].sequence).toBe(3); // durable tail length — no gap, no collision

    // A second append continues the sequence using its own prior append.
    await (engine as unknown as { appendEvidence: (op: string, ev: string, p: unknown) => Promise<void> })
      .appendEvidence('op-f111-engine', 'EXECUTION_SUCCESS', { attemptId: 'a-1' });
    expect(appended[1].sequence).toBe(4);
  });

  it('appendEvidence degrades gracefully: a failing evidence read still appends (unsequenced)', async () => {
    const appended: EvidenceRecord[] = [];
    const paymentStore = {
      append: async (record: EvidenceRecord) => { appended.push(record); },
      getEvidence: async () => { throw new Error('PG unreachable'); },
    } as unknown as import('../src/core/types').DurableEvidenceStore;

    const engine = new PostSettlementEngine(
      paymentStore,
      { saveAttempt: async () => {}, saveAttemptWithJob: async () => ({ jobId: 'j', attemptId: 'a' }) } as any,
      {} as any,
      { workerId: 'worker-f111' } as PostSettlementConfig,
    );

    await (engine as unknown as { appendEvidence: (op: string, ev: string, p: unknown) => Promise<void> })
      .appendEvidence('op-f111-degraded', 'EXECUTION_HTTP_FAILURE', { statusCode: 503 });

    expect(appended).toHaveLength(1);
    expect(appended[0].sequence).toBeUndefined(); // legacy identity fallback, append NOT blocked
  });
});
