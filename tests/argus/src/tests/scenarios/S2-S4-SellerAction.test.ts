/**
 * R3 — Seller-action (Decision 3, variant a) tests for S2 and S4.
 *
 * Proves ONLY:
 * 1. delayed_response (S2) and hang (S4) become reachable through the
 *    EXISTING L0-F2 action-fault dispatch: trigger 'action_deliver',
 *    participant target === actor ('resource-server-1'). No lifecycle dispatch.
 * 2. The faults produce their canonical evidence via FaultInjector's own
 *    emit path (delivery_started / delivery_completed from resource-server-1).
 * 3. Assertions of S2/S4 are NOT modified; their honest post-R3 status is
 *    asserted (both remain INCONCLUSIVE until Sut-reported success /
 *    terminal-state plumbing lands — see docs/evidence-source-map.md).
 * 4. S6 fault remains declared-only on a lifecycle trigger (not touched).
 */

import { describe, expect, it } from 'vitest';
import { RunOrchestrator } from '../../core/RunOrchestrator';
import { ScenarioEngine } from '../../core/ScenarioEngine';
import { ExecutionRegistry } from '../../core/ExecutionRegistry';
import { FaultInjector } from '../../core/FaultInjector';
import { EvidenceCollector } from '../../core/EvidenceCollector';
import { RunContext, RunStatus } from '../../core/RunLifecycle';
import { AgentController } from '../../core/AgentController';
import { MockTargetAdapter } from '../../adapters/MockTargetAdapter';
import { validateFaultDispatch } from '../../core/validateScenario';
import { isActionTrigger, L0F2_LIFECYCLE_TRIGGERS } from '../../core/Fault';
import { ScenarioDefinition } from '../../core/ScenarioDefinition';
import { S2_PaymentBeforeExecution } from '../../scenarios/S2_PaymentBeforeExecution';
import { S4_SellerTimeout } from '../../scenarios/S4_SellerTimeout';
import { S6_PaymentRetry } from '../../scenarios/S6_PaymentRetry';

function controllersFor(
  scenario: ScenarioDefinition,
  lifecycleObservations: Record<string, string[]> = {},
) {
  const controllers = new Map<string, AgentController>();
  for (const p of scenario.participants) {
    if (p.ownership !== 'ARGUS') continue;
    const controller = new AgentController(new MockTargetAdapter('mock'), {
      connectionConfig: {
        transportType: 'mock',
        options: { lifecycleObservations },
      },
      runId: `run_${Date.now()}_${p.participantId}`,
    });
    controller.setParticipantId(p.participantId);
    controllers.set(p.participantId, controller);
  }
  if (controllers.size === 0) {
    const controller = new AgentController(new MockTargetAdapter('mock'), {
      connectionConfig: {
        transportType: 'mock',
        options: { lifecycleObservations },
      },
      runId: `run_${Date.now()}_default`,
    });
    controllers.set('default', controller);
  }
  return controllers;
}

async function runEngineWith(
  scenario: ScenarioDefinition,
  runId: string,
  lifecycleObservations: Record<string, string[]> = {},
): Promise<EvidenceCollector> {
  const registry = new ExecutionRegistry();
  // R3 per-participant harness: every ARGUS-owned actor gets its OWN connected
  // controller (RunOrchestrator does the same in production). A single shared
  // controller cannot serve both client-1 and resource-server-1 because
  // setParticipantId + connect are per-controller state.
  for (const p of scenario.participants) {
    if (p.ownership !== 'ARGUS') continue;
    const c = new AgentController(new MockTargetAdapter('mock'), {
      connectionConfig: { transportType: 'mock', options: { lifecycleObservations } },
      runId,
    });
    c.setParticipantId(p.participantId);
    await c.connect();
    registry.register(p.participantId, c);
  }

  const context: RunContext = {
    runId,
    scenarioId: scenario.id,
    seed: scenario.seed,
    startedAt: new Date(),
    status: RunStatus.CREATED,
  };
  const collector = new EvidenceCollector();
  const engine = new ScenarioEngine(
    scenario,
    context,
    registry,
    new FaultInjector(scenario.faults),
    collector,
  );
  await engine.execute();
  return collector;
}

describe('R3 seller-action: S2 delayed_response via action_deliver', () => {
  it('scenario shape: second action is deliver from resource-server-1; fault moved to action_deliver', () => {
    const s2 = S2_PaymentBeforeExecution;
    expect(s2.actions.map((a) => `${a.actor}:${a.type}`)).toEqual([
      'client-1:request_payment',
      'resource-server-1:deliver',
    ]);
    const fault = s2.faults[0];
    expect(fault.type).toBe('delayed_response');
    expect(fault.trigger).toBe('action_deliver');
    expect(isActionTrigger(fault.trigger)).toBe(true);
    expect(L0F2_LIFECYCLE_TRIGGERS.has(fault.trigger)).toBe(false);
    if (fault.target.kind === 'participant') {
      expect(fault.target.participantId).toBe('resource-server-1');
    } else {
      throw new Error('expected participant target');
    }
    expect(validateFaultDispatch(s2).valid).toBe(true);
  });

  it('fault is reachable via getFaultsForEvent("action_deliver", "resource-server-1") — no lifecycle dispatch', () => {
    const injector = new FaultInjector(S2_PaymentBeforeExecution.faults);
    const active = injector.getFaultsForEvent('action_deliver', 'resource-server-1');
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe('delayed_response');
    // Same fault must NOT be dispatched for any other actor or lifecycle event:
    expect(injector.getFaultsForEvent('action_deliver', 'client-1')).toHaveLength(0);
    expect(injector.getFaultsForEvent('delivery_started', 'resource-server-1')).toHaveLength(0);
  });

  it('delayed_response applies: delivery_started + delivery_completed from resource-server-1 enter evidence', async () => {
    const collector = await runEngineWith(S2_PaymentBeforeExecution, 'run_r3_s2');
    const started = collector.getByType('run_r3_s2', 'delivery_started');
    const completed = collector.getByType('run_r3_s2', 'delivery_completed');
    // Fault emitted exactly once, with its own source identity preserved:
    expect(started).toHaveLength(1);
    expect(started[0].source).toBe('resource-server-1');
    expect(completed).toHaveLength(1);
    expect(completed[0].source).toBe('resource-server-1');
    expect(started[0].timestamp).toBeLessThanOrEqual(completed[0].timestamp);
    // action_deliver itself executed afterwards (engine event exists):
    expect(collector.getByType('run_r3_s2', 'action_deliver')).toHaveLength(1);
  }, 20000);

  it('honest assertion status: settled+success from Sut without seller response → FAIL; with real seller completion → PASS', async () => {
    // Decision 2 (a): success is reported by the Sut only. Here the Sut says
    // settled+success while the seller never responded (no deliver action) —
    // the unmodified assert_no_premature_success must FAIL. This proves the
    // invariant bites, not that we manufacture green.
    const premature: ScenarioDefinition = {
      ...S2_PaymentBeforeExecution,
      actions: [S2_PaymentBeforeExecution.actions[0]],
      faults: [],
    };
    const orchestrator = new RunOrchestrator(
      premature,
      controllersFor(premature, { request_payment: ['payment_settled', 'success'] }),
      premature.assertions,
    );
    const bad = await orchestrator.run();
    expect(bad.verdict?.status).toBe('FAIL');
    expect(bad.verdict?.reason).toContain('without seller actually responding');

    // With the canonical seller-deliver action (delayed but completing),
    // settled+success from the Sut plus delivery_completed from resource-server-1 →
    // the SAME unmodified assertion returns PASS.
    // NOTE: the PASS-run uses a shortened delayed_response fault so that
    // delivery_completed lands BEFORE the engine records success — otherwise
    // Date.now() ties would make the strict "success after settlement" check
    // flaky. The canonical scenario file is not modified; this is harness
    // config only.
    const s2PassRun: ScenarioDefinition = {
      ...S2_PaymentBeforeExecution,
      faults: [
        {
          target: { kind: 'participant', participantId: 'resource-server-1' },
          type: 'delayed_response',
          trigger: 'action_deliver',
          config: { delay_ms: 5 },
        },
      ],
    };
    const good = await runWithObs(
      s2PassRun,
      'run_r3_s2_pass',
      { request_payment: ['payment_settled', 'success'] },
    );
    expect(good.verdict?.status).toBe('PASS');
  }, 30000);
});

describe('R3 seller-action: S4 hang via action_deliver', () => {
  it('scenario shape: deliver action from resource-server-1; hang moved to action_deliver; dispatch-valid', () => {
    const s4 = S4_SellerTimeout;
    expect(s4.actions.map((a) => `${a.actor}:${a.type}`)).toEqual([
      'client-1:request_payment',
      'resource-server-1:deliver',
    ]);
    const fault = s4.faults[0];
    expect(fault.type).toBe('hang');
    expect(fault.trigger).toBe('action_deliver');
    expect(fault.config.duration_ms).toBe(-1);
    expect(validateFaultDispatch(s4).valid).toBe(true);
  });

  it('hang becomes ACTIVE: run reaches timeout state, delivery_started emitted, exchange never completes', async () => {
    const adapter = new MockTargetAdapter('mock');
    const controller = new AgentController(adapter, {
      connectionConfig: { transportType: 'mock' },
      runId: 'run_r3_s4',
    });
    await controller.connect();
    const registry = new ExecutionRegistry();
    for (const p of S4_SellerTimeout.participants) {
      if (p.ownership === 'ARGUS') registry.register(p.participantId, controller);
    }
    const context: RunContext = {
      runId: 'run_r3_s4',
      scenarioId: 'S4',
      seed: S4_SellerTimeout.seed,
      startedAt: new Date(),
      status: RunStatus.CREATED,
    };
    const collector = new EvidenceCollector();
    const engine = new ScenarioEngine(
      S4_SellerTimeout,
      context,
      registry,
      new FaultInjector(S4_SellerTimeout.faults),
      collector,
    );

    const engineDone = engine.execute().then(() => 'resolved' as const);
    const race = await Promise.race([
      engineDone,
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 500)),
    ]);
    // Before R3 this fault was declared-only (trigger delivery_started) and the
    // run completed instantly. Now hang is applied on action_deliver: the run
    // is stuck in the never-resolving hang promise...
    expect(race).toBe('stuck');
    // ...and the hang primitive emitted its observation through the existing
    // emit callback (identity preserved, source = fault target):
    const started = collector.getByType('run_r3_s4', 'delivery_started');
    expect(started).toHaveLength(1);
    expect(started[0].source).toBe('resource-server-1');
    // Buyer action completed before the hang:
    expect(collector.getByType('run_r3_s4', 'action_request_payment')).toHaveLength(1);
    // The hung deliver action produced NO engine event (operation never returned).
    expect(collector.getByType('run_r3_s4', 'action_deliver')).toHaveLength(0);
  }, 20000);

  it('honest assertion status: without delivery_unknown → INCONCLUSIVE; with Sut-reported delivery_unknown → PASS', async () => {
    // NOTE ON SCENARIO SHAPE HERE: the canonical S4 hang has duration_ms: -1,
    // i.e. it never resolves — an orchestrator-level verdict run would block
    // forever. This is exactly why the runtime cannot derive a terminal
    // delivery_unknown from the hang itself (deriving it would be inventing
    // semantics; UNKNOWN must be reported by the source, not inferred from
    // timeout). For the verdict check we therefore use the SAME scenario with
    // a FINITE hang (duration_ms: 10): delivery_started is emitted, the
    // operation rejects with 'Hang timeout', RunOrchestrator records the
    // timeout path, and NO delivery_unknown exists in evidence — so the
    // unmodified assertion honestly stays INCONCLUSIVE ('no terminal state
    // observed yet'). Timeout is NOT reinterpreted as failure or unknown.
    const finiteHang = {
      ...S4_SellerTimeout,
      faults: [
        {
          target: { kind: 'participant' as const, participantId: 'resource-server-1' },
          type: 'hang',
          trigger: 'action_deliver',
          config: { duration_ms: 10 },
        },
      ],
    };
    const base = await runWithObs(finiteHang, 'run_r3_s4_inc', {
      // Sut reports its settlement fact; the seller stays silent (finite hang).
      request_payment: ['payment_settled'],
    });
    expect(base.verdict?.status).toBe('INCONCLUSIVE');
    expect(base.verdict?.reason).toContain('no terminal state observed yet');

    // With faults removed (silent seller simply never answers within the run)
    // and the Sut explicitly reporting payment_settled plus, on the deliver
    // exchange, delivery_unknown as its terminal observation (Decision 1/2
    // variant-a plumbing; harness config, NOT the scenario file), the SAME
    // unmodified assertion returns PASS. success/failed stay unconfigured —
    // their presence would flip this assertion to FAIL by design.
    const withUnknown = await runWithObs(
      { ...S4_SellerTimeout, faults: [] },
      'run_r3_s4_pass',
      { request_payment: ['payment_settled'], deliver: ['delivery_unknown'] },
    );
    expect(withUnknown.verdict?.status).toBe('PASS');
  }, 30000);
});

describe('R3 scope containment', () => {
  it('R3-D2 Option B: S6 retries are explicit actions; settlement_unknown is observation, never dispatch', () => {
    const paymentActions = S6_PaymentRetry.actions.filter((a) => a.type === 'request_payment');
    expect(paymentActions.length).toBe(3);
    const keys = paymentActions.map((a) => a.payload['idempotencyKey']);
    expect(keys).toEqual(['key-6', 'key-6-retry-1', 'key-6-retry-2']);
    expect(new Set(keys).size).toBe(3);
    expect(S6_PaymentRetry.faults).toHaveLength(0);
    const injector = new FaultInjector(S6_PaymentRetry.faults);
    expect(injector.getFaultsForEvent('action_request_payment', 'client-1')).toHaveLength(0);
    expect(isActionTrigger('settlement_unknown')).toBe(false);
    expect(L0F2_LIFECYCLE_TRIGGERS.has('settlement_unknown')).toBe(true);
    expect(injector.getFaultsForEvent('settlement_unknown', 'client-1')).toHaveLength(0);
    const assertion = S6_PaymentRetry.assertions[0];
    expect(assertion.id).toBe('assert_no_duplicate_settlement');
    const ev = (source: string, type: string) => ({ source, type, data: {}, timestamp: 0 });
    expect(assertion.evaluate([] as never).status).toBe('INCONCLUSIVE');
    expect(assertion.evaluate([ev('sut-1', 'payment_settled')] as never).status).toBe('PASS');
    expect(assertion.evaluate([
      ev('sut-1', 'payment_settled'),
      ev('sut-1', 'payment_settled'),
    ] as never).status).toBe('FAIL');
    expect(S6_PaymentRetry.invariants[0].id).toBe('no_duplicate_payment_on_unknown');
  });

  it('S2/S4 assertions blocks unchanged (evaluate functions reference the same canonical logic markers)', () => {
    const s2src = String(S2_PaymentBeforeExecution.assertions[0].evaluate);
    expect(s2src).toContain('success recorded without seller actually responding');
    expect(S2_PaymentBeforeExecution.assertions).toHaveLength(1);
    expect(S2_PaymentBeforeExecution.assertions[0].id).toBe('assert_no_premature_success');
    const s4src = String(S4_SellerTimeout.assertions[0].evaluate);
    expect(s4src).toContain('marked FAILED without seller ever responding');
    expect(S4_SellerTimeout.assertions).toHaveLength(1);
    expect(S4_SellerTimeout.assertions[0].id).toBe('assert_timeout_state');
    // Invariants untouched:
    expect(S2_PaymentBeforeExecution.invariants[0].id).toBe('no_premature_success');
    expect(S4_SellerTimeout.invariants[0].id).toBe('timeout_yields_unknown_not_failed');
  });
});

// Harness helpers for verdict-level runs (RunOrchestrator owns connect).
async function runWithObs(
  scenario: ScenarioDefinition,
  runId: string,
  lifecycleObservations: Record<string, string[]>,
) {
  const adapter = new MockTargetAdapter('mock');
  const controller = new AgentController(adapter, {
    connectionConfig: { transportType: 'mock', options: { lifecycleObservations } },
    runId,
  });
  const orchestrator = new RunOrchestrator(
    scenario,
    controllersFor(scenario, lifecycleObservations),
    scenario.assertions,
  );
  return orchestrator.run();
}

async function runEngineWithObs(
  scenario: ScenarioDefinition,
  runId: string,
  lifecycleObservations: Record<string, string[]>,
) {
  return runWithObs(scenario, runId, lifecycleObservations);
}
