import { describe, it, expect, beforeEach } from '@jest/globals';
import { Secretariat } from '../src/core/state-machine';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store';
import { MockPaymentAdapter } from '../src/adapters';
import { ExecuteRequest, PaymentSigner, SigningContext, PaymentRequirement, PaymentAuthorization } from '../src/core/types';

class MockSigner implements PaymentSigner {
  async signPayment(
    requirement: PaymentRequirement,
    context: SigningContext
  ): Promise<PaymentAuthorization> {
    return {
      signature: `mock_sig_${Date.now()}`,
      scheme: 'mock',
      timestamp: Date.now(),
      context,
    };
  }
}

global.fetch = jest.fn();

describe('Debug Test B - verbose', () => {
  let store: InMemoryEvidenceStore;
  let signer: MockSigner;
  let adapter: MockPaymentAdapter;
  let secretariat: Secretariat;

  beforeEach(() => {
    store = new InMemoryEvidenceStore();
    signer = new MockSigner();
    adapter = new MockPaymentAdapter({
      network: 'mock-network',
      simulateSettlement: true,
      settlementDelay: 0,
      failProbability: 0,
    });
    
    const adapters = new Map([['mock-network', adapter]]);
    secretariat = new Secretariat({
      evidenceStore: store,
      signer,
      adapters,
    });

    (global.fetch as jest.Mock).mockClear();
  });

  it('B - debug 402 payment flow with verbose logging', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: {
          get: (name: string) => {
            console.log('Header requested:', name);
            if (name === 'X-Payment-Required') {
              return "amount='0.5'; asset='MOCK'; network='mock-network'; payee='seller123'";
            }
            if (name === 'X-Recovery-Capability') {
              return 'EXECUTION_IDEMPOTENT';
            }
            return null;
          },
          entries: () => [],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => {
          console.log('JSON called');
          return { result: 'paid_success' };
        },
        headers: {
          entries: () => [],
          get: () => null,
        },
      });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/paid-endpoint',
      method: 'POST',
      payload: { data: 'test' },
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    try {
      const result = await secretariat.execute(request);
      
      console.log('=== RESULT ===');
      console.log('status:', result.status);
      console.log('error:', result.error);
      console.log('paymentStatus:', result.paymentStatus);
      console.log('executionStatus:', result.executionStatus);
      console.log('evidence events:', result.evidence.map(e => e.event));
      
      expect(result.status).toBe('SUCCESS');
    } catch (e: any) {
      console.log('=== EXCEPTION ===');
      console.log('message:', e.message);
      console.log('stack:', e.stack);
      throw e;
    }
  });
});
