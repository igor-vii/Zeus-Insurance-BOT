import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S3_CrashAfterSettlement: ScenarioDefinition = {
  id: 'S3',
  name: 'Crash After Settlement',
  description: 'Test subject падает и перезапускается сразу после payment_settled',

  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    {
      // Block A correction (per-scenario roles): resource-server-1 отдаёт
      // protected resource (delivery_sent / delivery_completed) →
      // RESOURCE_SERVER. Отсутствие своего HTTP endpoint —
      // техническое ограничение wiring, не отсутствие роли.
      // Rationale см. S1.
      participantId: 'resource-server-1',
      protocolRole: 'RESOURCE_SERVER',
      ownership: 'ARGUS', // см. rationale в S1
    },
    { participantId: 'sut-1', protocolRole: 'FACILITATOR', ownership: 'EXTERNAL' },
  ],

  topology: {
    edges: [
      { from: 'client-1', to: 'sut-1', kind: 'request' },
      { from: 'sut-1', to: 'resource-server-1', kind: 'forward' },
    ],
  },

  testSubject: 'sut-1',

  actions: [
    {
      actor: 'client-1',
      type: 'request_payment',
      payload: { requestId: 'req-3', idempotencyKey: 'key-3', amount: 100 },
    },
  ],

  faults: [
    {
      target: { kind: 'infrastructure', component: 'testSubject' },
      type: 'crash',
      trigger: 'payment_settled',
      config: { restart_after_ms: 2000 },
    },
  ],

  invariants: [
    {
      id: 'no_double_settlement_after_crash',
      description: 'После crash+restart ровно один settlement на операцию. Retry к seller возобновляется после restart, повторная оплата не создаётся.',
    },
  ],

  assertions: [
    {
      // Reference: S3 assertion — пример корректного применения kind: 'mixed'.
      // Evidence используется и от sut-1 (payment_settled) — behavioral часть,
      // и от engine (recovery_completed, forward_request) — engine-behavior часть.
      id: 'assert_single_settlement_survives_crash',
      invariantId: 'no_double_settlement_after_crash',
      kind: 'mixed',
      referencedSources: ['sut-1', 'engine'],
      evaluate: (evidence) => {
        const settlements = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'payment_settled'
        );
        if (settlements.length === 0) {
          return { status: 'INCONCLUSIVE', reason: 'no settlement observed yet' };
        }
        if (settlements.length > 1) {
          return { status: 'FAIL', reason: `duplicate settlement after crash: ${settlements.length}` };
        }
        const recovery = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'recovery_completed'
        );
        if (!recovery) {
          return { status: 'INCONCLUSIVE', reason: 'restart/recovery not observed yet' };
        }
        const recoveryTs = recovery.timestamp;
        const resumedForward = evidence.some(
          (e) => e.source === 'engine' &&
                 e.type === 'forward_request' &&
                 e.timestamp > recoveryTs
        );
        if (!resumedForward) {
          return { status: 'FAIL', reason: 'recovery completed but retry to seller never resumed' };
        }
        return { status: 'PASS' };
      },
    },
  ],

  seed: 47,
};
