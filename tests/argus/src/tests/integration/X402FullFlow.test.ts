import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockX402Server } from '../helpers/MockX402Server';
import { X402AgentAdapter } from '../../adapters/x402/X402AgentAdapter';
import { BaseSepoliaPaymentAdapter } from '../../adapters/payment/evm/BaseSepoliaPaymentAdapter';
import { AgentController } from '../../core/AgentController';
import { RunOrchestrator } from '../../core/RunOrchestrator';
import { S8_X402Payment } from '../../scenarios/S8_X402Payment';

describe('X402 Full Flow Integration Test', () => {
  let server: MockX402Server;
  let adapter: X402AgentAdapter;
  let paymentAdapter: BaseSepoliaPaymentAdapter;
  let controller: AgentController;

  const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
  const TEST_RPC_URL = 'http://localhost:8545';

  beforeEach(async () => {
    server = new MockX402Server();
    const { url } = await server.start();

    // Configure server to return 402 with valid payment-required header
    const paymentRequiredBody = {
      x402Version: 2,
      resource: { url: 'http://localhost/resource' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '10000',
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        maxTimeoutSeconds: 60,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      }],
    };
    server.setBehavior({ type: '402_with_header', paymentRequired: paymentRequiredBody });

    adapter = new X402AgentAdapter('x402-target');
    await adapter.connect({ transportType: 'x402', endpoint: url });

    paymentAdapter = new BaseSepoliaPaymentAdapter({
      rpcUrl: TEST_RPC_URL,
      privateKey: TEST_PRIVATE_KEY,
      receiveAddresses: {
        'resource-server-1': '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
    });

    controller = new AgentController(adapter, {
      connectionConfig: { transportType: 'x402', endpoint: url },
      timeoutMs: 5000,
    });
    controller.setRunId('integration-test-run');
  });

  afterEach(async () => {
    await server.stop();
    await adapter.disconnect();
  });

  it('should complete full x402 payment flow: 402 -> sign -> retry -> success', async () => {
    // Create controllers Map
    const controllers = new Map<string, AgentController>();
    controllers.set('client-1', controller);

    // Create orchestrator with paymentAdapter
    const orchestrator = new RunOrchestrator(
      S8_X402Payment,
      controllers,
      [],
      paymentAdapter
    );

    // Execute the run
    const result = await orchestrator.run();

    // Verify verdict is PASS
    expect(result.verdict?.status).toBe('PASS');

    // Verify evidence contains payment_signed_and_retried event
    const evidence = orchestrator.getEvidence();
    const signedEvent = evidence.find(
      (e: any) => e.source === 'engine' && e.type === 'payment_signed_and_retried'
    );
    expect(signedEvent).toBeDefined();

    // Verify server received two requests
    const requests = server.getRequests();
    expect(requests.length).toBe(2);

    // First request should NOT have payment-signature header
    expect(requests[0].headers['payment-signature']).toBeUndefined();

    // Second request SHOULD have payment-signature header
    expect(requests[1].headers['payment-signature']).toBeDefined();
    expect(requests[1].headers['payment-signature'].length).toBeGreaterThan(0);

    // Verify payment-signature is valid Base64
    const signatureHeader = requests[1].headers['payment-signature'];
    expect(() => {
      const decoded = Buffer.from(signatureHeader, 'base64').toString('utf-8');
      JSON.parse(decoded);
    }).not.toThrow();
  });

  it('signed payload carries the external SigningBinding exactly through the full flow', async () => {
    // External buyer-side intent (в целевой архитектуре — Secretariat;
    // wire boundary фиксируется на cross-system этапе).
    const intentNonce = '0x' + 'ef'.repeat(32);
    const nowSec = Math.floor(Date.now() / 1000);
    const bindingSource = () => ({
      nonce: intentNonce,
      validAfter: String(nowSec),
      validBefore: String(nowSec + 120),
    });

    const controllers = new Map<string, AgentController>();
    controllers.set('client-1', controller);

    const orchestrator = new RunOrchestrator(
      S8_X402Payment,
      controllers,
      [],
      paymentAdapter,
      bindingSource
    );

    const result = await orchestrator.run();
    expect(result.verdict?.status).toBe('PASS');

    const requests = server.getRequests();
    expect(requests.length).toBe(2);

    const payloadB64 = requests[1].headers['payment-signature'];
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));

    // x402 V2 envelope with accepted
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toBeDefined();
    expect(decoded.accepted.network).toBe('eip155:84532');
    expect(decoded.accepted.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(decoded.accepted.amount).toBe('10000');
    expect(decoded.accepted.payTo).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');

    // EXACT binding: nonce/window из внешнего источника, НЕ из адаптера
    expect(decoded.payload.authorization.nonce).toBe(intentNonce);
    expect(decoded.payload.authorization.validAfter).toBe(String(nowSec));
    expect(decoded.payload.authorization.validBefore).toBe(String(nowSec + 120));
    expect(decoded.payload.authorization.from.toLowerCase()).toBe(
      paymentAdapter.getArgusAddress().toLowerCase()
    );
  });
});
