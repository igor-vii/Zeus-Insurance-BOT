import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S4_SellerTimeout: ScenarioDefinition = {
  id: 'S4',
  name: 'Seller Timeout',
  description: 'Seller никогда не отвечает — проверяем DELIVERY_UNKNOWN, не FAILED/SUCCESS',

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
      payload: { requestId: 'req-4', idempotencyKey: 'key-4', amount: 100 },
    },
    {
      // R3 (Decision 3, variant a): seller как актор отдельного действия.
      // Seller пытается отдать protected resource; hang на этом действии
      // означает «seller никогда не отвечает» — достижимо через существующий
      // L0-F2 action-fault dispatch без lifecycle dispatch.
      actor: 'resource-server-1',
      type: 'deliver',
      payload: { requestId: 'req-4', resourceId: 'res-4' },
    },
  ],

  faults: [
    {
      target: { kind: 'participant', participantId: 'resource-server-1' },
      type: 'hang',
      // Было: trigger 'delivery_started' (lifecycle, declared-only по L0-F2).
      // Стало: action_deliver — тот же смысл зависшего ответа seller, но
      // достижимо через существующий action-fault dispatch.
      trigger: 'action_deliver',
      config: { duration_ms: -1 },
    },
  ],

  invariants: [
    {
      id: 'timeout_yields_unknown_not_failed',
      description: 'Settled + seller не отвечает → DELIVERY_UNKNOWN, не FAILED, не SUCCESS, без повторной оплаты.',
    },
  ],

  assertions: [
    {
      id: 'assert_timeout_state',
      invariantId: 'timeout_yields_unknown_not_failed',
      kind: 'behavioral',
      referencedSources: ['sut-1', 'resource-server-1'],
      evaluate: (evidence) => {
        const settled = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'payment_settled'
        );
        if (!settled) return { status: 'INCONCLUSIVE', reason: 'payment_settled not observed yet' };

        const failed = evidence.find((e) => e.source === 'sut-1' && e.type === 'failed');
        const success = evidence.find((e) => e.source === 'sut-1' && e.type === 'success');
        const unknown = evidence.find((e) => e.source === 'sut-1' && e.type === 'delivery_unknown');

        if (failed) return { status: 'FAIL', reason: 'marked FAILED without seller ever responding' };
        if (success) return { status: 'FAIL', reason: 'marked SUCCESS without seller ever responding' };

        const settlementCount = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'payment_settled'
        ).length;
        if (settlementCount > 1) {
          return { status: 'FAIL', reason: `duplicate settlement attempted: ${settlementCount}` };
        }

        if (unknown) return { status: 'PASS' };
        return { status: 'INCONCLUSIVE', reason: 'no terminal state observed yet' };
      },
    },
  ],

  seed: 44,
};
