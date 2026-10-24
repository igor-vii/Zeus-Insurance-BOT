import { ScenarioDefinition } from '../core/ScenarioDefinition';

export const S7_LostDelivery: ScenarioDefinition = {
  id: 'S7',
  name: 'Lost Delivery',
  description: 'Seller фактически отвечает (respond), но ответ теряется на edge resource-server-1 → sut-1',

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
      { from: 'resource-server-1', to: 'sut-1', kind: 'response' },
    ],
  },

  testSubject: 'sut-1',

  actions: [
    {
      actor: 'client-1',
      type: 'request_payment',
      payload: { requestId: 'req-7', idempotencyKey: 'key-7', amount: 100 },
    },
  ],

  faults: [
    {
      // respond — НЕ fault по смыслу (baseline-поведение participant'а),
      // живёт здесь ради единообразия механизма emission
      // (FaultInjector.apply + callback).
      target: { kind: 'participant', participantId: 'resource-server-1' },
      type: 'respond',
      trigger: 'action_request_payment',
      config: { emit: 'delivery_sent' },
      approximated: true,
      // Mock-режим не различает "переслано resource-server-1" от
      // "target ответил" — см. Temporal Trust Boundary addendum.
    },
    {
      // В Mock-режиме V0 этот fault семантически объявлен,
      // но не имеет наблюдаемого эффекта: нет пути от
      // emission resource-server-1 к reception sut-1, который можно
      // дропнуть. Станет содержательным при HTTP-интеграции —
      // см. ROADMAP backlog.
      target: { kind: 'edge', from: 'resource-server-1', to: 'sut-1' },
      type: 'lost_delivery',
      trigger: 'delivery_sent',
      config: { drop_probability: 1.0 },
    },
  ],

  invariants: [
    {
      id: 'lost_response_yields_unknown_not_duplicate',
      description: 'Seller фактически отправил ответ (respond), но secretariat его не получил (edge fault). Состояние — DELIVERY_UNKNOWN, платёж не дублируется, допустим повторный запрос к seller (не платёж).',
    },
  ],

  assertions: [
    {
      id: 'assert_seller_sent_but_sut_never_received',
      invariantId: 'lost_response_yields_unknown_not_duplicate',
      kind: 'behavioral',
      referencedSources: ['resource-server-1', 'sut-1'],
      evaluate: (evidence) => {
        const resourceServerSent = evidence.find((e) => e.source === 'resource-server-1' && e.type === 'delivery_sent');
        if (!resourceServerSent) return { status: 'INCONCLUSIVE', reason: 'seller has not sent response yet' };

        const sutReceived = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'delivery_received'
        );
        if (sutReceived) return { status: 'FAIL', reason: 'edge fault did not actually drop the response — test setup invalid' };

        const duplicatePayment = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'payment_settled'
        ).length;
        if (duplicatePayment > 1) {
          return { status: 'FAIL', reason: `duplicate payment triggered by lost response: ${duplicatePayment}` };
        }

        const unknown = evidence.find((e) => e.source === 'sut-1' && e.type === 'delivery_unknown');
        if (unknown) return { status: 'PASS' };

        const failed = evidence.find((e) => e.source === 'sut-1' && e.type === 'failed');
        if (failed) return { status: 'FAIL', reason: 'marked FAILED despite seller having actually responded' };

        return { status: 'INCONCLUSIVE', reason: 'no terminal state observed yet' };
      },
    },
  ],

  seed: 48,
};
