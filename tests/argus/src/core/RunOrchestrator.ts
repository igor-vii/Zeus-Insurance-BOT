// ============================================================
// src/core/RunOrchestrator.ts
// ============================================================

import { ScenarioEngine } from './ScenarioEngine';
import { ScenarioDefinition } from './ScenarioDefinition';
import { AgentController } from './AgentController';
import { FaultInjector } from './FaultInjector';
import { EvidenceCollector, EvidenceRecord } from './EvidenceCollector';
import { AssertionEngine } from './AssertionEngine';
import { Assertion } from './Assertions';
import { RunContext, RunStatus, RunResult, generateRunId } from './RunLifecycle';
import { PaymentAdapter } from '../adapters/payment/PaymentAdapter';
import { PaymentResolver, InboundExecutionWindow } from './ScenarioEngine';
import { deriveSigningBinding, SigningIntentSource, defaultSigningIntentSource } from '../adapters/payment/SigningBinding';
import { ExecutionRegistry } from './ExecutionRegistry';

/**
 * Оркестратор запуска тестового прогона.
 *
 * Создаёт EvidenceCollector и передаёт его в ScenarioEngine.
 * AgentController — транспорт, не знает про evidence.
 */
export class RunOrchestrator {
  private scenario: ScenarioDefinition;
  private controllers: Map<string, AgentController>;
  private evidenceCollector: EvidenceCollector;
  private assertionEngine: AssertionEngine;
  private assertions: Assertion[];
  private paymentAdapter?: PaymentAdapter;
  private bindingSource?: SigningIntentSource;

  constructor(
    scenario: ScenarioDefinition,
    controllers: Map<string, AgentController>,
    assertions: Assertion[],
    paymentAdapter?: PaymentAdapter,
    bindingSource?: SigningIntentSource
  ) {
    this.scenario = scenario;
    this.controllers = controllers;
    this.evidenceCollector = new EvidenceCollector();
    this.assertionEngine = new AssertionEngine();
    this.assertions = assertions;
    this.paymentAdapter = paymentAdapter;
    this.bindingSource = bindingSource;
  }

  /**
   * Запуск полного прогона сценария.
   */
  public async run(): Promise<RunResult> {
    return this.runInternal();
  }

  /**
   * Block A (S9): run an INBOUND scenario through the SAME canonical
   * execution / evidence / assertion / verdict pipeline used by outbound
   * scenarios (run()). The only difference is the execution direction:
   * instead of executing outbound Actions via ScenarioEngine.execute(),
   * the orchestrator opens a ScenarioEngine.beginInboundExecution() window,
   * hands it to the inbound transport adapter (X402SellerAdapter), waits for
   * the SUT-driven interaction to complete (or time out), closes the window
   * and then evaluates assertions exactly like run() does:
   *
   *   EvidenceCollector.getEvidenceSet(runId) → AssertionEngine.evaluate(...)
   *
   * No second evidence model, no second assertion engine, no second verdict.
   */
  public async runInbound(
    startTransport: (window: InboundExecutionWindow, endpointPath: string) => Promise<void>,
    stopTransport: () => Promise<void>,
    options: { timeoutMs?: number; completionSignal?: Promise<unknown> } = {}
  ): Promise<RunResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const runId = generateRunId();
    const startedAt = new Date();

    const context: RunContext = {
      runId,
      scenarioId: this.scenario.id,
      seed: this.scenario.seed,
      startedAt,
      status: RunStatus.CREATED,
    };

    // Same ScenarioEngine construction as run() — same EvidenceCollector,
    // same payment resolver wiring, same fault injector plumbing.
    const faultInjector = new FaultInjector(this.scenario.faults);
    const engine = new ScenarioEngine(
      this.scenario,
      context,
      new ExecutionRegistry(),
      faultInjector,
      this.evidenceCollector,
      undefined
    );

    let window: InboundExecutionWindow;
    try {
      window = engine.beginInboundExecution();
    } catch (error) {
      await stopTransport().catch(() => undefined);
      return {
        runId,
        scenarioId: this.scenario.id,
        status: RunStatus.FAILED,
        startedAt,
        finishedAt: new Date(),
        evidenceCount: this.evidenceCollector.count(runId),
        verdict: {
          status: 'INCONCLUSIVE',
          reason: `Runtime error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      };
    }

    // Ephemeral per-run endpoint path (transport lifecycle only —
    // mirrors the session-scoped path of the Mode A slice).
    const endpointPath = `/sessions/${runId}/resource`;

    try {
      await startTransport(window, endpointPath);

      const completion = options.completionSignal ?? Promise.resolve();
      let timedOut = false;
      await Promise.race([
        completion.then(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
          // Do not keep the process alive solely for this timer.
          if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
          }
        }),
      ]);

      // Timeout closes the evidence window; it is NOT automatically a FAIL.
      // Assertions judge only what was actually observed (§7 semantics).
      window.close();

      if (timedOut) {
        this.evidenceCollector.collect(
          {
            source: 'engine',
            type: 'inbound_execution_window_timeout',
            data: { timeoutMs } as Record<string, unknown>,
            timestamp: Date.now(),
          },
          runId
        );
      }

      await stopTransport();

      const evidence = this.evidenceCollector.getEvidenceSet(runId);
      const assertionResult = this.assertionEngine.evaluate(evidence, this.assertions);

      return {
        runId,
        scenarioId: this.scenario.id,
        status: context.status,
        startedAt,
        finishedAt: new Date(),
        evidenceCount: evidence.length,
        verdict: {
          status: assertionResult.status,
          reason: assertionResult.reasons.join('; '),
        },
      };
    } catch (error) {
      window.fail(error);
      try {
        await stopTransport();
      } catch {
        // Ignore transport teardown errors during error handling.
      }

      return {
        runId,
        scenarioId: this.scenario.id,
        status: RunStatus.FAILED,
        startedAt,
        finishedAt: new Date(),
        evidenceCount: this.evidenceCollector.count(runId),
        verdict: {
          status: 'INCONCLUSIVE',
          reason: `Runtime error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      };
    }
  }

  /**
   * Запуск полного прогона сценария (outbound direction).
   */
  private async runInternal(): Promise<RunResult> {
    const runId = generateRunId();
    const startedAt = new Date();

    const context: RunContext = {
      runId,
      scenarioId: this.scenario.id,
      seed: this.scenario.seed,
      startedAt,
      status: RunStatus.CREATED
    };

    try {
      // Create registry and connect all controllers
      const registry = new ExecutionRegistry();
      for (const [actorId, controller] of this.controllers.entries()) {
        if (!controller.getParticipantId()) {
          controller.setParticipantId(actorId);
        }
        registry.register(actorId, controller);
        await controller.connect();
      }

      const faultInjector = new FaultInjector(this.scenario.faults);

      // Build payment resolver if paymentAdapter is provided.
      // Otherwise, ScenarioEngine records PAYMENT_REQUIRED as evidence and continues.
      //
      // ВАЖНО (design reasoning, §4.3): PaymentResolver сигнатура НЕ меняется —
      // ScenarioEngine по-прежнему работает с PaymentRequired (402 от Target).
      // Единственное место, где PaymentRequired превращается в SigningBinding,
      // — этот композиционный корень. Пока wire boundary с Secretariat не
      // зафиксирован (cross-system этап), intent-поля (nonce / validAfter /
      // validBefore) берутся из внешнего источника через this.bindingSource;
      // PaymentAdapter обязуется НЕ генерировать их локально.
      let paymentResolver: PaymentResolver | undefined;
      if (this.paymentAdapter) {
        const adapter = this.paymentAdapter;
        const bindingSource = this.bindingSource ?? defaultSigningIntentSource;
        paymentResolver = async (paymentRequired) => {
          // Authorizer: Argus test wallet (если адаптер его раскрывает).
          const argusAddress = (adapter as { getArgusAddress?: () => string })
            .getArgusAddress;
          if (typeof argusAddress !== 'function') {
            throw new Error(
              'PaymentAdapter does not expose getArgusAddress(); cannot set SigningBinding.from'
            );
          }
          const intent = bindingSource(paymentRequired);
          const binding = deriveSigningBinding(
            {
              scheme: paymentRequired.scheme,
              network: paymentRequired.network,
              amount: paymentRequired.amount,
              asset: paymentRequired.asset,
              payTo: paymentRequired.payTo,
              maxTimeoutSeconds: paymentRequired.maxTimeoutSeconds,
            },
            argusAddress.call(adapter),
            intent
          );
          return adapter.signX402Payment(binding);
        };
      }

      const engine = new ScenarioEngine(
        this.scenario,
        context,
        registry,
        faultInjector,
        this.evidenceCollector,
        paymentResolver
      );

      await engine.execute();

      // Disconnect all controllers
      for (const controller of this.controllers.values()) {
        await controller.disconnect();
      }

      const evidence = this.evidenceCollector.getEvidenceSet(runId);
      const assertionResult = this.assertionEngine.evaluate(evidence, this.assertions);

      return {
        runId,
        scenarioId: this.scenario.id,
        status: context.status,
        startedAt,
        finishedAt: new Date(),
        evidenceCount: evidence.length,
        verdict: {
          status: assertionResult.status,
          reason: assertionResult.reasons.join('; ')
        }
      };
    } catch (error: unknown) {
      context.status = RunStatus.FAILED;

      // Disconnect all controllers on error
      for (const controller of this.controllers.values()) {
        try {
          await controller.disconnect();
        } catch {
          // Ignore disconnect errors during error handling
        }
      }

      return {
        runId,
        scenarioId: this.scenario.id,
        status: RunStatus.FAILED,
        startedAt,
        finishedAt: new Date(),
        evidenceCount: this.evidenceCollector.count(runId),
        verdict: {
          status: 'INCONCLUSIVE',
          reason: `Runtime error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      };
    }
  }

  /**
   * Get all evidence records collected during the run.
   * Intended for tests and debugging.
   */
  getEvidence(): EvidenceRecord[] {
    return this.evidenceCollector.getAllRecords();
  }
}

// ============================================================
// КОНЕЦ ФАЙЛА
// ============================================================
