/**
 * F-110 regression tests (external audit 2026-10-26, Minor).
 *
 * execution-feedback-service.ts used to carry a HAND-MIRRORED copy of the
 * Operation FSM's execution-relevant edges (ALLOWED_EDGES, comment: "mirrors
 * VALID_TRANSITIONS in state-machine.ts"). Hand-mirrors drift silently when
 * the authoritative table changes. Both modules now import the single source
 * of truth from operation-fsm.ts.
 */

import { describe, it, expect } from '@jest/globals';
import {
  VALID_TRANSITIONS as FSM_TABLE,
  isValidTransition as fsmIsValid,
} from '../src/core/operation-fsm';
import {
  VALID_TRANSITIONS as FSM_TABLE_VIA_STATE_MACHINE,
  isValidTransition as fsmIsValidViaStateMachine,
} from '../src/core/state-machine';
import {
  ExecutionFeedbackService,
  planExecutionTransitions,
} from '../src/core/execution-feedback-service';
import type { Operation, OperationStatus } from '../src/core/types';

describe('F-110: single-source FSM table', () => {
  it('state-machine.ts re-exports the SAME table object as operation-fsm.ts', () => {
    // Re-export must be a pass-through of the single source, not another copy.
    expect(FSM_TABLE_VIA_STATE_MACHINE).toBe(FSM_TABLE);
    expect(fsmIsValidViaStateMachine).toBe(fsmIsValid);
  });

  it('table sanity: terminal states are sinks, execution chain is intact', () => {
    for (const terminal of ['SUCCESS', 'FAILED', 'POLICY_REJECTED', 'RECOVERED', 'UNRESOLVABLE'] as OperationStatus[]) {
      expect(FSM_TABLE[terminal]).toEqual([]);
    }
    expect(fsmIsValid('SETTLED', 'EXECUTION_PENDING')).toBe(true);
    expect(fsmIsValid('EXECUTION_PENDING', 'EXECUTION_CONFIRMED')).toBe(true);
    expect(fsmIsValid('EXECUTION_CONFIRMED', 'DELIVERED')).toBe(true);
    expect(fsmIsValid('DELIVERED', 'SUCCESS')).toBe(true);
    // The edge the old mirror comment called out: NO EXECUTION_UNKNOWN→UNRESOLVABLE.
    expect(fsmIsValid('EXECUTION_UNKNOWN', 'UNRESOLVABLE')).toBe(false);
    expect(fsmIsValid('EXECUTION_UNKNOWN', 'RECOVERY_PENDING')).toBe(true);
  });

  it('feedback path applies transitions through the AUTHORITATIVE table (happy chain)', async () => {
    const operations = new Map<string, Operation>();
    const op: Operation = {
      operationId: 'op-f110-happy',
      requestId: 'req-f110-happy',
      clientId: 'client-f110',
      target: 'https://seller.example.com/api',
      method: 'GET',
      paymentState: 'SETTLED',
      executionState: 'NOT_STARTED',
      deliveryState: 'NOT_STARTED',
      currentState: 'SETTLED',
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      evidence: [],
    };
    operations.set(op.operationId, op);
    const svc = new ExecutionFeedbackService({
      getOperation: async (id) => operations.get(id) ?? null,
      saveOperation: async (o) => { operations.set(o.operationId, { ...o }); },
    });

    const outcome = await svc.applyResult('op-f110-happy', 'SUCCESS', { jobId: 'job-1' });

    expect(outcome.applied).toBe(true);
    expect(outcome.currentState).toBe('SUCCESS');
    const stored = operations.get('op-f110-happy')!;
    const transitions = stored.evidence.filter(e => e.event === 'STATE_TRANSITION');
    expect(transitions.map(t => (t.payload as any).to)).toEqual(
      ['EXECUTION_PENDING', 'EXECUTION_CONFIRMED', 'DELIVERED', 'SUCCESS'],
    );
  });

  it('feedback path honestly SKIPS edges absent from the authoritative FSM (no fabricated edges)', async () => {
    const operations = new Map<string, Operation>();
    const op: Operation = {
      operationId: 'op-f110-skip',
      requestId: 'req-f110-skip',
      clientId: 'client-f110',
      target: 'https://seller.example.com/api',
      method: 'GET',
      paymentState: 'SETTLED',
      executionState: 'UNKNOWN',
      deliveryState: 'UNKNOWN',
      currentState: 'EXECUTION_UNKNOWN',
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      evidence: [],
    };
    operations.set(op.operationId, op);
    const svc = new ExecutionFeedbackService({
      getOperation: async (id) => operations.get(id) ?? null,
      saveOperation: async (o) => { operations.set(o.operationId, { ...o }); },
    });

    // UNRESOLVABLE plans stop at EXECUTION_UNKNOWN: the FSM has no
    // EXECUTION_UNKNOWN→UNRESOLVABLE edge, and the feedback path must NOT
    // fabricate one — it records EXECUTION_FEEDBACK_SKIPPED instead.
    const plan = planExecutionTransitions('UNRESOLVABLE');
    expect(plan).not.toContain('UNRESOLVABLE');

    const outcome = await svc.applyResult('op-f110-skip', 'UNRESOLVABLE', { jobId: 'job-2' });

    expect(outcome.applied).toBe(false);
    expect(outcome.currentState).toBe('EXECUTION_UNKNOWN');
    const skipped = operations.get('op-f110-skip')!.evidence.find(e => e.event === 'EXECUTION_FEEDBACK_SKIPPED');
    expect(skipped).toBeDefined();
  });
});
