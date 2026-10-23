import { ScenarioDefinition, Action } from '../core/ScenarioDefinition';
import { Evidence } from '../core/Evidence';

export const S8_X402Payment: ScenarioDefinition = {
  id: 'S8',
  name: 'X402 Payment Flow',
  description: 'Buyer получает 402, подписывает через PaymentAdapter, повторяет запрос с payment-signature',

  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    { participantId: 'sut-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' },
  ],

  topology: {
    edges: [
      { from: 'client-1', to: 'sut-1', kind: 'request' },
    ],
  },

  testSubject: 'sut-1',

  actions: [
    {
      actor: 'client-1',
      // Block A audit: request_resource — app-level имя для x402 step 1
      // (HTTP request to protected resource); canonical rename отложен в подблок A1.
      type: 'request_resource',
      payload: { resourceId: 'res-1' },
    },
  ],

  faults: [],

  invariants: [
    {
      id: 'payment_signed_and_retried',
      description: 'При получении 402 buyer должен подписать и повторить запрос.',
    },
  ],

  assertions: [
    {
      id: 'assert_payment_flow_completed',
      invariantId: 'payment_signed_and_retried',
      kind: 'engine-behavior',
      referencedSources: ['engine'],
      evaluate: (evidence: Evidence[]) => {
        // A8.2 semantic contract: payment_signed_and_retried is an ACTION
        // FACT — it records that the signed retry was performed. Its mere
        // presence is NOT a terminal verdict and must not determine PASS.
        const signed = evidence.find(
          (e) => e.source === 'engine' && e.type === 'payment_signed_and_retried'
        );
        if (!signed) {
          return { status: 'FAIL' as const, reason: 'payment not signed and retried' };
        }

        // Terminal outcome is derived independently from canonical
        // post-retry evidence produced by the retry interaction itself.
        const outcome = evidence.find(
          (e) => e.source === 'engine' && e.type === 'payment_retry_outcome'
        );
        if (outcome) {
          const terminalStatus = outcome.data?.terminalStatus;
          const statusCode = outcome.data?.statusCode;
          // Any second HTTP 402 after the signed retry is negative
          // interaction evidence at the HTTP layer, regardless of whether
          // its body carried parsable payment requirements (AC4/AC5).
          if (statusCode === 402) {
            return {
              status: 'FAIL' as const,
              reason: 'payment not signed and retried: signed retry rejected with HTTP 402',
            };
          }
          if (terminalStatus !== 'success') {
            return {
              status: 'FAIL' as const,
              reason: `payment not signed and retried: signed retry terminal status '${String(terminalStatus)}'`,
            };
          }
          return { status: 'PASS' as const };
        }

        // No canonical retry-outcome evidence: either a transport-level
        // failure occurred (no HTTP response observed at all), or the
        // terminal result cannot be established. Absence of evidence is
        // never treated as success.
        const transportFailure = evidence.find(
          (e) => e.source === 'engine' && e.type === 'payment_retry_transport_failure'
        );
        if (transportFailure) {
          return {
            status: 'FAIL' as const,
            reason: 'payment not signed and retried: transport failure on signed retry',
          };
        }
        return {
          status: 'FAIL' as const,
          reason: 'payment not signed and retried: no terminal outcome evidence for signed retry',
        };
      },
    },
  ],

  seed: 88,
};
