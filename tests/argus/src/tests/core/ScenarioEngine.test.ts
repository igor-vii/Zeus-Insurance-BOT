import { describe, it, expect, beforeEach } from 'vitest';
import { ScenarioEngine } from '../../core/ScenarioEngine';
import { ScenarioDefinition } from '../../core/ScenarioDefinition';
import { AgentController } from '../../core/AgentController';
import { MockTargetAdapter } from '../../adapters/MockTargetAdapter';
import { RunContext, RunStatus } from '../../core/RunLifecycle';
import { FaultInjector } from '../../core/FaultInjector';
import { ExecutionRegistry } from '../../core/ExecutionRegistry';
import { Fault } from '../../core/Fault';

describe('ScenarioEngine', () => {
  let engine: ScenarioEngine;
  let mockController: AgentController;
  let mockTarget: MockTargetAdapter;
  let faultInjector: FaultInjector;

  beforeEach(() => {
    mockTarget = new MockTargetAdapter('mock');
    mockController = new AgentController(mockTarget, { connectionConfig: { transportType: 'mock' }, timeoutMs: 30000, runId: 'test-run-id' });
    faultInjector = new FaultInjector();
  });

  it('should execute scenario timeline sequentially', async () => {
    const scenario: ScenarioDefinition = {
      id: 'test-scenario',
      name: 'Test Timeline',
      participants: [
        { participantId: 'sut-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' }
      ],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [
        { actor: 'sut-1', type: 'ACTION_1', payload: {} },
        { actor: 'sut-1', type: 'ACTION_2', payload: {} },
        { actor: 'sut-1', type: 'ACTION_3', payload: {} },
      ],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 42,
    };

    const context: RunContext = {
      runId: 'run-123',
      scenarioId: 'test-scenario',
      seed: 42,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const registry = new ExecutionRegistry();
    registry.register('sut-1', mockController);
    engine = new ScenarioEngine(scenario, context, registry, faultInjector);

    // Execute and verify no errors thrown
    await expect(engine.execute()).resolves.not.toThrow();

    // Verify run status updated
    expect(context.status).toBe(RunStatus.COMPLETED);
  });

  it('should pass runId and seed to execution context', async () => {
    const scenario: ScenarioDefinition = {
      id: 'seed-test',
      name: 'Seed Test',
      participants: [
        { participantId: 'sut-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' }
      ],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [{ actor: 'sut-1', type: 'CHECK_SEED', payload: {} }],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 999,
    };

    const context: RunContext = {
      runId: 'run-seed-123',
      scenarioId: 'seed-test',
      seed: 999,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const registry = new ExecutionRegistry();
    registry.register('sut-1', mockController);
    engine = new ScenarioEngine(scenario, context, registry, faultInjector);
    await engine.execute();

    expect(context.runId).toBe('run-seed-123');
    expect(context.seed).toBe(999);
  });

  it('should handle runtime failure gracefully', async () => {
    // Setup target to fail on send
    const originalSend = mockTarget.send;
    mockTarget.send = async () => { throw new Error('Simulated Failure'); };

    const scenario: ScenarioDefinition = {
      id: 'fail-test',
      name: 'Failure Test',
      participants: [
        { participantId: 'sut-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' }
      ],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [{ actor: 'sut-1', type: 'FAIL_ACTION', payload: {} }],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 1,
    };

    const context: RunContext = {
      runId: 'run-fail',
      scenarioId: 'fail-test',
      seed: 1,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const registry = new ExecutionRegistry();
    registry.register('sut-1', mockController);
    engine = new ScenarioEngine(scenario, context, registry, faultInjector);

    // Should not throw unhandled error, but status should reflect failure or completion with errors
    await expect(engine.execute()).resolves.not.toThrow();
    // Depending on implementation, status might be FAILED or COMPLETED with error evidence

    // Restore original send
    mockTarget.send = originalSend;
  });

  it('should route action.actor to the correct controller', async () => {
    const clientTarget = new MockTargetAdapter('buyer-mock');
    const resourceServerTarget = new MockTargetAdapter('seller-mock');

    const clientController = new AgentController(clientTarget, {
      connectionConfig: { transportType: 'mock' },
      runId: 'buyer-run',
    });
    const resourceServerController = new AgentController(resourceServerTarget, {
      connectionConfig: { transportType: 'mock' },
      runId: 'seller-run',
    });

    await clientController.connect();
    await resourceServerController.connect();

    const registry = new ExecutionRegistry();
    registry.register('client-1', clientController);
    registry.register('resource-server-1', resourceServerController);

    const scenario: ScenarioDefinition = {
      id: 'routing-test',
      name: 'Routing Test',
      participants: [
        { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
        { participantId: 'resource-server-1', protocolRole: 'RESOURCE_SERVER', ownership: 'ARGUS' },
      ],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [
        { actor: 'client-1', type: 'CLIENT_ACTION', payload: {} },
        { actor: 'resource-server-1', type: 'RESOURCE_SERVER_ACTION', payload: {} },
      ],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 1,
    };

    const context: RunContext = {
      runId: 'routing-run',
      scenarioId: 'routing-test',
      seed: 1,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const engine = new ScenarioEngine(scenario, context, registry, faultInjector);
    await engine.execute();

    const clientExchanges = clientTarget.getExchanges();
    expect(clientExchanges.length).toBe(1);
    expect(clientExchanges[0].type).toBe('CLIENT_ACTION');

    const resourceServerExchanges = resourceServerTarget.getExchanges();
    expect(resourceServerExchanges.length).toBe(1);
    expect(resourceServerExchanges[0].type).toBe('RESOURCE_SERVER_ACTION');
  });

  it('should throw if action.actor is not registered', async () => {
    const registry = new ExecutionRegistry();

    const scenario: ScenarioDefinition = {
      id: 'unknown-actor-test',
      name: 'Unknown Actor Test',
      participants: [],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [
        { actor: 'unknown-actor', type: 'SOME_ACTION', payload: {} },
      ],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 1,
    };

    const context: RunContext = {
      runId: 'unknown-run',
      scenarioId: 'unknown-actor-test',
      seed: 1,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const engine = new ScenarioEngine(scenario, context, registry, faultInjector);

    await expect(engine.execute()).rejects.toThrow(
      'No controller registered for actor: unknown-actor'
    );
  });

  it('should work with single controller (backward compatibility)', async () => {
    const singleTarget = new MockTargetAdapter('single-mock');
    const singleController = new AgentController(singleTarget, {
      connectionConfig: { transportType: 'mock' },
      runId: 'single-run',
    });

    await singleController.connect();

    const registry = new ExecutionRegistry();
    registry.register('sut-1', singleController);

    const scenario: ScenarioDefinition = {
      id: 'single-controller-test',
      name: 'Single Controller Test',
      participants: [
        { participantId: 'sut-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' },
      ],
      topology: { edges: [] },
      testSubject: 'sut-1',
      actions: [
        { actor: 'sut-1', type: 'ACTION_1', payload: {} },
        { actor: 'sut-1', type: 'ACTION_2', payload: {} },
      ],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 1,
    };

    const context: RunContext = {
      runId: 'single-run',
      scenarioId: 'single-controller-test',
      seed: 1,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const engine = new ScenarioEngine(scenario, context, registry, faultInjector);
    await expect(engine.execute()).resolves.not.toThrow();

    const exchanges = singleTarget.getExchanges();
    expect(exchanges.length).toBe(2);
    expect(exchanges[0].type).toBe('ACTION_1');
    expect(exchanges[1].type).toBe('ACTION_2');
  });

  // ============================================================
  // L0-F2 end-to-end: scenario → execute() → fault applied → effect observed
  // ============================================================

  const makeFaultScenario = (faults: Fault[]): ScenarioDefinition => ({
    id: 'e2e-fault-test',
    name: 'End-to-End Fault Test',
    participants: [
      { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    ],
    topology: { edges: [] },
    testSubject: 'sut-1',
    actions: [
      { actor: 'client-1', type: 'request_payment', payload: { requestId: 'req-e2e' } },
    ],
    faults,
    invariants: [],
    assertions: [],
    seed: 1,
  });

  it('end-to-end: duplicate_request fault on action_request_payment executes the operation twice', async () => {
    const scenario = makeFaultScenario([
      {
        target: { kind: 'participant', participantId: 'client-1' },
        type: 'duplicate_request',
        trigger: 'action_request_payment',
        config: { repeat_count: 2 },
      },
    ]);

    const context: RunContext = {
      runId: 'run-e2e-duplicate',
      scenarioId: scenario.id,
      seed: scenario.seed,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const e2eTarget = new MockTargetAdapter('e2e-mock');
    const e2eController = new AgentController(e2eTarget, {
      connectionConfig: { transportType: 'mock' },
      timeoutMs: 30000,
      runId: context.runId,
    });
    await e2eController.connect();

    const registry = new ExecutionRegistry();
    registry.register('client-1', e2eController);

    const injector = new FaultInjector(scenario.faults);
    const engine = new ScenarioEngine(scenario, context, registry, injector);
    await engine.execute();

    // The fault was really applied through the full dispatch path:
    // one declared action executed the underlying operation twice.
    const exchanges = e2eTarget.getExchanges().filter((e) => e.type === 'request_payment');
    expect(exchanges).toHaveLength(2);
    expect(context.status).toBe(RunStatus.COMPLETED);
  });

  it('end-to-end: crash fault on action_request_payment makes execute() throw', async () => {
    const scenario = makeFaultScenario([
      {
        target: { kind: 'participant', participantId: 'client-1' },
        type: 'crash',
        trigger: 'action_request_payment',
        config: {},
      },
    ]);

    const context: RunContext = {
      runId: 'run-e2e-crash',
      scenarioId: scenario.id,
      seed: scenario.seed,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };

    const e2eTarget = new MockTargetAdapter('e2e-crash-mock');
    const e2eController = new AgentController(e2eTarget, {
      connectionConfig: { transportType: 'mock' },
      timeoutMs: 30000,
      runId: context.runId,
    });
    await e2eController.connect();

    const registry = new ExecutionRegistry();
    registry.register('client-1', e2eController);

    const injector = new FaultInjector(scenario.faults);
    const engine = new ScenarioEngine(scenario, context, registry, injector);

    await expect(engine.execute()).rejects.toThrow('Simulated crash');
    expect(context.status).toBe(RunStatus.FAILED);

    // The operation ran once before the simulated crash was raised.
    const exchanges = e2eTarget.getExchanges().filter((e) => e.type === 'request_payment');
    expect(exchanges).toHaveLength(1);
  });
});
