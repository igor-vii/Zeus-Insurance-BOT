import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S6_PaymentRetry: ScenarioDefinition = {
  id: 'S6',
  name: 'Payment Retry',
  description: 'Adversarial buyer пытается создать новую authorization на UNKNOWN settlement',

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

  // R3-D2 (Option B — Explicit Second Action): bounded payment retries are
  // modeled as explicit sequential Actions, one per attempt, each carrying a
  // distinct deterministic idempotency key (fresh authorization). The previous
  // lifecycle-triggered retry fault was declared-only under L0-F2 and never
  // dispatched at runtime. settlement_unknown remains an observation term,
  // not a dispatch trigger. retry_count(3) is represented as 3 total attempts.
  actions: [
    {
      actor: 'client-1',
      type: 'request_payment',
      payload: { requestId: 'req-6', idempotencyKey: 'key-6', amount: 100 },
    },
    {
      actor: 'client-1',
      type: 'request_payment',
      payload: { requestId: 'req-6-retry-1', idempotencyKey: 'key-6-retry-1', amount: 100 },
    },
    {
      actor: 'client-1',
      type: 'request_payment',
      payload: { requestId: 'req-6-retry-2', idempotencyKey: 'key-6-retry-2', amount: 100 },
    },
  ],

  faults: [],

  invariants: [
    {
      id: 'no_duplicate_payment_on_unknown',
      description: 'Пока reconciliation не подтвердил NOT_SETTLED, новая authorization для той же логической операции отклоняется.',
    },
  ],

  assertions: [
    {
      id: 'assert_no_duplicate_settlement',
      invariantId: 'no_duplicate_payment_on_unknown',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence) => {
        const settlements = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'payment_settled'
        );
        if (settlements.length > 1) {
          return { status: 'FAIL', reason: `${settlements.length} settled payments without confirmed NOT_SETTLED` };
        }
        if (settlements.length === 1) return { status: 'PASS' };
        return { status: 'INCONCLUSIVE', reason: 'no settlement observed yet' };
      },
    },
  ],

  seed: 46,
};
