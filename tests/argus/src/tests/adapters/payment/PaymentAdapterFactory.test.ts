import { describe, it, expect } from 'vitest';
import { createPaymentAdapter } from '../../../adapters/payment/PaymentAdapterFactory';
import { NotImplementedError } from '../../../adapters/payment/PaymentAdapter';

describe('PaymentAdapterFactory', () => {
  const baseConfig = {
    rpcUrl: 'https://sepolia.base.org',
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
  };

  it('creates BaseSepoliaPaymentAdapter for base-sepolia', () => {
    const adapter = createPaymentAdapter({
      network: 'base-sepolia',
      ...baseConfig,
    });
    expect(adapter).toBeDefined();
  });

  it('creates BasePaymentAdapter stub for base', () => {
    const adapter = createPaymentAdapter({
      network: 'base',
      ...baseConfig,
    });
    expect(adapter).toBeDefined();
    expect(() => adapter.getReceiveAddress('resource-server-1')).toThrow(NotImplementedError);
  });

  it('creates XLayerPaymentAdapter stub for xlayer', () => {
    const adapter = createPaymentAdapter({
      network: 'xlayer',
      ...baseConfig,
    });
    expect(adapter).toBeDefined();
  });

  it('creates SolanaPaymentAdapter stub for solana', () => {
    const adapter = createPaymentAdapter({
      network: 'solana',
      ...baseConfig,
    });
    expect(adapter).toBeDefined();
  });

  it('throws on unknown network', () => {
    expect(() => createPaymentAdapter({
      network: 'unknown' as any,
      ...baseConfig,
    })).toThrow();
  });
});
