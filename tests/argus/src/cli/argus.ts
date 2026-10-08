#!/usr/bin/env node

// Runtime (важно для cross-system harness и CI):
//
//   CLI запускается через:
//     npm run argus -- run <scenarioId>
//   или напрямую:
//     npx tsx src/cli/argus.ts run <scenarioId>
//
//   Прямой запуск `node dist/cli/argus.js` НЕ поддерживается:
//   проект компилируется без .js-расширений в относительных
//   импортах (tsconfig moduleResolution не NodeNext), поэтому
//   Node ESM не может разрешить import-пути в dist.
//
//   Переход на NodeNext (с .js-расширениями в импортах) —
//   отдельный PR, вне scope текущих изменений.

import { RunOrchestrator } from '../core/RunOrchestrator';
import { AgentController } from '../core/AgentController';
import {
  TargetAdapterRegistry,
  readTargetSpecFromEnv,
} from './TargetAdapterRegistry';
import { ScenarioRegistry, getScenarioIds } from './ScenarioRegistry';
import { Assertion } from '../core/Assertions';
import { validateScenario } from '../core/validateScenario';
import { createPaymentAdapter } from '../adapters/payment/PaymentAdapterFactory';
import type { PaymentAdapter } from '../adapters/payment/PaymentAdapter';
import { X402SellerAdapter, DEFAULT_BASE_SEPOLIA_PAY_TO } from '../adapters/seller/X402SellerAdapter';
import type { InboundExecutionWindow } from '../core/ScenarioEngine';
import type { ScenarioDefinition } from '../core/ScenarioDefinition';

/**
 * Build the x402 V2 PAYMENT-SIGNATURE envelope (Base64) for the S9 inbound
 * self-check. This plays the role of the EXTERNAL CLIENT: it only performs
 * the protocol steps a client must perform (read accepts, sign EIP-712
 * TransferWithAuthorization, send PAYMENT-SIGNATURE header). No Argus
 * internals are inspected — black-box at the HTTP boundary.
 */
async function buildClientPaymentSignature(
  paymentRequiredHeader: string,
  privateKey: `0x${string}`,
): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey);

  const pr = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8'));
  const accept = pr.accepts[0];

  const authorization = {
    from: account.address,
    to: accept.payTo as `0x${string}`,
    value: BigInt(accept.amount),
    validAfter: BigInt(Math.floor(Date.now() / 1000)),
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
    nonce: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  const envelope = {
    x402Version: 2,
    accepted: {
      scheme: accept.scheme,
      network: accept.network,
      asset: accept.asset,
      amount: accept.amount,
      payTo: accept.payTo,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
    },
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: String(authorization.value),
        validAfter: String(authorization.validAfter),
        validBefore: String(authorization.validBefore),
        nonce: authorization.nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Block A / S9 execution path: external CLIENT → Argus RESOURCE_SERVER.
 *
 * The canonical pipeline is unchanged:
 *   ScenarioDefinition → RunOrchestrator.runInbound()
 *     → ScenarioEngine.beginInboundExecution() window
 *     → X402SellerAdapter (inbound transport, emits canonical Observations)
 *     → EvidenceCollector → AssertionEngine → Verdict
 *
 * For CLI self-execution a minimal built-in client plays the external SUT;
 * ARGUS_S9_SELF_CHECK=0 keeps the server listening for a real external
 * client until the timeout closes the evidence window.
 */
async function runS9Inbound(scenarioDef: ScenarioDefinition): Promise<void> {
  const pk = process.env.ARGUS_TEST_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  const selfCheckRaw = process.env.ARGUS_S9_SELF_CHECK ?? '1';
  const selfCheck = selfCheckRaw !== '0';
  const timeoutMs = Number.parseInt(process.env.ARGUS_S9_TIMEOUT_MS ?? '15000', 10);

  if (selfCheck && !pk) {
    console.error(
      'Error: ARGUS_TEST_WALLET_PRIVATE_KEY is required for S9 self-check ' +
      '(set ARGUS_S9_SELF_CHECK=0 to wait for an external client instead)'
    );
    process.exit(1);
  }

  const sellerAdapter = new X402SellerAdapter({
    port: 0,
    payTo: process.env.ARGUS_S9_PAY_TO ?? DEFAULT_BASE_SEPOLIA_PAY_TO,
    // Canonical observation source must equal scenario.testSubject.
    observationSource: scenarioDef.testSubject,
  });

  let clientFailure: Error | null = null;
  let resolveInteraction: () => void = () => {};
  const interactionDone = new Promise<void>((resolve) => { resolveInteraction = resolve; });

  const startTransport = async (window: InboundExecutionWindow, endpointPath: string): Promise<void> => {
    const url = await sellerAdapter.start({
      endpointPath,
      window,
      onInteractionComplete: () => resolveInteraction(),
    });

    if (!selfCheck || !pk) return;

    // Minimal built-in client: request → 402 → signed retry → response.
    void (async () => {
      try {
        const first = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
        if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
        const prHeader = first.headers.get('payment-required');
        if (!prHeader) throw new Error('missing payment-required header in 402 response');
        const sig = await buildClientPaymentSignature(prHeader, pk);
        const second = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'payment-signature': sig },
        });
        if (second.status !== 200) {
          throw new Error(`paid request rejected with HTTP ${second.status}`);
        }
      } catch (err) {
        clientFailure = err instanceof Error ? err : new Error(String(err));
      }
    })();
  };

  const stopTransport = async (): Promise<void> => {
    await sellerAdapter.stop();
  };

  const assertions = scenarioDef.assertions || [];
  const orchestrator = new RunOrchestrator(scenarioDef, new Map(), assertions);

  const result = await orchestrator.runInbound(startTransport, stopTransport, {
    timeoutMs,
    completionSignal: interactionDone,
  });

  console.log('\nRun:');
  console.log(`  ID: ${result.runId}`);
  console.log(`  Scenario: ${result.scenarioId}`);
  console.log(`  Status: ${result.status}`);
  console.log('\nEvidence:');
  console.log(`  Count: ${result.evidenceCount}`);

  if (result.verdict) {
    console.log('\nVerdict:');
    console.log(`  Result: ${result.verdict.status}`);
    if (result.verdict.reason) {
      console.log(`  Reason: ${result.verdict.reason}`);
    }
  }

  if (clientFailure) {
    console.error(`Note: built-in self-check client error: ${(clientFailure as Error).message}`);
  }

  process.exit(result.verdict?.status === 'PASS' ? 0 : 1);
}

/**
 * Минимальный CLI для Argus Test Lab
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage: argus <command> [scenario]');
    console.log('Commands:');
    console.log('  list              - List available scenarios');
    console.log('  run <scenarioId>  - Run a specific scenario (e.g., S1)');
    process.exit(1);
  }

  if (command === 'list') {
    console.log('Available Scenarios:');
    for (const id of getScenarioIds()) {
      const scenario = ScenarioRegistry.get(id);
      if (!scenario) continue;
      const result = validateScenario(scenario);
      if (result.valid) {
        console.log(`  ${id} - ${scenario.name}`);
      } else {
        const reasons = result.errors
          .map((e) => `${e.assertionId} ${e.rule} — ${e.message}`)
          .join('; ');
        console.log(`  ${id} - ${scenario.name} [INVALID: ${reasons}]`);
      }
    }
    process.exit(0);
  }

  if (command === 'run') {
    const scenarioId = args[1];

    if (!scenarioId) {
      console.error('Error: Scenario ID required');
      console.error('Usage: argus run <scenarioId>');
      process.exit(1);
    }

    const scenarioDef = ScenarioRegistry.get(scenarioId);

    if (!scenarioDef) {
      console.error(`Error: Unknown scenario '${scenarioId}'`);
      console.error(`Available scenarios: ${getScenarioIds().join(', ')}`);
      process.exit(1);
    }

    // Валидация Rule 1 (до любого запуска)
    const validation = validateScenario(scenarioDef);
    if (!validation.valid) {
      console.error(`Error: scenario '${scenarioId}' failed validation:`);
      for (const e of validation.errors) {
        console.error(`  - [${e.rule}] ${e.assertionId}: ${e.message}`);
      }
      process.exit(1);
    }

    // Block A / S9: inbound direction (Argus = RESOURCE_SERVER).
    // Тот же канонический пайплайн evidence/assertions/verdict, другой
    // только транспортный направление исполнения.
    if (scenarioDef.id === 'S9') {
      await runS9Inbound(scenarioDef);
      return;
    }

    // Target-адаптер выбирается через env (ARGUS_TARGET_KIND / ARGUS_TARGET_ENDPOINT).
    // Если переменные не заданы — поведение идентично baseline (mock).
    let targetSpec;
    try {
      targetSpec = readTargetSpecFromEnv();
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }

    try {
      // Создание Map контроллеров для участников ARGUS
      const controllers = new Map<string, AgentController>();
      const registry = TargetAdapterRegistry.default();

      for (const participant of scenarioDef.participants) {
        if (participant.ownership !== 'ARGUS') continue;

        const targetAdapter = registry.create(targetSpec);
        const controller = new AgentController(targetAdapter, {
          connectionConfig: {
            transportType: targetSpec.kind,
            ...(targetSpec.endpoint ? { endpoint: targetSpec.endpoint } : {}),
          },
          runId: `run_${Date.now()}_${participant.participantId}`,
        });
        controllers.set(participant.participantId, controller);
      }

      // Assertions из сценария (Model V0: scenarioDef.assertions)
      const assertions: Assertion[] = scenarioDef.assertions || [];

      // Payment wiring: только если target kind требует оплату.
      // При ARGUS_TARGET_KIND=mock — PaymentAdapter не создаётся,
      // поведение CLI сохраняется (baseline).
      let paymentAdapter: PaymentAdapter | undefined;
      if (targetSpec.kind === 'x402' || targetSpec.kind === 'http') {
        const pk = process.env.ARGUS_TEST_WALLET_PRIVATE_KEY;
        const rpc = process.env.BASE_SEPOLIA_RPC_URL;
        if (targetSpec.kind === 'x402' && (!pk || !rpc)) {
          console.error(
            'Error: ARGUS_TEST_WALLET_PRIVATE_KEY and BASE_SEPOLIA_RPC_URL are required for ARGUS_TARGET_KIND=x402'
          );
          process.exit(1);
        }
        if (pk && rpc) {
          paymentAdapter = createPaymentAdapter({
            network: 'base-sepolia',
            rpcUrl: rpc,
            privateKey: pk as `0x${string}`,
          });
        }
      }

      // Запуск оркестратора
      const orchestrator = new RunOrchestrator(
        scenarioDef,
        controllers,
        assertions,
        paymentAdapter
        // bindingSource НЕ передан: используется defaultSigningIntentSource
        // (test-only placeholder) — wire boundary не фиксируется в Block D.
      );

      const result = await orchestrator.run();

      // Вывод результатов
      console.log('\nRun:');
      console.log(`  ID: ${result.runId}`);
      console.log(`  Scenario: ${result.scenarioId}`);
      console.log(`  Status: ${result.status}`);
      console.log(`  Started: ${result.startedAt.toISOString()}`);
      console.log(`  Finished: ${result.finishedAt?.toISOString() || 'N/A'}`);
      console.log('\nEvidence:');
      console.log(`  Count: ${result.evidenceCount}`);

      if (result.verdict) {
        console.log('\nVerdict:');
        console.log(`  Result: ${result.verdict.status}`);
        if (result.verdict.reason) {
          console.log(`  Reason: ${result.verdict.reason}`);
        }
      }

      process.exit(result.verdict?.status === 'FAIL' ? 1 : 0);

    } catch (error) {
      console.error('Runtime error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  }

  console.error(`Error: Unknown command '${command}'`);
  console.error('Use "argus list" to see available commands');
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
