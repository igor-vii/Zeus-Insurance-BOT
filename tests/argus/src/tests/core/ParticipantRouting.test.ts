import { describe, expect, it } from 'vitest';
import {
  AgentTargetPort,
  ConnectionResult,
  Exchange,
  ExchangeStatus,
  MessageDirection,
  RunId,
  TargetConnectionConfig,
  Evidence,
  Metadata,
} from '../../core/AgentTargetPort';
import { AgentController } from '../../core/AgentController';
import { ExecutionRegistry } from '../../core/ExecutionRegistry';
import { ScenarioEngine } from '../../core/ScenarioEngine';
import { FaultInjector } from '../../core/FaultInjector';
import { EvidenceCollector } from '../../core/EvidenceCollector';
import { RunStatus, RunContext } from '../../core/RunLifecycle';
import { ScenarioDefinition } from '../../core/ScenarioDefinition';

class RecordingPort implements AgentTargetPort {
  private connected = false;
  readonly sent: Array<{ type: string; payload?: unknown }> = [];

  constructor(private readonly name: string) {}

  getId(): string { return this.name; }
  getTargetType(): string { return 'test'; }

  async connect(_config: TargetConnectionConfig): Promise<ConnectionResult> {
    this.connected = true;
    return { success: true, connectionId: this.name };
  }

  isConnected(): boolean { return this.connected; }

  async send(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    if (!this.connected) throw new Error('not connected');
    this.sent.push({ type, payload });

    return {
      id: `exchange-${this.name}-${this.sent.length}`,
      runId,
      direction: MessageDirection.OUTBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.SUCCESS,
      metadata: {
        observations: [type === 'client_action' ? 'client_observed' : 'seller_observed'],
      } as Metadata,
    };
  }

  async receive(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    return {
      id: `receive-${this.name}`,
      runId,
      direction: MessageDirection.INBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.SUCCESS,
    };
  }

  async captureEvidence(
    runId: RunId,
    type: string,
    data: unknown,
    description?: string
  ): Promise<Evidence> {
    return {
      id: `evidence-${this.name}`,
      runId,
      type,
      timestamp: Date.now(),
      data,
      description,
      metadata: { adapter: this.name },
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

describe('participant → controller → adapter routing', () => {
  it('routes each action to the controller registered for its actor and preserves actor identity', async () => {
    const clientPort = new RecordingPort('client-port');
    const sellerPort = new RecordingPort('seller-port');

    const clientController = new AgentController(clientPort, {
      connectionConfig: { transportType: 'test', endpoint: 'client' },
      participantId: 'client-1',
      runId: 'run-b2-routing',
    });
    const sellerController = new AgentController(sellerPort, {
      connectionConfig: { transportType: 'test', endpoint: 'seller' },
      participantId: 'resource-server-1',
      runId: 'run-b2-routing',
    });

    await clientController.connect();
    await sellerController.connect();

    const registry = new ExecutionRegistry();
    registry.register('client-1', clientController);
    registry.register('resource-server-1', sellerController);

    const scenario: ScenarioDefinition = {
      id: 'B2-routing',
      name: 'B2 participant routing',
      description: 'Minimal participant-aware routing proof',
      participants: [
        { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
        { participantId: 'resource-server-1', protocolRole: 'RESOURCE_SERVER', ownership: 'ARGUS' },
      ],
      topology: {
        edges: [
          { from: 'client-1', to: 'resource-server-1', kind: 'request' },
        ],
      },
      testSubject: 'sut-1',
      actions: [
        { actor: 'client-1', type: 'client_action', payload: { side: 'client' } },
        { actor: 'resource-server-1', type: 'seller_action', payload: { side: 'seller' } },
      ],
      faults: [],
      invariants: [],
      assertions: [],
      seed: 1,
    };

    const context: RunContext = {
      runId: 'run-b2-routing',
      scenarioId: scenario.id,
      seed: scenario.seed,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };
    const evidenceCollector = new EvidenceCollector();

    const engine = new ScenarioEngine(
      scenario,
      context,
      registry,
      new FaultInjector([]),
      evidenceCollector,
    );

    await engine.execute();

    expect(clientPort.sent).toEqual([
      { type: 'client_action', payload: { side: 'client' } },
    ]);
    expect(sellerPort.sent).toEqual([
      { type: 'seller_action', payload: { side: 'seller' } },
    ]);

    const evidence = evidenceCollector.getEvidenceSet(context.runId);
    const observations = evidence.filter((entry) => entry.source === 'sut-1');

    expect(observations).toHaveLength(2);
    expect(observations.find((entry) => entry.type === 'client_observed')?.actorId)
      .toBe('client-1');
    expect(observations.find((entry) => entry.type === 'seller_observed')?.actorId)
      .toBe('resource-server-1');

    await clientController.disconnect();
    await sellerController.disconnect();
  });
});
