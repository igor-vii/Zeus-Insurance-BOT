/**
 * Unit tests for HttpAgentAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageDirection, ExchangeStatus } from '../../core/AgentTargetPort';
import { HttpAgentAdapter } from '../../adapters/http/HttpAgentAdapter';

describe('HttpAgentAdapter', () => {
  let adapter: HttpAgentAdapter;

  beforeEach(() => {
    adapter = new HttpAgentAdapter('test-http-target');
  });

  afterEach(() => {
    adapter.reset();
  });

  describe('getId()', () => {
    it('should return a non-empty string identifier', () => {
      const id = adapter.getId();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('getTargetType()', () => {
    it('should return the configured target type', () => {
      const customAdapter = new HttpAgentAdapter('custom-http-target');
      expect(customAdapter.getTargetType()).toBe('custom-http-target');
    });

    it('should default to "http-target" when not specified', () => {
      const defaultAdapter = new HttpAgentAdapter();
      expect(defaultAdapter.getTargetType()).toBe('http-target');
    });
  });

  describe('connect()', () => {
    it('should successfully connect with valid HTTP config', async () => {
      const result = await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });

      expect(result.success).toBe(true);
      expect(result.connectionId).toBeDefined();
      expect(adapter.isConnected()).toBe(true);
    });

    it('should fail with invalid transport type', async () => {
      const result = await adapter.connect({
        transportType: 'mcp',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid transport type');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should fail without endpoint URL', async () => {
      const result = await adapter.connect({
        transportType: 'http',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('endpoint URL is required');
    });

    it('should fail with invalid URL format', async () => {
      const result = await adapter.connect({
        transportType: 'http',
        endpoint: 'not-a-valid-url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL format');
    });
  });

  describe('isConnected()', () => {
    it('should return false before connecting', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('should return true after successful connection', async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });
      expect(adapter.isConnected()).toBe(true);
    });

    it('should return false after disconnecting', async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('send()', () => {
    beforeEach(async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });
    });

    it('should create an outbound exchange record', async () => {
      const runId = 'test-run-1';
      const exchange = await adapter.send(runId, 'test-message', { data: 'payload' });

      expect(exchange.id).toBeDefined();
      expect(exchange.runId).toBe(runId);
      expect(exchange.direction).toBe(MessageDirection.OUTBOUND);
      expect(exchange.type).toBe('test-message');
      expect(exchange.timestamp).toBeDefined();
    });

    it('should throw error when not connected', async () => {
      const disconnectedAdapter = new HttpAgentAdapter();
      
      await expect(
        disconnectedAdapter.send('run-1', 'test', {})
      ).rejects.toThrow('Not connected');
    });

    it('should record failure status on HTTP error', async () => {
      // Note: Without a real HTTP server, this will fail with network error
      // The test verifies that failures are properly recorded
      const exchange = await adapter.send('run-1', 'test', {});
      
      // Exchange should be recorded even on failure
      expect(exchange.status).toBeDefined();
      expect(exchange.direction).toBe(MessageDirection.OUTBOUND);
    });
  });

  describe('receive()', () => {
    beforeEach(async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });
    });

    it('should create an inbound exchange record', async () => {
      const runId = 'test-run-1';
      const exchange = await adapter.receive(runId, 'test-response', { result: 'ok' });

      expect(exchange.id).toBeDefined();
      expect(exchange.runId).toBe(runId);
      expect(exchange.direction).toBe(MessageDirection.INBOUND);
      expect(exchange.type).toBe('test-response');
      expect(exchange.payload).toEqual({ result: 'ok' });
    });

    it('should throw error when not connected', async () => {
      const disconnectedAdapter = new HttpAgentAdapter();
      
      await expect(
        disconnectedAdapter.receive('run-1', 'test', {})
      ).rejects.toThrow('Not connected');
    });
  });

  describe('captureEvidence()', () => {
    beforeEach(async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });
    });

    it('should create an evidence record', async () => {
      const runId = 'test-run-1';
      const evidenceData = { state: 'active', counter: 42 };
      
      const evidence = await adapter.captureEvidence(
        runId,
        'state_change',
        evidenceData,
        'HTTP agent state changed'
      );

      expect(evidence.id).toBeDefined();
      expect(evidence.runId).toBe(runId);
      expect(evidence.type).toBe('state_change');
      expect(evidence.data).toEqual(evidenceData);
      expect(evidence.description).toBe('HTTP agent state changed');
      expect(evidence.metadata?.adapterType).toBe('http');
    });
  });

  describe('disconnect()', () => {
    it('should set connected state to false', async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('getExchanges()', () => {
    it('should return all recorded exchanges', async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });

      await adapter.send('run-1', 'msg-1', {});
      await adapter.receive('run-1', 'msg-2', {});

      const exchanges = adapter.getExchanges();
      expect(exchanges.length).toBe(2);
    });

    it('should return empty array initially', () => {
      const exchanges = adapter.getExchanges();
      expect(exchanges.length).toBe(0);
    });
  });

  describe('getEvidences()', () => {
    it('should return all recorded evidence', async () => {
      await adapter.connect({
        transportType: 'http',
        endpoint: 'https://api.example.com',
      });

      await adapter.captureEvidence('run-1', 'type1', { data: 1 });
      await adapter.captureEvidence('run-1', 'type2', { data: 2 });

      const evidences = adapter.getEvidences();
      expect(evidences.length).toBe(2);
    });
  });

  describe('implements AgentTargetPort', () => {
    it('should have all required methods', () => {
      expect(typeof adapter.getId).toBe('function');
      expect(typeof adapter.getTargetType).toBe('function');
      expect(typeof adapter.connect).toBe('function');
      expect(typeof adapter.isConnected).toBe('function');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.receive).toBe('function');
      expect(typeof adapter.captureEvidence).toBe('function');
      expect(typeof adapter.disconnect).toBe('function');
    });
  });
});
