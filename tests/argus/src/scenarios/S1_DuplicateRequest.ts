import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S1_DuplicateRequest: ScenarioDefinition = {
  id: 'S1',
  name: 'Duplicate Request',
  description: 'Проверка идемпотентности при дублировании запроса',

  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    {
      // Block A correction (per-scenario roles): resource-server-1 отдаёт
      // protected resource (delivery_sent / delivery_completed) →
      // RESOURCE_SERVER. Отсутствие своего HTTP endpoint в текущем
      // wiring — техническое ограничение, не отсутствие роли.
      participantId: 'resource-server-1',
      protocolRole: 'RESOURCE_SERVER',
      // Argus-owned: controllable seller behavior is the source of
      // fault injection, not the subject under test. If seller were
      // EXTERNAL, Argus could not deterministically force it to
      // "not respond" in S4 or to "lose delivery" in S7.
      ownership: 'ARGUS',
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
      payload: { requestId: 'req-1', idempotencyKey: 'key-1', amount: 100 },
    },
  ],

  faults: [
    {
      target: { kind: 'participant', participantId: 'client-1' },
      type: 'duplicate_request',
      trigger: 'action_request_payment',
      config: { repeat_count: 2 },
    },
  ],

  invariants: [
    {
      id: 'no_duplicate_payment_intent',
      description: 'При дублировании запроса с одинаковым idempotencyKey, test subject должен создать ровно один payment_intent.',
    },
  ],

  assertions: [
    {
      id: 'assert_no_duplicate',
      invariantId: 'no_duplicate_payment_intent',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence) => {
        // S1: client-1 sends request_payment twice (duplicate_request fault).
        // MockTargetAdapter emits:
        //   - 1st call: payment_intent_created
        //   - 2nd call: payment_intent_reused
        // Observation source = testSubject (sut-1), not actor (client-1).
        // Assertion: exactly ONE payment_intent_created from sut-1 with idempotencyKey === 'key-1'.
        const count = evidence.filter(
          (e) => e.source === 'sut-1' &&
                 e.type === 'payment_intent_created' &&
                 (e.data as any)?.idempotencyKey === 'key-1'
        ).length;
        if (count === 1) return { status: 'PASS' };
        if (count > 1) return { status: 'FAIL', reason: `Expected 1, got ${count}` };
        return { status: 'INCONCLUSIVE' };
      },
    },
  ],

  seed: 42,
};
