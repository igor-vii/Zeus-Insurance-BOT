/**
 * S9 — external CLIENT → Argus RESOURCE_SERVER (Block A, inbound direction).
 *
 * Mirror of S8 under the SAME canonical execution / evidence / assertion /
 * verdict model. The transport direction differs (the SUT initiates), the
 * semantic execution model does NOT:
 *
 *   ScenarioDefinition
 *     → RunOrchestrator.runInbound() / ScenarioEngine.beginInboundExecution() window
 *     → X402SellerAdapter (inbound transport)
 *     → canonical Evidence (core/Evidence Observation)
 *     → Assertions (core/Assertions via AssertionEngine)
 *     → Verdict (PASS | FAIL | INCONCLUSIVE via RunResult.verdict)
 *
 * Expected happy path:
 *   1. external CLIENT sends resource request
 *   2. Argus returns x402 V2 402 Payment Required      → observation 'payment_required_issued'
 *   3. external CLIENT sends PAYMENT-SIGNATURE
 *   4. Argus validates the x402 payment authorization  → observation 'payment_signature_validated'
 *   5. Argus returns deterministic resource response   → observation 'resource_response_delivered'
 *   6. canonical evidence is produced (EvidenceCollector)
 *   7. canonical assertions evaluate the run (AssertionEngine)
 *   8. canonical verdict is produced (RunResult.verdict)
 *
 * Semantic boundary (identical to S8):
 *   A validated PAYMENT-SIGNATURE is an authorization-verification fact at
 *   the HTTP/x402 boundary. It is NOT on-chain settlement and MUST NOT be
 *   asserted as such. No settlement machinery exists here by design.
 */

import { ScenarioDefinition } from '../core/ScenarioDefinition';
import { Evidence } from '../core/Evidence';

export const S9_X402Seller: ScenarioDefinition = {
  id: 'S9',
  name: 'X402 Inbound Resource Server Flow',
  description:
    'Argus выступает ephemeral RESOURCE_SERVER; внешний CLIENT запрашивает ресурс, получает 402, присылает PAYMENT-SIGNATURE; Argus валидирует подпись и отдаёт детерминированный ресурсный ответ. Canonical evidence → assertions → verdict.',

  participants: [
    { participantId: 'external-client-1', protocolRole: 'CLIENT', ownership: 'EXTERNAL' },
    { participantId: 'argus-server-1', protocolRole: 'RESOURCE_SERVER', ownership: 'ARGUS' },
  ],

  topology: {
    edges: [
      { from: 'external-client-1', to: 'argus-server-1', kind: 'request' },
    ],
  },

  // Наблюдаемая система в S9 — сам Argus RESOURCE_SERVER (inbound transport).
  testSubject: 'argus-server-1',

  // P0 (transport/lifecycle only): входящее ожидание инициируется SUT, а не
  // outbound action'ом. Исполнение идёт через RunOrchestrator.runInbound():
  // ScenarioEngine.beginInboundExecution() открывает каноническое окно
  // исполнения, транспортный адаптер пишет канонические Observation в тот же
  // EvidenceCollector, вердикт выносит тот же AssertionEngine.
  // actions[] остаётся пустым осознанно: здесь нет outbound действия,
  // которое ScenarioEngine.execute() мог бы выполнить.
  actions: [],

  faults: [],

  invariants: [
    {
      id: 'x402_payment_required_issued',
      description:
        'Первый запрос без оплаты обязан получить корректный x402 V2 402 Payment Required.',
    },
    {
      id: 'x402_payment_signature_validated',
      description:
        'Запрос с PAYMENT-SIGNATURE обязан пройти x402-валидацию авторизации (структурную + EIP-712). Это факт валидации, НЕ факт settlement.',
    },
    {
      id: 'x402_resource_response_delivered',
      description:
        'После валидации подписи Argus обязан отдать детерминированный ресурсный ответ (2xx).',
    },
  ],

  assertions: [
    {
      // A9.1 happy path, часть 1: 402 issued.
      id: 'assert_payment_required_issued',
      invariantId: 'x402_payment_required_issued',
      kind: 'behavioral',
      referencedSources: ['argus-server-1'],
      evaluate: (evidence: Evidence[]) => {
        const issued = evidence.find(
          (e) => e.source === 'argus-server-1' && e.type === 'payment_required_issued'
        );
        if (issued) return { status: 'PASS' as const };
        return {
          status: 'FAIL' as const,
          reason: 'no evidence that a 402 Payment Required was issued to the external client',
        };
      },
    },
    {
      // A9.1 happy path, часть 2: payment signature accepted/validated.
      // NB: asserts validation ONLY — never on-chain settlement (§10).
      id: 'assert_payment_signature_validated',
      invariantId: 'x402_payment_signature_validated',
      kind: 'behavioral',
      referencedSources: ['argus-server-1'],
      evaluate: (evidence: Evidence[]) => {
        const rejected = evidence.find(
          (e) => e.source === 'argus-server-1' && e.type === 'payment_signature_rejected'
        );
        if (rejected) {
          return {
            status: 'FAIL' as const,
            reason: `payment signature was rejected: ${String(rejected.data.validationError ?? 'unknown')}`,
          };
        }
        const validated = evidence.find(
          (e) => e.source === 'argus-server-1' && e.type === 'payment_signature_validated'
        );
        if (validated) return { status: 'PASS' as const };
        return {
          status: 'FAIL' as const,
          reason: 'no evidence that a PAYMENT-SIGNATURE was received and validated',
        };
      },
    },
    {
      // A9.1 happy path, часть 3: resource response delivered.
      id: 'assert_resource_response_delivered',
      invariantId: 'x402_resource_response_delivered',
      kind: 'behavioral',
      referencedSources: ['argus-server-1'],
      evaluate: (evidence: Evidence[]) => {
        const delivered = evidence.find(
          (e) => e.source === 'argus-server-1' && e.type === 'resource_response_delivered'
        );
        if (delivered) return { status: 'PASS' as const };
        return {
          status: 'FAIL' as const,
          reason: 'no evidence that the deterministic resource response was delivered after payment validation',
        };
      },
    },
  ],

  seed: 99,
};
