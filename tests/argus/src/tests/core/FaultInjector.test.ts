import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FaultInjector } from '../../core/FaultInjector';
import { Fault } from '../../core/Fault';
import { ScenarioEngine } from '../../core/ScenarioEngine';
import { ScenarioDefinition } from '../../core/ScenarioDefinition';
import { AgentController } from '../../core/AgentController';
import { MockTargetAdapter } from '../../adapters/MockTargetAdapter';
import { RunContext, RunStatus } from '../../core/RunLifecycle';
import { ExecutionRegistry } from '../../core/ExecutionRegistry';

describe('FaultInjector', () => {
  let injector: FaultInjector;

  beforeEach(() => {
    injector = new FaultInjector();
  });

  it('duplicate_request should call operation twice', async () => {
    let callCount = 0;
    const operation = async () => { callCount++; return 'result'; };
    const fault: Fault = {
      target: { kind: 'participant', participantId: 'test' },
      trigger: 'action_test',
      type: 'duplicate_request',
      config: { repeat_count: 2 }
    };

    await injector.apply(fault, operation);

    expect(callCount).toBe(2);
  });

  it('delayed_response should add delay', async () => {
    const start = Date.now();
    const operation = async () => 'result';
    const fault: Fault = {
      target: { kind: 'participant', participantId: 'test' },
      trigger: 'action_test',
      type: 'delayed_response',
      config: { delay_ms: 100 }
    };

    await injector.apply(fault, operation);

    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(90); // Allow small margin
  });

  it('crash should throw error', async () => {
    const operation = async () => 'result';
    const fault: Fault = {
      target: { kind: 'participant', participantId: 'test' },
      trigger: 'action_test',
      type: 'crash',
      config: {}
    };

    await expect(injector.apply(fault, operation))
      .rejects.toThrow('Simulated crash');
  });

  it('concurrent_request should execute in parallel', async () => {
    const operation = async () => {
      await new Promise(r => setTimeout(r, 50));
      return 'result';
    };
    const fault: Fault = {
      target: { kind: 'participant', participantId: 'test' },
      trigger: 'action_test',
      type: 'concurrent_request',
      config: { parallel_count: 3 }
    };
    const start = Date.now();

    await injector.apply(fault, operation);

    const duration = Date.now() - start;
    // If sequential: 150ms. If parallel: ~50ms.
    expect(duration).toBeLessThan(100);
  });

  it('lost_delivery should throw error for lost response', async () => {
    const operation = async () => ({ status: 'OK' });
    // Use 100% drop probability to ensure loss
    const fault: Fault = {
      target: { kind: 'participant', participantId: 'test' },
      trigger: 'action_test',
      type: 'lost_delivery',
      config: { drop_probability: 1.0 }
    };

    await expect(injector.apply(fault, operation))
      .rejects.toThrow('Delivery lost in transit');
  });
    it('dispatches active participant faults only when target equals action actor', () => {
      const fault: Fault = {
        target: { kind: 'participant', participantId: 'client-1' },
        trigger: 'action_request_payment',
        type: 'duplicate_request',
        config: { repeat_count: 2 },
      };
      injector.registerFault(fault);
  
      expect(injector.getFaultsForEvent('action_request_payment', 'client-1')).toHaveLength(1);
      expect(injector.getFaultsForEvent('action_request_payment', 'resource-server-1')).toHaveLength(0);
    });
  
    it('does not recursively dispatch lifecycle events', () => {
      injector.registerFault({
        target: { kind: 'participant', participantId: 'resource-server-1' },
        trigger: 'payment_settled',
        type: 'crash',
        config: {},
      });
  
      expect(injector.getFaultsForEvent('payment_settled', 'resource-server-1')).toHaveLength(0);
    });
  
    it('keeps respond as a separate baseline behavior path', () => {
      injector.registerFault({
        target: { kind: 'participant', participantId: 'resource-server-1' },
        trigger: 'action_request_payment',
        type: 'respond',
        config: { emit: 'delivery_sent' },
      });
  
      expect(injector.getFaultsForEvent('action_request_payment', 'client-1')).toHaveLength(0);
      expect(injector.getRespondersForEvent('action_request_payment')).toHaveLength(1);
    });
  
  it('ScenarioEngine never calls getFaultsForEvent with lifecycle triggers', async () => {
    // Scenario with an action-triggered fault AND declared-only faults on
    // every L0-F2 lifecycle trigger. The engine must only consult the
    // injector with action_* event types, never with lifecycle events.
    const scenario: ScenarioDefinition = {
      id: 'lifecycle-spy-test',
      name: 'Lifecycle Spy Test',
      participants: [
        { participantId: 'sut-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' },
      ],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [
        { actor: 'sut-1', type: 'request_payment', payload: { requestId: 'req-spy' } },
      ],
      faults: [
        {
          target: { kind: 'participant', participantId: 'sut-1' },
          type: 'duplicate_request',
          trigger: 'action_request_payment',
          config: { repeat_count: 2 },
        },
        // Declared-only lifecycle faults: must not enter active dispatch.
        {
          target: { kind: 'participant', participantId: 'sut-1' },
          type: 'crash',
          trigger: 'delivery_started',
          config: {},
        },
        {
          target: { kind: 'participant', participantId: 'sut-1' },
          type: 'crash',
          trigger: 'payment_settled',
          config: {},
        },
        {
          target: { kind: 'participant', participantId: 'sut-1' },
          type: 'crash',
          trigger: 'settlement_unknown',
          config: {},
        },
        {
          target: { kind: 'participant', participantId: 'sut-1' },
          type: 'crash',
          trigger: 'delivery_sent',
          config: {},
        },
      ],
      invariants: [],
      assertions: [],
      seed: 7,
    };

    const context: RunContext = {
      runId: 'run-lifecycle-spy',
      scenarioId: scenario.id,
      seed: scenario.seed,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const mockTarget = new MockTargetAdapter('lifecycle-spy-mock');
    const controller = new AgentController(mockTarget, {
      connectionConfig: { transportType: 'mock' },
      timeoutMs: 30000,
      runId: context.runId,
    });
    await controller.connect();

    const registry = new ExecutionRegistry();
    registry.register('sut-1', controller);

    const spyInjector = new FaultInjector(scenario.faults);
    const getFaultsSpy = vi.spyOn(spyInjector, 'getFaultsForEvent');

    const engine = new ScenarioEngine(scenario, context, registry, spyInjector);
    await engine.execute();

    // Every call made by the engine used an action_* event type.
    expect(getFaultsSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [eventType] of getFaultsSpy.mock.calls) {
      expect(eventType.startsWith('action_')).toBe(true);
    }

    // Lifecycle triggers were never passed to getFaultsForEvent —
    // neither directly nor any other way.
    const lifecycleTriggers = [
      'delivery_started',
      'payment_settled',
      'settlement_unknown',
      'delivery_sent',
    ] as const;
    for (const trigger of lifecycleTriggers) {
      expect(getFaultsSpy.mock.calls.filter(([eventType]) => eventType === trigger)).toHaveLength(0);
    }

    getFaultsSpy.mockRestore();
  });

});
