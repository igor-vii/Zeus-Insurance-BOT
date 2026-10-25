import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S2_PaymentBeforeExecution: ScenarioDefinition = {
  id: 'S2',
  name: 'Payment Before Execution',
  description: 'Платёж settled раньше, чем seller успевает ответить',

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
      // см. rationale в S1
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
      payload: { requestId: 'req-2', idempotencyKey: 'key-2', amount: 100 },
    },
    {
      // R3 (Decision 3, variant a): seller как актор отдельного действия.
      // Seller отдаёт protected resource — свою часть сделки. Это позволяет
      // fault delayed_response работать через существующий L0-F2 механизм
      // (action_* триггер + participant-цель == actor) без lifecycle dispatch.
      actor: 'resource-server-1',
      type: 'deliver',
      payload: { requestId: 'req-2', resourceId: 'res-2' },
    },
  ],

  faults: [
    {
      // Live-wiring fix (S1-S7 vs real Secretariat, 2026-10-23): the original
      // delayed_response fault below triggers on 'action_deliver', but S2 has
      // no 'deliver' action — the fault was unreachable, so the assertion's
      // "seller actually responded" channel (resource-server-1 →
      // delivery_completed) never had a source. Baseline `respond` mirrors
      // S7's pattern: a harness-side approximation of the seller response
      // fact (approximated: true). Ground truth for the real seller response
      // remains in the mock-seller log + Secretariat PG delivery trail.
      target: { kind: 'participant', participantId: 'resource-server-1' },
      type: 'respond',
      trigger: 'action_request_payment',
      config: { emit: 'delivery_completed' },
      approximated: true,
    },
    {
      target: { kind: 'participant', participantId: 'resource-server-1' },
      type: 'delayed_response',
      // Было: trigger 'delivery_started' (lifecycle, declared-only по L0-F2).
      // Стало: action_deliver — тот же смысл задержки ответа seller, но
      // достижимо через существующий action-fault dispatch.
      trigger: 'action_deliver',
      config: { delay_ms: 5 },
    },
  ],

  invariants: [
    {
      id: 'no_premature_success',
      description: 'SUCCESS не должен фиксироваться раньше, чем seller фактически ответил.',
    },
  ],

  assertions: [
    {
      id: 'assert_no_premature_success',
      invariantId: 'no_premature_success',
      kind: 'behavioral',
      referencedSources: ['sut-1', 'resource-server-1'],
      evaluate: (evidence) => {
        const settled = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'payment_settled'
        );
        const success = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'success'
        );
        if (!settled) return { status: 'INCONCLUSIVE', reason: 'payment_settled not observed yet' };
        if (!success) return { status: 'INCONCLUSIVE', reason: 'success not observed yet — still pending, expected' };
        if (success.timestamp < settled.timestamp) {
          return { status: 'FAIL', reason: 'success recorded before payment_settled' };
        }
        const resourceServerReallyResponded = evidence.some(
          (e) => e.source === 'resource-server-1' && e.type === 'delivery_completed'
        );
        if (success && !resourceServerReallyResponded) {
          return { status: 'FAIL', reason: 'success recorded without seller actually responding' };
        }
        return { status: 'PASS' };
      },
    },
  ],

  seed: 43,
};
