/**
 * Unit tests for McpAgentAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageDirection } from '../../core/AgentTargetPort';
import { McpAgentAdapter } from '../../adapters/mcp/McpAgentAdapter';

describe('McpAgentAdapter', () => {
  let adapter: McpAgentAdapter;

  beforeEach(() => {
    adapter = new McpAgentAdapter('test-mcp-target');
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
      const customAdapter = new McpAgentAdapter('custom-mcp-target');
      expect(customAdapter.getTargetType()).toBe('custom-mcp-target');
    });

    it('should default to "mcp-target" when not specified', () => {
      const defaultAdapter = new McpAgentAdapter();
      expect(defaultAdapter.getTargetType()).toBe('mcp-target');
    });
  });

  describe('connect()', () => {
    it('should successfully connect with valid MCP stdio config', async () => {
      const result = await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          args: ['server.js'],
          transport: 'stdio',
        },
      });

      expect(result.success).toBe(true);
      expect(result.connectionId).toBeDefined();
      expect(adapter.isConnected()).toBe(true);
    });

    it('should successfully connect with valid MCP SSE config', async () => {
      const result = await adapter.connect({
        transportType: 'mcp',
        options: {
          url: 'http://localhost:3000/mcp',
          transport: 'sse',
        },
      });

      expect(result.success).toBe(true);
      expect(result.connectionId).toBeDefined();
    });

    it('should fail with invalid transport type', async () => {
      const result = await adapter.connect({
        transportType: 'http',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid transport type');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should fail without command for stdio transport', async () => {
      const result = await adapter.connect({
        transportType: 'mcp',
        options: {
          transport: 'stdio',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('command is required');
    });

    it('should fail without URL for SSE transport', async () => {
      const result = await adapter.connect({
        transportType: 'mcp',
        options: {
          transport: 'sse',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('URL is required');
    });
  });

  describe('isConnected()', () => {
    it('should return false before connecting', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('should return true after successful connection', async () => {
      await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          transport: 'stdio',
        },
      });
      expect(adapter.isConnected()).toBe(true);
    });

    it('should return false after disconnecting', async () => {
      await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          transport: 'stdio',
        },
      });
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('send()', () => {
    beforeEach(async () => {
      await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          transport: 'stdio',
        },
      });
    });

    it('should create an outbound exchange record', async () => {
      const runId = 'test-run-1';
      const exchange = await adapter.send(runId, 'test-tool-call', { param: 'value' });

      expect(exchange.id).toBeDefined();
      expect(exchange.runId).toBe(runId);
      expect(exchange.direction).toBe(MessageDirection.OUTBOUND);
      expect(exchange.type).toBe('test-tool-call');
      expect(exchange.timestamp).toBeDefined();
    });

    it('should include MCP message format in metadata', async () => {
      const exchange = await adapter.send('run-1', 'test-method', { data: 'test' });

      expect(exchange.metadata).toBeDefined();
      expect(exchange.metadata?.mcpMessageType).toBe('tool_call');
      expect(exchange.metadata?.mcpMessage).toBeDefined();
    });

    it('should throw error when not connected', async () => {
      const disconnectedAdapter = new McpAgentAdapter();
      
      await expect(
        disconnectedAdapter.send('run-1', 'test', {})
      ).rejects.toThrow('Not connected');
    });
  });

  describe('receive()', () => {
    beforeEach(async () => {
      await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          transport: 'stdio',
        },
      });
    });

    it('should create an inbound exchange record', async () => {
      const runId = 'test-run-1';
      const exchange = await adapter.receive(runId, 'notification', { event: 'data' });

      expect(exchange.id).toBeDefined();
      expect(exchange.runId).toBe(runId);
      expect(exchange.direction).toBe(MessageDirection.INBOUND);
      expect(exchange.type).toBe('notification');
    });

    it('should throw error when not connected', async () => {
      const disconnectedAdapter = new McpAgentAdapter();
      
      await expect(
        disconnectedAdapter.receive('run-1', 'test', {})
      ).rejects.toThrow('Not connected');
    });
  });

  describe('captureEvidence()', () => {
    beforeEach(async () => {
      await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          transport: 'stdio',
        },
      });
    });

    it('should create an evidence record', async () => {
      const runId = 'test-run-1';
      const evidenceData = { mcpEvent: 'tool_result', value: 42 };
      
      const evidence = await adapter.captureEvidence(
        runId,
        'mcp_event',
        evidenceData,
        'MCP tool execution result'
      );

      expect(evidence.id).toBeDefined();
      expect(evidence.runId).toBe(runId);
      expect(evidence.type).toBe('mcp_event');
      expect(evidence.data).toEqual(evidenceData);
      expect(evidence.description).toBe('MCP tool execution result');
      expect(evidence.metadata?.adapterType).toBe('mcp');
    });
  });

  describe('disconnect()', () => {
    it('should set connected state to false', async () => {
      await adapter.connect({
        transportType: 'mcp',
        options: {
          command: 'node',
          transport: 'stdio',
        },
      });
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
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
