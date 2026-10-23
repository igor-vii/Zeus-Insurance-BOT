/**
 * Unit tests for AgentTargetPort contract and MockTargetAdapter implementation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageDirection,
  ExchangeStatus,
} from '../core/AgentTargetPort';
import { MockTargetAdapter } from '../adapters/MockTargetAdapter';

describe('AgentTargetAdapter Contract', () => {
  describe('MockTargetAdapter', () => {
    let adapter: MockTargetAdapter;

    beforeEach(() => {
      adapter = new MockTargetAdapter('test-target');
    });

    describe('getId()', () => {
      it('should return a non-empty string identifier', () => {
        const id = adapter.getId();
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      });

      it('should return unique IDs for different adapter instances', () => {
        const adapter1 = new MockTargetAdapter('target-1');
        const adapter2 = new MockTargetAdapter('target-2');
        expect(adapter1.getId()).not.toBe(adapter2.getId());
      });
    });

    describe('getTargetType()', () => {
      it('should return the configured target type', () => {
        const customAdapter = new MockTargetAdapter('custom-target');
        expect(customAdapter.getTargetType()).toBe('custom-target');
      });

      it('should default to "mock-target" when not specified', () => {
        const defaultAdapter = new MockTargetAdapter();
        expect(defaultAdapter.getTargetType()).toBe('mock-target');
      });
    });

    describe('connect()', () => {
      it('should successfully connect with valid config', async () => {
        const result = await adapter.connect({
          transportType: 'local',
        });

        expect(result.success).toBe(true);
        expect(result.connectionId).toBeDefined();
        expect(adapter.isConnected()).toBe(true);
      });

      it('should simulate connection delay when configured', async () => {
        const startTime = Date.now();
        await adapter.connect({
          transportType: 'local',
          options: { connectionDelayMs: 100 },
        });
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeGreaterThanOrEqual(90); // Allow small margin
      });

      it('should simulate connection failure based on failureRate', async () => {
        // Set failure rate to 100% to guarantee failure
        const failingAdapter = new MockTargetAdapter('failing-target');
        const result = await failingAdapter.connect({
          transportType: 'local',
          options: { failureRate: 1.0 },
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(failingAdapter.isConnected()).toBe(false);
      });
    });

    describe('isConnected()', () => {
      it('should return false before connecting', () => {
        expect(adapter.isConnected()).toBe(false);
      });

      it('should return true after successful connection', async () => {
        await adapter.connect({ transportType: 'local' });
        expect(adapter.isConnected()).toBe(true);
      });

      it('should return false after disconnecting', async () => {
        await adapter.connect({ transportType: 'local' });
        expect(adapter.isConnected()).toBe(true);

        await adapter.disconnect();
        expect(adapter.isConnected()).toBe(false);
      });
    });

    describe('send()', () => {
      beforeEach(async () => {
        await adapter.connect({ transportType: 'local' });
      });

      it('should create an outbound exchange', async () => {
        const runId = 'test-run-1';
        const exchange = await adapter.send(runId, 'test-message', { data: 'payload' });

        expect(exchange.id).toBeDefined();
        expect(exchange.runId).toBe(runId);
        expect(exchange.direction).toBe(MessageDirection.OUTBOUND);
        expect(exchange.type).toBe('test-message');
        expect(exchange.payload).toEqual({ data: 'payload' });
        expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
        expect(exchange.timestamp).toBeDefined();
      });

      it('should throw error when not connected', async () => {
        const disconnectedAdapter = new MockTargetAdapter();
        
        await expect(
          disconnectedAdapter.send('run-1', 'test', {})
        ).rejects.toThrow('Not connected');
      });

      it('should handle undefined payload', async () => {
        const exchange = await adapter.send('run-1', 'test-no-payload');
        
        expect(exchange.payload).toEqual({});
        expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
      });
    });

    describe('receive()', () => {
      beforeEach(async () => {
        await adapter.connect({ transportType: 'local' });
      });

      it('should create an inbound exchange', async () => {
        const runId = 'test-run-1';
        const exchange = await adapter.receive(runId, 'test-response', { result: 'ok' });

        expect(exchange.id).toBeDefined();
        expect(exchange.runId).toBe(runId);
        expect(exchange.direction).toBe(MessageDirection.INBOUND);
        expect(exchange.type).toBe('test-response');
        expect(exchange.payload).toEqual({ result: 'ok' });
        expect(exchange.status).toBe(ExchangeStatus.SUCCESS);
      });

      it('should use canned response when configured', async () => {
        const cannedAdapter = new MockTargetAdapter('canned-target');
        await cannedAdapter.connect({
          transportType: 'local',
          options: {
            cannedResponses: {
              'status-check': { status: 'healthy', uptime: 100 },
            },
          },
        });

        const exchange = await cannedAdapter.receive('run-1', 'status-check', {});

        expect(exchange.payload).toEqual({ status: 'healthy', uptime: 100 });
      });

      it('should throw error when not connected', async () => {
        const disconnectedAdapter = new MockTargetAdapter();
        
        await expect(
          disconnectedAdapter.receive('run-1', 'test', {})
        ).rejects.toThrow('Not connected');
      });
    });

    describe('captureEvidence()', () => {
      beforeEach(async () => {
        await adapter.connect({ transportType: 'local' });
      });

      it('should create an evidence record', async () => {
        const runId = 'test-run-1';
        const evidenceData = { state: 'active', counter: 42 };
        
        const evidence = await adapter.captureEvidence(
          runId,
          'state_change',
          evidenceData,
          'Agent state changed to active'
        );

        expect(evidence.id).toBeDefined();
        expect(evidence.runId).toBe(runId);
        expect(evidence.type).toBe('state_change');
        expect(evidence.data).toEqual(evidenceData);
        expect(evidence.description).toBe('Agent state changed to active');
        expect(evidence.timestamp).toBeDefined();
      });

      it('should work without description', async () => {
        const evidence = await adapter.captureEvidence(
          'run-1',
          'event',
          { value: 123 }
        );

        expect(evidence.description).toBeUndefined();
        expect(evidence.data).toEqual({ value: 123 });
      });
    });

    describe('disconnect()', () => {
      it('should set connected state to false', async () => {
        await adapter.connect({ transportType: 'local' });
        expect(adapter.isConnected()).toBe(true);

        await adapter.disconnect();
        expect(adapter.isConnected()).toBe(false);
      });

      it('should clear configuration', async () => {
        await adapter.connect({
          transportType: 'local',
          timeoutMs: 5000,
        });

        await adapter.disconnect();
        // After disconnect, trying to send should fail
        await expect(
          adapter.send('run-1', 'test', {})
        ).rejects.toThrow('Not connected');
      });
    });

    describe('getExchanges()', () => {
      it('should return all recorded exchanges', async () => {
        await adapter.connect({ transportType: 'local' });

        await adapter.send('run-1', 'msg-1', {});
        await adapter.receive('run-1', 'msg-2', {});
        await adapter.send('run-1', 'msg-3', {});

        const exchanges = adapter.getExchanges();
        expect(exchanges.length).toBe(3);
        expect(exchanges[0].direction).toBe(MessageDirection.OUTBOUND);
        expect(exchanges[1].direction).toBe(MessageDirection.INBOUND);
        expect(exchanges[2].direction).toBe(MessageDirection.OUTBOUND);
      });

      it('should return empty array initially', () => {
        const exchanges = adapter.getExchanges();
        expect(exchanges.length).toBe(0);
      });
    });

    describe('getEvidences()', () => {
      it('should return all recorded evidence', async () => {
        await adapter.connect({ transportType: 'local' });

        await adapter.captureEvidence('run-1', 'type1', { data: 1 });
        await adapter.captureEvidence('run-1', 'type2', { data: 2 });

        const evidences = adapter.getEvidences();
        expect(evidences.length).toBe(2);
      });

      it('should return empty array initially', () => {
        const evidences = adapter.getEvidences();
        expect(evidences.length).toBe(0);
      });
    });

    describe('reset()', () => {
      it('should clear all state', async () => {
        await adapter.connect({ transportType: 'local' });
        await adapter.send('run-1', 'test', {});
        await adapter.captureEvidence('run-1', 'test', {});

        adapter.reset();

        expect(adapter.isConnected()).toBe(false);
        expect(adapter.getExchanges().length).toBe(0);
        expect(adapter.getEvidences().length).toBe(0);
      });
    });
  });

  describe('MessageDirection enum', () => {
    it('should have OUTBOUND value', () => {
      expect(MessageDirection.OUTBOUND).toBe('outbound');
    });

    it('should have INBOUND value', () => {
      expect(MessageDirection.INBOUND).toBe('inbound');
    });
  });

  describe('ExchangeStatus enum', () => {
    it('should have all expected status values', () => {
      expect(ExchangeStatus.PENDING).toBe('pending');
      expect(ExchangeStatus.SUCCESS).toBe('success');
      expect(ExchangeStatus.FAILURE).toBe('failure');
      expect(ExchangeStatus.TIMEOUT).toBe('timeout');
      expect(ExchangeStatus.UNKNOWN).toBe('unknown');
    });
  });
});
