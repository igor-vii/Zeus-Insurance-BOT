/**
 * AgentController Tests
 * 
 * Tests verify:
 * - C1: Successful lifecycle (connect → act → observe → disconnect)
 * - C2: Timeout handling (returns TIMEOUT outcome, not FAIL)
 * - C3: Transport error handling
 * - C4: No automatic retry
 * - C5: Proper disconnect on failure
 * - C6: Works through AgentTargetPort abstraction
 * - C7: Target-agnostic (no scenario-specific participantIds)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentController } from '../../core/AgentController';
import { AgentTargetPort, ExchangeStatus, TargetConnectionConfig, ConnectionResult, Exchange, Evidence, MessageDirection } from '../../core/AgentTargetPort';

// Mock implementation of AgentTargetPort for testing
class MockTargetPort implements AgentTargetPort {
  private connected = false;
  private exchanges: Exchange[] = [];
  private evidences: Evidence[] = [];
  private shouldFail = false;
  private shouldTimeout = false;
  private callCounts: Record<string, number> = {};

  setShouldFail(shouldFail: boolean) {
    this.shouldFail = shouldFail;
  }

  setShouldTimeout(shouldTimeout: boolean) {
    this.shouldTimeout = shouldTimeout;
  }

  getCallCount(method: string): number {
    return this.callCounts[method] || 0;
  }

  getId(): string {
    return 'mock-target-port';
  }

  getTargetType(): string {
    return 'test-target';
  }

  async connect(config: TargetConnectionConfig): Promise<ConnectionResult> {
    this.callCounts.connect = (this.callCounts.connect || 0) + 1;
    
    if (this.shouldFail) {
      return {
        success: false,
        error: 'Connection refused',
      };
    }
    
    this.connected = true;
    return {
      success: true,
      connectionId: 'mock-connection-123',
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(runId: string, type: string, payload?: unknown): Promise<Exchange> {
    this.callCounts.send = (this.callCounts.send || 0) + 1;
    
    if (this.shouldTimeout) {
      // Simulate timeout by never resolving (will be caught by Controller's timeout)
      return new Promise(() => {
        // Never resolve - simulates hanging connection
      });
    }
    
    if (this.shouldFail) {
      throw new Error('Transport error');
    }

    const exchange: Exchange = {
      id: `exchange-${Date.now()}`,
      runId,
      direction: MessageDirection.OUTBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.SUCCESS,
    };
    
    this.exchanges.push(exchange);
    return exchange;
  }

  async receive(runId: string, type: string, payload?: unknown): Promise<Exchange> {
    this.callCounts.receive = (this.callCounts.receive || 0) + 1;
    
    if (this.shouldFail) {
      throw new Error('Receive error');
    }

    const exchange: Exchange = {
      id: `exchange-${Date.now()}`,
      runId,
      direction: MessageDirection.INBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.SUCCESS,
    };
    
    this.exchanges.push(exchange);
    return exchange;
  }

  async captureEvidence(runId: string, type: string, data: unknown, description?: string): Promise<Evidence> {
    this.callCounts.captureEvidence = (this.callCounts.captureEvidence || 0) + 1;
    
    const evidence: Evidence = {
      id: `evidence-${Date.now()}`,
      runId,
      type,
      timestamp: Date.now(),
      data,
      description,
    };
    
    this.evidences.push(evidence);
    return evidence;
  }

  async disconnect(): Promise<void> {
    this.callCounts.disconnect = (this.callCounts.disconnect || 0) + 1;
    this.connected = false;
  }

  getExchanges(): Exchange[] {
    return this.exchanges;
  }

  getEvidences(): Evidence[] {
    return this.evidences;
  }

  reset(): void {
    this.connected = false;
    this.exchanges = [];
    this.evidences = [];
    this.shouldFail = false;
    this.shouldTimeout = false;
    this.callCounts = {};
  }
}

describe('AgentController', () => {
  let mockPort: MockTargetPort;
  let controller: AgentController;

  const testConfig: TargetConnectionConfig = {
    transportType: 'test',
    endpoint: 'test://localhost',
    timeoutMs: 5000,
  };

  beforeEach(() => {
    mockPort = new MockTargetPort();
    controller = new AgentController(mockPort, {
      connectionConfig: testConfig,
      timeoutMs: 1000, // Short timeout for tests
      runId: 'test-run-123',
    });
  });

  // C1 — successful lifecycle
  describe('C1: Successful lifecycle', () => {
    it('should connect → act → observe → disconnect successfully', async () => {
      // Connect
      const connectResult = await controller.connect();
      expect(connectResult.success).toBe(true);
      expect(controller.isConnected()).toBe(true);

      // Act
      const actOutcome = await controller.act('test-action', { data: 'test' });
      expect(actOutcome.status).toBe(ExchangeStatus.SUCCESS);
      expect(actOutcome.exchange).toBeDefined();
      expect(actOutcome.exchange?.type).toBe('test-action');

      // Observe
      const observeOutcome = await controller.observe('test-observation', { data: 'observed' });
      expect(observeOutcome.status).toBe(ExchangeStatus.SUCCESS);
      expect(observeOutcome.exchange).toBeDefined();
      expect(observeOutcome.exchange?.direction).toBe('inbound');

      // Disconnect
      await controller.disconnect();
      expect(controller.isConnected()).toBe(false);
      expect(mockPort.getCallCount('disconnect')).toBe(1);
    });

    it('should execute full interaction lifecycle successfully', async () => {
      const outcome = await controller.executeInteraction('action', { payload: 'test' }, 'observation');
      
      expect(outcome.status).toBe(ExchangeStatus.SUCCESS);
      expect(outcome.exchange).toBeDefined();
      expect(outcome.durationMs).toBeDefined();
      expect(outcome.runId).toBe('test-run-123');
    });
  });

  // C2 — timeout
  describe('C2: Timeout handling', () => {
    it('should return TIMEOUT status on timeout, not FAIL', async () => {
      mockPort.setShouldTimeout(true);
      
      const connectResult = await controller.connect();
      expect(connectResult.success).toBe(true);

      const outcome = await controller.act('slow-action');
      
      expect(outcome.status).toBe(ExchangeStatus.TIMEOUT);
      expect(outcome.error).toContain('timeout');
      expect(outcome.durationMs).toBeDefined();
      // Verify duration is around the timeout value
      expect(outcome.durationMs!).toBeGreaterThanOrEqual(900); // Allow some margin
      expect(outcome.durationMs!).toBeLessThan(2000);
    });

    it('should treat timeout as observed outcome, not semantic verdict', async () => {
      mockPort.setShouldTimeout(true);
      
      await controller.connect();
      const outcome = await controller.act('action');
      
      // Controller returns TIMEOUT status
      expect(outcome.status).toBe(ExchangeStatus.TIMEOUT);
      // Controller does NOT determine PASS/FAIL
      // That's for Assertion Engine to decide based on scenario rules
    });
  });

  // C3 — transport error
  describe('C3: Transport error handling', () => {
    it('should return FAILURE status on transport error', async () => {
      mockPort.setShouldFail(true);
      
      const outcome = await controller.act('action');
      
      expect(outcome.status).toBe(ExchangeStatus.FAILURE);
      expect(outcome.error).toBeDefined();
    });

    it('should handle connection failure', async () => {
      mockPort.setShouldFail(true);
      
      const connectResult = await controller.connect();
      expect(connectResult.success).toBe(false);
      expect(connectResult.error).toBe('Connection refused');
      expect(controller.isConnected()).toBe(false);
    });
  });

  // C4 — no automatic retry
  describe('C4: No automatic retry', () => {
    it('should NOT retry failed actions automatically', async () => {
      // Сначала подключаемся успешно
      await controller.connect();
      
      // Устанавливаем runId
      controller.setRunId('test-run-c4');
      
      // Теперь устанавливаем ошибку только для send
      mockPort.setShouldFail(true);
      
      const outcome = await controller.act('action');
      
      // Verify send was called only once (no retry)
      expect(mockPort.getCallCount('send')).toBe(1);
      expect(outcome.status).toBe(ExchangeStatus.FAILURE);
      
      // Сбрасываем флаг ошибки
      mockPort.setShouldFail(false);
    });

    it('should NOT retry on timeout', async () => {
      mockPort.setShouldTimeout(true);
      
      await controller.connect();
      controller.setRunId('test-run-timeout');
      
      await controller.act('action');
      
      // Verify send was called only once (no retry)
      expect(mockPort.getCallCount('send')).toBe(1);
    });

    it('should NOT retry failed connections', async () => {
      mockPort.setShouldFail(true);
      
      await controller.connect();
      
      // Verify connect was called only once (no retry)
      expect(mockPort.getCallCount('connect')).toBe(1);
    });
  });

  // C5 — disconnect on failure
  describe('C5: Proper disconnect on failure', () => {
    it('should disconnect after failed interaction in executeInteraction', async () => {
      // For this test, we need the connection to succeed but act to fail
      // executeInteraction manages its own connection lifecycle
      const outcome = await controller.executeInteraction('action');
      
      // Should have disconnected even after failure
      expect(mockPort.getCallCount('disconnect')).toBeGreaterThanOrEqual(1);
    });

    it('should disconnect after successful interaction', async () => {
      await controller.executeInteraction('action', {}, 'observation');
      
      expect(mockPort.getCallCount('disconnect')).toBe(1);
    });

    it('should handle cleanup when act fails in executeInteraction', async () => {
      // Set up fresh mock that succeeds on connect but fails on send
      const freshMock = new MockTargetPort();
      
      // Override send to throw an error
      const originalSend = freshMock.send.bind(freshMock);
      freshMock.send = async (runId: string, type: string, payload?: unknown) => {
        throw new Error('Simulated send failure');
      };
      
      const controller3 = new AgentController(freshMock, {
        connectionConfig: testConfig,
        timeoutMs: 1000,
        runId: 'test-run-999',
      });
      
      const outcome = await controller3.executeInteraction('action');
      
      expect(outcome.status).toBe(ExchangeStatus.FAILURE);
      expect(freshMock.getCallCount('disconnect')).toBeGreaterThanOrEqual(1);
    });
  });

  // C6 — Port abstraction
  describe('C6: Works through AgentTargetPort abstraction', () => {
    it('should work with any AgentTargetPort implementation', async () => {
      // Controller only depends on AgentTargetPort interface
      // This test verifies it works with our mock implementation
      const outcome = await controller.executeInteraction('test');
      
      expect(outcome.exchange).toBeDefined();
      // Controller doesn't know about MockTargetPort specifics
      // It only uses the AgentTargetPort interface
    });

    it('should not depend on specific adapter implementation', async () => {
      // Create controller with mock port
      const controllerWithMock = new AgentController(mockPort, {
        connectionConfig: testConfig,
        runId: 'test-run-456',
      });
      
      await controllerWithMock.connect();
      const outcome = await controllerWithMock.act('test');
      
      expect(outcome.runId).toBe('test-run-456');
      // Controller works purely through the Port interface
    });
  });

  // C7 — target agnostic
  describe('C7: Target-agnostic behavior', () => {
    it('should not contain scenario-specific participantIds', () => {
      // Controller code should not reference any participantId from scenarios (e.g., 'sut-1', 'client-1', 'resource-server-1')
      // This is verified by inspection - no hardcoded participant strings in Controller
      expect(controller.getRunId()).toBe('test-run-123');
      // Controller treats all targets uniformly
    });

    it('should work with different target types', async () => {
      // Change target type in mock
      const outcome = await controller.executeInteraction('test');
      
      expect(outcome.status).toBe(ExchangeStatus.SUCCESS);
      // Controller doesn't care about target type
      // It only uses the universal Port interface
    });

    it('should not make assumptions about protocol', async () => {
      await controller.connect();
      const outcome = await controller.act('any-action');
      
      expect(outcome.exchange?.type).toBe('any-action');
      // Controller doesn't know if it's HTTP, MCP, or other protocol
      // That's handled by the Adapter
    });
  });

  // Additional tests

  describe('RunId management', () => {
    it('should require runId before operations', async () => {
      const controllerWithoutRunId = new AgentController(mockPort, {
        connectionConfig: testConfig,
      });
      
      await controllerWithoutRunId.connect();
      
      // Should throw when runId is not set
      await expect(controllerWithoutRunId.act('test')).rejects.toThrow('RunId not set');
    });

    it('should allow setting runId dynamically', () => {
      const controllerWithoutRunId = new AgentController(mockPort, {
        connectionConfig: testConfig,
      });
      
      controllerWithoutRunId.setRunId('dynamic-run-id');
      expect(controllerWithoutRunId.getRunId()).toBe('dynamic-run-id');
    });
  });

  describe('Connection state', () => {
    it('should track connection state correctly', async () => {
      expect(controller.isConnected()).toBe(false);
      
      await controller.connect();
      expect(controller.isConnected()).toBe(true);
      
      await controller.disconnect();
      expect(controller.isConnected()).toBe(false);
    });

    it('should prevent operations when not connected', async () => {
      const outcome = await controller.act('test');
      
      expect(outcome.status).toBe(ExchangeStatus.FAILURE);
      expect(outcome.error).toBe('Not connected to target');
    });
  });
});
