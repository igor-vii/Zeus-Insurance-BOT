import { describe, it, expect, beforeEach } from 'vitest';
import { BaseSepoliaPaymentAdapter } from '../../../adapters/payment/evm/BaseSepoliaPaymentAdapter';
import { SigningBinding } from '../../../adapters/payment/SigningBinding';

/**
 * Block A tests — PaymentAdapter подписывает EXACT SigningBinding,
 * выданный внешним buyer-side economic layer.
 *
 * Тесты проверяют именно binding (nonce / window / accepted / envelope),
 * а не только наличие непустой строки signature.
 */
describe('BaseSepoliaPaymentAdapter.signX402Payment (SigningBinding)', () => {
  let adapter: BaseSepoliaPaymentAdapter;

  // Standard Anvil test key #0
  const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
  const TEST_RPC_URL = 'http://localhost:8545';

  const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const SELLER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  // Детерминированные intent-значения (принадлежат внешнему слою, НЕ адаптеру)
  const INTENT_NONCE = '0x' + 'ab'.repeat(32);
  const VALID_AFTER = '1750000000';
  const VALID_BEFORE = '1900000000'; // далеко в будущем — проходит window guard

  beforeEach(() => {
    adapter = new BaseSepoliaPaymentAdapter({
      rpcUrl: TEST_RPC_URL,
      privateKey: TEST_PRIVATE_KEY,
      receiveAddresses: {
        'resource-server-1': SELLER,
      },
    });
  });

  function makeBinding(overrides: Partial<SigningBinding> = {}): SigningBinding {
    return {
      from: adapter.getArgusAddress(),
      to: SELLER,
      value: '10000',
      nonce: INTENT_NONCE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      network: 'eip155:84532',
      asset: USDC_BASE_SEPOLIA,
      scheme: 'exact',
      maxTimeoutSeconds: 60,
      ...overrides,
    };
  }

  function decode(result: string): any {
    return JSON.parse(Buffer.from(result, 'base64').toString('utf-8'));
  }

  // ------------------------------------------------------------------
  // Test A1 — exact nonce: входной nonce === nonce в authorization
  // ------------------------------------------------------------------
  it('A1: authorization.nonce equals the input binding nonce exactly', async () => {
    const result = await adapter.signX402Payment(makeBinding());
    const decoded = decode(result);

    expect(decoded.payload.authorization.nonce).toBe(INTENT_NONCE);
  });

  // ------------------------------------------------------------------
  // Test A2 — exact validity window
  // ------------------------------------------------------------------
  it('A2: authorization.validAfter/validBefore equal the input binding window exactly', async () => {
    const result = await adapter.signX402Payment(makeBinding());
    const decoded = decode(result);

    expect(decoded.payload.authorization.validAfter).toBe(VALID_AFTER);
    expect(decoded.payload.authorization.validBefore).toBe(VALID_BEFORE);
  });

  it('A2: authorization.from/to/value match the binding exactly', async () => {
    const binding = makeBinding();
    const result = await adapter.signX402Payment(binding);
    const decoded = decode(result);

    expect(decoded.payload.authorization.from.toLowerCase()).toBe(binding.from.toLowerCase());
    expect(decoded.payload.authorization.to.toLowerCase()).toBe(binding.to.toLowerCase());
    expect(decoded.payload.authorization.value).toBe(binding.value);
  });

  // ------------------------------------------------------------------
  // Test A3 — accepted binding: accepted присутствует и соответствует
  // ------------------------------------------------------------------
  it('A3: accepted mirrors binding network/asset/amount/payTo/scheme', async () => {
    const binding = makeBinding();
    const result = await adapter.signX402Payment(binding);
    const decoded = decode(result);

    expect(decoded.accepted).toBeDefined();
    expect(decoded.accepted.network).toBe(binding.network);
    expect(decoded.accepted.asset).toBe(binding.asset);
    expect(decoded.accepted.amount).toBe(binding.value);
    expect(decoded.accepted.payTo).toBe(binding.to);
    expect(decoded.accepted.scheme).toBe(binding.scheme);
    expect(decoded.accepted.maxTimeoutSeconds).toBe(binding.maxTimeoutSeconds);
  });

  // ------------------------------------------------------------------
  // Test A4 — x402 V2 envelope
  // ------------------------------------------------------------------
  it('A4: envelope has x402Version===2, payload.signature, payload.authorization', async () => {
    const result = await adapter.signX402Payment(makeBinding());
    const decoded = decode(result);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toBeDefined();

    expect(decoded.payload).toBeDefined();
    expect(typeof decoded.payload.signature).toBe('string');
    expect(decoded.payload.signature.startsWith('0x')).toBe(true);
    expect(decoded.payload.signature.length).toBe(132); // 0x + 65 bytes ECDSA
    expect(decoded.payload.authorization).toBeDefined();
  });

  // ------------------------------------------------------------------
  // Test A5 — no local rebinding: adapter не подменяет входные поля
  // ------------------------------------------------------------------
  it('W10: accepted.maxTimeoutSeconds is independent from authorization validity window', async () => {
    const binding = makeBinding({ validAfter: '1750000000', validBefore: '1900000000', maxTimeoutSeconds: 37 });
    const decoded = decode(await adapter.signX402Payment(binding));
    expect(decoded.accepted.maxTimeoutSeconds).toBe(37);
    expect(decoded.accepted.maxTimeoutSeconds).not.toBe(150000000);
  });

  it('A5: two calls with the same binding produce identical authorization (no local nonce/window regeneration)', async () => {
    const binding = makeBinding();

    const d1 = decode(await adapter.signX402Payment(binding));
    const d2 = decode(await adapter.signX402Payment(binding));

    expect(d1.payload.authorization).toEqual(d2.payload.authorization);
    expect(d1.payload.authorization.nonce).toBe(binding.nonce);
    expect(d1.payload.authorization.validAfter).toBe(binding.validAfter);
    expect(d1.payload.authorization.validBefore).toBe(binding.validBefore);
  });

  it('A5: a different external nonce is passed through unchanged', async () => {
    const customNonce = '0x' + 'cd'.repeat(32);
    const result = await adapter.signX402Payment(makeBinding({ nonce: customNonce }));
    const decoded = decode(result);

    expect(decoded.payload.authorization.nonce).toBe(customNonce);
  });

  // ------------------------------------------------------------------
  // Boundary guards (structural validation на Argus-side boundary)
  // ------------------------------------------------------------------
  it('rejects binding for a non-canonical network without signing', async () => {
    await expect(
      adapter.signX402Payment(makeBinding({ network: 'eip155:1' }))
    ).rejects.toThrow(/network/i);
  });

  it('rejects binding for a non-canonical asset (EIP-712 domain mismatch)', async () => {
    await expect(
      adapter.signX402Payment(makeBinding({ asset: '0x' + '11'.repeat(20) }))
    ).rejects.toThrow(/asset/i);
  });

  it('rejects binding whose from is not the Argus test wallet', async () => {
    await expect(
      adapter.signX402Payment(makeBinding({ from: SELLER }))
    ).rejects.toThrow(/from/i);
  });

  it('rejects structurally invalid binding (bad nonce shape)', async () => {
    await expect(
      adapter.signX402Payment(makeBinding({ nonce: 'not-a-nonce' }))
    ).rejects.toThrow(/Invalid SigningBinding/);
  });
});
