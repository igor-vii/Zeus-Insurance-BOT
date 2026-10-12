import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Secretariat } from '../src/core/state-machine.js';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store.js';

describe('pre-intent failure evidence persistence', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('preserves the original createRequest error when failure evidence append also fails', async () => {
    const store = new InMemoryEvidenceStore();
    const appendSpy = jest.spyOn(store, 'append')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('evidence database unavailable'));

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'));

    const secretariat = new Secretariat({
      evidenceStore: store,
      adapters: new Map(),
      atomicSettlementHandoff: {} as never,
    });

    const response = await secretariat.createRequest({
      target: 'https://seller.example.com/task',
      method: 'POST',
      policy: {
        maxPrice: '1',
        allowedNetworks: ['eip155:8453'],
        allowedAssets: ['USDC'],
        authorizationMode: 'explicit',
      },
    });

    expect(response.status).toBe('REJECTED');
    if (response.status !== 'REJECTED') {
      throw new Error('Expected createRequest to reject');
    }
    expect(response.result.error).toBe('HTTP 502: Bad Gateway');
    expect(response.result.status).toBe('FAILED');
    expect(response.result.evidence.some((record) =>
      record.event === 'EVIDENCE_PERSISTENCE_FAILED'
    )).toBe(true);
    expect(appendSpy).toHaveBeenCalledTimes(2);
  });
});
