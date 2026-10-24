import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { X402AgentAdapter } from '../../../adapters/x402/X402AgentAdapter';
import { ExchangeStatus, MessageDirection } from '../../../core/AgentTargetPort';
import { MockX402Server } from '../../helpers/MockX402Server';

describe('X402AgentAdapter', () => {
  let adapter: X402AgentAdapter;
  let server: MockX402Server;

  beforeEach(() => {
    adapter = new X402AgentAdapter('x402-target');
    server = new MockX402Server();
  });

  afterEach(async () => {
    await server.stop();
    adapter.disconnect();
    adapter.reset();
  });

  describe('connect()', () => {
    it('should succeed with valid x402 config', async () => {
      const result = await adapter.connect({
        transportType: 'x402',
        endpoint: 'http://localhost:1234',
      });
      expect(result.success).toBe(true);
      expect(adapter.isConnected()).toBe(true);
    });

    it('should fail with invalid transport type', async () => {
      const result = await adapter.connect({
        transportType: 'http',
        endpoint: 'http://localhost:1234',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid transport type');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should fail without endpoint', async () => {
      const result = await adapter.connect({
        transportType: 'x402',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('endpoint URL is required');
    });

    it('should fail with invalid URL', async () => {
      const result = await adapter.connect({
        transportType: 'x402',
        endpoint: 'not-a-url',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });
  });

  describe('send() without connect', () => {
    it('should throw if not connected', async () => {
      await expect(adapter.send('run-1', 'test')).rejects.toThrow('Not connected');
    });
  });

  describe('send() with 402 responses', () => {
    it('should parse 402 with valid payment-required header', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

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

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);
      expect(exchange.paymentRequired).toBeDefined();
      expect(exchange.paymentRequired?.scheme).toBe('exact');
      expect(exchange.paymentRequired?.network).toBe('eip155:84532');
      expect(exchange.paymentRequired?.amount).toBe('10000');
      expect(exchange.paymentRequired?.payTo).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
      expect(exchange.paymentRequired?.maxTimeoutSeconds).toBe(60);
    });

    it('should fallback to body if header Base64 is invalid', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

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

      server.setBehavior({ type: '402_invalid_header', responseBody: paymentRequiredBody });

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);
      expect(exchange.paymentRequired).toBeDefined();
      expect(exchange.paymentRequired?.amount).toBe('10000');
    });

    it('should parse 402 from body only (no header)', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

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

      server.setBehavior({ type: '402_with_body_only', paymentRequired: paymentRequiredBody });

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);
      expect(exchange.paymentRequired).toBeDefined();
    });

    it('should fail if 402 has no valid header or body', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      server.setBehavior({ type: '402_with_body_only', paymentRequired: { error: 'nope' } });

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.FAILURE);
      expect(exchange.error).toContain('could not parse');
    });

    // L3 — outbound x402 observation wiring: HTTP-boundary facts received
    // from the SUT populate the existing metadata.observations carrier.
    it('should record http_response_received + payment_required_received observations on 402', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

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

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      const observations = exchange.metadata?.observations as string[];
      expect(Array.isArray(observations)).toBe(true);
      expect(observations).toContain('http_response_received');
      expect(observations).toContain('payment_required_received');
      // No delivery/settlement/success claims may be manufactured here.
      expect(observations.some((o) => /settle|deliver|success/i.test(o))).toBe(false);
    });
  });

  describe('send() with other statuses', () => {
    it('should succeed with 200 response', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      server.setBehavior({ type: '200', responseBody: { data: 'success' } });

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
      expect(exchange.payload).toEqual({ data: 'success' });

      // L3: a plain HTTP response is still an externally observable fact.
      const observations = exchange.metadata?.observations as string[];
      expect(observations).toContain('http_response_received');
      expect(observations).not.toContain('payment_required_received');
    });

    it('should fail with 500 response', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      server.setBehavior({ type: '500' });

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.FAILURE);
      expect(exchange.error).toContain('HTTP 500');

      // L3: even a failed status was received at the HTTP boundary — but no
      // delivery/settlement claim is manufactured from it.
      const observations = exchange.metadata?.observations as string[];
      expect(observations).toContain('http_response_received');
    });

    it('should timeout if response is delayed', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url, timeoutMs: 100 });

      server.setBehavior({ type: 'delay', delayMs: 500, body: { delayed: true } });

      const exchange = await adapter.send('run-1', 'request_resource', { resourceId: 'res-1' });

      expect(exchange.status).toBe(ExchangeStatus.TIMEOUT);
      expect(exchange.error).toContain('timeout');

      // L3 negative guard: NO HTTP response was observed → no observation.
      expect(exchange.metadata?.observations).toBeUndefined();
    });
  });

  describe('sendWithSignature()', () => {
    it('should send payment-signature header and succeed', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      server.setBehavior({ type: '200', body: { paid: true } });

      const signature = Buffer.from(JSON.stringify({ sig: 'test' })).toString('base64');
      const exchange = await adapter.sendWithSignature('run-1', 'request_resource', { resourceId: 'res-1' }, signature);

      expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
      
      const requests = server.getRequests();
      expect(requests.length).toBe(1);
      expect(requests[0].headers['payment-signature']).toBe(signature);

      // L3: the signed retry response is also an externally observable fact.
      const observations = exchange.metadata?.observations as string[];
      expect(observations).toContain('http_response_received');
      expect(observations).not.toContain('payment_required_received');
    });

    it('should handle 402 if signature is rejected', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

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
      server.setBehavior({ type: '402_reject_signature', paymentRequired: paymentRequiredBody });

      const signature = Buffer.from(JSON.stringify({ sig: 'bad' })).toString('base64');
      const exchange = await adapter.sendWithSignature('run-1', 'request_resource', { resourceId: 'res-1' }, signature);

      expect(exchange.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);

      // L3: a second observed 402 on the retry is recorded as an observation.
      const observations = exchange.metadata?.observations as string[];
      expect(observations).toContain('http_response_received');
      expect(observations).toContain('payment_required_received');
    });

    it('should capture payment-response header in metadata', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      const responseBody = { receipt: 'abc' };
      server.setBehavior({ type: '200', body: responseBody });

      const signature = Buffer.from(JSON.stringify({ sig: 'test' })).toString('base64');
      const exchange = await adapter.sendWithSignature('run-1', 'request_resource', { resourceId: 'res-1' }, signature);

      expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
      expect(exchange.metadata?.paymentResponse).toBeDefined();
    });
  });

  describe('receive(), captureEvidence(), disconnect(), reset()', () => {
    it('receive should return INBOUND exchange', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      const exchange = await adapter.receive('run-1', 'observation', { data: 'obs' });

      expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
      expect(exchange.direction).toBe(MessageDirection.INBOUND);
      expect(exchange.payload).toEqual({ data: 'obs' });
    });

    it('captureEvidence should create evidence', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      const evidence = await adapter.captureEvidence('run-1', 'state_change', { state: 'new' }, 'Description');

      expect(evidence.type).toBe('state_change');
      expect(evidence.data).toEqual({ state: 'new' });
      expect(evidence.description).toBe('Description');
    });

    it('disconnect should set isConnected to false', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });

    it('reset should clear exchanges and evidences', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });

      await adapter.send('run-1', 'test', {});
      await adapter.captureEvidence('run-1', 'test', {});

      expect(adapter.getExchanges().length).toBeGreaterThan(0);
      expect(adapter.getEvidences().length).toBeGreaterThan(0);

      adapter.reset();

      expect(adapter.getExchanges().length).toBe(0);
      expect(adapter.getEvidences().length).toBe(0);
    });
  });

  describe('configurable HTTP method (W7 regression)', () => {
    it('should use POST when no method option is configured', async () => {
      const { url } = await server.start();
      await adapter.connect({ transportType: 'x402', endpoint: url });
      await adapter.send('run-1', 'test', {});
      const reqs = server.getRequests();
      expect(reqs.length).toBeGreaterThan(0);
      expect(reqs[reqs.length - 1].method).toBe('POST');
    });

    it('should use GET when options.method = GET', async () => {
      const { url } = await server.start();
      await adapter.connect({
        transportType: 'x402',
        endpoint: url,
        options: { method: 'GET' },
      });
      await adapter.send('run-1', 'test', {});
      const reqs = server.getRequests();
      expect(reqs.length).toBeGreaterThan(0);
      expect(reqs[reqs.length - 1].method).toBe('GET');
    });
  });
});
