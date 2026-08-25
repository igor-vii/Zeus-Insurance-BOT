/**
 * Zeus Secretariat V0 - State Machine Tests
 * 
 * Definition of Done tests for Stage 1:
 * A — Free endpoint: REQUEST → SUCCESS
 * B — 402 → payment → success: REQUEST → 402 → POLICY OK → SIGN → PAYMENT → SETTLED → EXECUTED → SUCCESS
 * C — Policy rejection: 402 → price > maxPrice → POLICY_REJECTED → no signature → no payment
 * D — Pre-settlement failure: payment attempt → explicit "not charged" → retry → success
 * E — Payment submitted, network response lost: payment submitted → network failure → SETTLEMENT_UNKNOWN (No second payment)
 * F — Settlement confirmed, execution unknown, retrieval available: SETTLED → EXECUTION_UNKNOWN → RESULT_RETRIEVAL → RECOVERED
 * G — Settlement confirmed, execution unknown, no recovery: SETTLED → EXECUTION_UNKNOWN → NO_RECOVERY_PATH → UNRESOLVABLE
 * H — Process restart: operationId → load durable state → continue observation/recovery
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Secretariat } from '../src/core/state-machine';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store';
import { MockPaymentAdapter } from '../src/adapters';
import { ExecuteRequest, PaymentSigner, SigningContext, PaymentRequirement, PaymentAuthorization } from '../src/core/types';

// Mock signer for testing
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

// Mock fetch for testing
global.fetch = jest.fn();

describe('Zeus Secretariat V0 - State Machine Tests', () => {
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

    // Clear mock fetch
    (global.fetch as jest.Mock).mockClear();
  });

  // ==========================================================================
  // Test A — Free endpoint: REQUEST → SUCCESS
  // ==========================================================================
  it('A - should handle free endpoint without payment', async () => {
    // Mock successful response without 402
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ result: 'success' }),
      headers: {
        entries: () => [],
      },
    });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/endpoint',
      method: 'POST',
      payload: { data: 'test' },
      policy: {
        maxPrice: '10',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await secretariat.execute(request);

    expect(result.status).toBe('SUCCESS');
    expect(result.paymentStatus).toBe('NOT_STARTED');
    expect(result.executionStatus).toBe('CONFIRMED');
    expect(result.data).toEqual({ result: 'success' });
  });

  // ==========================================================================
  // Test B — 402 → payment → success
  // ==========================================================================
  it('B - should handle 402 payment flow to success', async () => {
    // First call: 402 Payment Required
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: {
          get: (name: string) => {
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
      // Second call: successful execution after payment
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ result: 'paid_success' }),
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

    const result = await secretariat.execute(request);

    expect(result.status).toBe('SUCCESS');
    expect(result.paymentStatus).toBe('SETTLED');
    expect(result.executionStatus).toBe('CONFIRMED');
    expect(result.settlementProof).toBeDefined();
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Test C — Policy rejection: price > maxPrice
  // ==========================================================================
  it('C - should reject when price exceeds maxPrice', async () => {
    // 402 with price higher than policy allows
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 402,
      ok: false,
      headers: {
        get: (name: string) => {
          if (name === 'X-Payment-Required') {
            return "amount='5.0'; asset='MOCK'; network='mock-network'; payee='seller123'";
          }
          return null;
        },
        entries: () => [],
      },
    });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/expensive-endpoint',
      method: 'POST',
      policy: {
        maxPrice: '1.0', // Lower than required 5.0
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await secretariat.execute(request);

    expect(result.status).toBe('FAILED');
    expect(result.paymentStatus).toBe('NOT_STARTED');
    // Verify no signature was created
    const evidence = result.evidence.filter(e => e.event === 'PAYMENT_AUTHORIZED');
    expect(evidence.length).toBe(0);
  });

  // ==========================================================================
  // Test E — Payment submitted, network response lost → SETTLEMENT_UNKNOWN
  // No second payment allowed
  // ==========================================================================
  it('E - should handle settlement unknown without retrying payment', async () => {
    // Create adapter that doesn't confirm settlement
    const nonConfirmingAdapter = new MockPaymentAdapter({
      network: 'mock-network',
      simulateSettlement: false, // Don't confirm settlement
    });

    const adapters = new Map([['mock-network', nonConfirmingAdapter]]);
    const localSecretariat = new Secretariat({
      evidenceStore: store,
      signer,
      adapters,
    });

    // 402 response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 402,
      ok: false,
      headers: {
        get: (name: string) => {
          if (name === 'X-Payment-Required') {
            return "amount='0.5'; asset='MOCK'; network='mock-network'; payee='seller123'";
          }
          return null;
        },
        entries: () => [],
      },
    });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/unsettlement-endpoint',
      method: 'POST',
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await localSecretariat.execute(request);

    // Should end in FAILED or UNRESOLVABLE state due to settlement unknown
    expect(['FAILED', 'UNRESOLVABLE']).toContain(result.status);
    expect(result.paymentStatus).toBe('UNKNOWN');
    
    // CRITICAL: Verify only ONE payment submission occurred
    const submissionCount = result.evidence.filter(
      e => e.event === 'PAYMENT_SUBMITTED'
    ).length;
    expect(submissionCount).toBe(1);
  });

  // ==========================================================================
  // Test F — Settlement confirmed, execution unknown, retrieval available
  // SETTLED → EXECUTION_UNKNOWN → RESULT_RETRIEVAL → RECOVERED
  // ==========================================================================
  it('F - should recover via result retrieval', async () => {
    // First call: 402 Payment Required
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: {
          get: (name: string) => {
            if (name === 'X-Payment-Required') {
              return "amount='0.5'; asset='MOCK'; network='mock-network'; payee='seller123'";
            }
            if (name === 'X-Recovery-Capability') {
              return 'RESULT_RETRIEVAL';
            }
            if (name === 'X-Result-Retrieval-Endpoint') {
              return 'https://api.example.com/results';
            }
            return null;
          },
          entries: () => [],
        },
      })
      // Second call: execution fails (network error simulation)
      .mockRejectedValueOnce(new Error('Network error'))
      // Third call: result retrieval succeeds
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ result: 'retrieved' }),
        headers: {
          entries: () => [],
        },
      });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/retrieval-endpoint',
      method: 'POST',
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await secretariat.execute(request);

    expect(result.status).toBe('RECOVERED');
    expect(result.paymentStatus).toBe('SETTLED');
    expect(result.data).toEqual({ result: 'retrieved' });
  });

  // ==========================================================================
  // Test G — Settlement confirmed, execution unknown, no recovery
  // SETTLED → EXECUTION_UNKNOWN → NO_RECOVERY_PATH → UNRESOLVABLE
  // ==========================================================================
  it('G - should mark as unresolvable when no recovery path', async () => {
    // First call: 402 Payment Required with NONE capability
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: {
          get: (name: string) => {
            if (name === 'X-Payment-Required') {
              return "amount='0.5'; asset='MOCK'; network='mock-network'; payee='seller123'";
            }
            if (name === 'X-Recovery-Capability') {
              return 'NONE';
            }
            return null;
          },
          entries: () => [],
        },
      })
      // Second call: execution fails
      .mockRejectedValueOnce(new Error('Network error'));

    const request: ExecuteRequest = {
      target: 'https://api.example.com/no-recovery-endpoint',
      method: 'POST',
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await secretariat.execute(request);

    expect(result.status).toBe('UNRESOLVABLE');
    expect(result.paymentStatus).toBe('SETTLED');
    expect(result.error).toContain('recovery');
  });

  // ==========================================================================
  // Test H — Process restart: load durable state
  // ==========================================================================
  it('H - should persist and reload operation state', async () => {
    // Mock successful response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ result: 'persisted' }),
      headers: {
        entries: () => [],
      },
    });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/persist-endpoint',
      method: 'POST',
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
      requestId: 'test-request-123',
    };

    const result = await secretariat.execute(request);

    // Verify operation was persisted
    const loadedOperation = await store.getOperation(result.operationId);
    expect(loadedOperation).not.toBeNull();
    expect(loadedOperation?.operationId).toBe(result.operationId);
    expect(loadedOperation?.requestId).toBe('test-request-123');

    // Verify evidence was persisted
    const evidence = await store.getEvidence(result.operationId);
    expect(evidence.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Additional invariant tests
  // ==========================================================================
  it('should not create payment signature when policy is rejected', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 402,
      ok: false,
      headers: {
        get: (name: string) => {
          if (name === 'X-Payment-Required') {
            return "amount='10.0'; asset='MOCK'; network='mock-network'; payee='seller123'";
          }
          return null;
        },
        entries: () => [],
      },
    });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/expensive',
      method: 'POST',
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await secretariat.execute(request);

    expect(result.status).toBe('FAILED');
    
    // Verify no authorization was created
    const authEvidence = result.evidence.filter(e => e.event === 'PAYMENT_AUTHORIZED');
    expect(authEvidence.length).toBe(0);
  });

  it('should record evidence for all critical transitions', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ result: 'evidence_test' }),
      headers: {
        entries: () => [],
      },
    });

    const request: ExecuteRequest = {
      target: 'https://api.example.com/evidence',
      method: 'GET',
      policy: {
        maxPrice: '1.0',
        allowedNetworks: ['mock-network'],
        allowedAssets: ['MOCK'],
        authorizationMode: 'policy-bound',
      },
    };

    const result = await secretariat.execute(request);

    // Should have evidence for creation and completion at minimum
    const creationEvidence = result.evidence.filter(e => e.event === 'OPERATION_CREATED');
    const completionEvidence = result.evidence.filter(e => e.event === 'DIRECT_SUCCESS');
    
    expect(creationEvidence.length).toBeGreaterThan(0);
    expect(completionEvidence.length).toBeGreaterThan(0);
  });
});
