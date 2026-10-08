import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S5_ConcurrentDuplicate: ScenarioDefinition = {
  id: 'S5',
  name: 'Concurrent Duplicate',
  description: '5 параллельных запросов с одинаковым idempotencyKey',

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
      payload: { requestId: 'req-5', idempotencyKey: 'key-5', amount: 100 },
    },
  ],

  faults: [
    {
      target: { kind: 'participant', participantId: 'client-1' },
      type: 'concurrent_request',
      trigger: 'action_request_payment',
      config: { parallel_count: 5, same_idempotency_key: true },
    },
  ],

  invariants: [
    {
      id: 'concurrent_requests_single_intent',
      description: '5 параллельных запросов с одним idempotencyKey создают ровно один payment_intent.',
    },
  ],

  assertions: [
    {
      id: 'assert_concurrent_single_intent',
      invariantId: 'concurrent_requests_single_intent',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence) => {
        const intents = evidence.filter(
          (e) =>
            e.source === 'sut-1' &&
            e.type === 'payment_intent_created' &&
            (e.data as any)?.idempotencyKey === 'key-5'
        );
        if (intents.length === 0) return { status: 'INCONCLUSIVE', reason: 'no payment_intent observed yet' };
        if (intents.length === 1) return { status: 'PASS' };
        return { status: 'FAIL', reason: `expected 1, got ${intents.length}` };
      },
    },
    {
      id: 'assert_no_unhandled_errors',
      invariantId: 'concurrent_requests_single_intent',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence) => {
        const intents = evidence.filter(
          (e) =>
            e.source === 'sut-1' &&
            e.type === 'payment_intent_created' &&
            (e.data as any)?.idempotencyKey === 'key-5'
        );
        const unhandled = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'unhandled_exception'
        );
        if (unhandled.length > 0) {
          return { status: 'FAIL', reason: `${unhandled.length} unhandled exceptions on concurrent retry` };
        }
        if (intents.length === 0) {
          return {
            status: 'INCONCLUSIVE',
            reason: 'absence of unhandled_exception is not evidence of successful intent creation',
          };
        }
        return { status: 'PASS' };
      },
    },
  ],

  seed: 45,
};
