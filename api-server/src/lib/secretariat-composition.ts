/**
 * BLOCK 8 R2.1: Production Secretariat Composition Root
 *
 * Single canonical factory that creates the entire Secretariat dependency graph.
 * All consumers receive THE SAME shared instances — no duplicate stores/engines.
 *
 * Lifecycle:
 *   const composition = createSecretariatComposition();
 *   await composition.recover();       // startup recovery BEFORE worker
 *   composition.startWorker();         // begin reconciliation polling
 *   await composition.shutdown();      // graceful stop (idempotent)
 */

import { db, createSharedStores } from "@workspace/db";
import {
  Eip3009PaymentVerifier,
  MultiRpcChecker,
  ReconciliationEngine,
  ReconciliationWorker,
  X402FacilitatorClient,
  PostSettlementEngine,
  HttpSellerExecutionAdapter,
  Secretariat,
  ExecutionWorker,
  ExecutionFeedbackService,
  DEFAULT_RECONCILIATION_SCHEDULE,
  DEFAULT_FINALITY_POLICY,
} from "zeus-secretariat";
import type { Eip3009Domain } from "zeus-secretariat";
import type { Address } from "viem";
import { createLocalEoaSignerFromEnv } from "zeus-secretariat/adapters/local-eoa-signer";
import { loadSecretariatProductionConfig } from "./secretariat-config";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretariatComposition {
  readonly stores: {
    readonly evidenceStore: ReturnType<typeof createSharedStores>["evidenceStore"];
    readonly executionStore: ReturnType<typeof createSharedStores>["executionStore"];
  };
  readonly rpcChecker: InstanceType<typeof MultiRpcChecker>;
  readonly reconciliationEngine: InstanceType<typeof ReconciliationEngine>;
  readonly settlementAdapter: InstanceType<typeof X402FacilitatorClient>;
  readonly sellerAdapter: InstanceType<typeof HttpSellerExecutionAdapter>;
  readonly postSettlementEngine: InstanceType<typeof PostSettlementEngine>;
  readonly secretariat: InstanceType<typeof Secretariat>;
  readonly paymentVerifier: InstanceType<typeof Eip3009PaymentVerifier>;
  readonly reconciliationWorker: InstanceType<typeof ReconciliationWorker>;
  /** A1-A: production polling consumer for recovery_jobs(EXECUTION, PENDING). */
  readonly executionWorker: InstanceType<typeof ExecutionWorker>;

  /** Run startup recovery (call BEFORE startWorker). */
  recover(): Promise<void>;

  /** Start the reconciliation worker polling loop. */
  startWorker(): void;

  /** Graceful shutdown. Idempotent — safe to call multiple times. */
  shutdown(): Promise<void>;
}

function chainIdForNetwork(network: string): number {
  switch (network.toLowerCase()) {
    case "base":
    case "base-mainnet":
      return 8453;
    case "base-sepolia":
      return 84532;
    case "x-layer":
    case "xlayer":
    case "x-layer-mainnet":
      return 196;
    case "bot-chain":
      return 677;
    default:
      throw new Error(`EIP-3009 domain is not configured for network ${network}`);
  }
}

function resolvePaymentDomain(intent: {
  network: string;
  asset: string;
}): Eip3009Domain {
  const verifyingContract = intent.asset;
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) {
    throw new Error("Persisted payment asset is not a valid EVM address");
  }

  return {
    name: process.env["ZEUS_EIP3009_DOMAIN_NAME"]?.trim() || "USD Coin",
    version: process.env["ZEUS_EIP3009_DOMAIN_VERSION"]?.trim() || "2",
    chainId: chainIdForNetwork(intent.network),
    verifyingContract: verifyingContract as Address,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the complete Secretariat production dependency graph.
 * Uses R2.0 canonical configuration. Fails explicitly on missing config.
 *
 * Shared instance invariant: ONE store/engine/adapter used by ALL consumers.
 */
export function createSecretariatComposition(): SecretariatComposition {
  // 1. Load validated configuration (throws on missing required env vars)
  const config = loadSecretariatProductionConfig();

  // 2. Shared stores (single DB pool via @workspace/db)
  const stores = createSharedStores(db);

  // Read-only client-signature verification. The domain is derived from the
  // persisted DPI binding, never from the submitted payment payload.
  const paymentVerifier = new Eip3009PaymentVerifier({
    store: stores.evidenceStore,
    domain: resolvePaymentDomain,
  });

  // 3. Multi-RPC checker (§14, §15: ≥2 independent providers)
  const rpcChecker = new MultiRpcChecker(
    config.rpcProviders.map(p => ({
      providerId: p.providerId,
      underlyingProvider: p.underlyingProvider,
      rpcUrl: p.rpcUrl,
      maxStalenessBlocks: p.maxStalenessBlocks,
    })),
    DEFAULT_FINALITY_POLICY,
  );

  // 4. Reconciliation engine (shared evidenceStore + rpcChecker)
  const reconciliationEngine = new ReconciliationEngine(
    stores.evidenceStore,
    rpcChecker,
    DEFAULT_RECONCILIATION_SCHEDULE,
    DEFAULT_FINALITY_POLICY,
  );

  // 5. Settlement adapter (x402 facilitator)
  const settlementAdapter = new X402FacilitatorClient(
    {
      baseUrl: config.facilitatorBaseUrl,
      apiKey: config.facilitatorApiKey,
      timeoutMs: config.facilitatorTimeoutMs,
      maxRetries: 0, // §14: no blind retries
    },
    stores.evidenceStore,
  );

  // 6. Explicit custodial test signer only. The default path is non-custodial:
  // the client signs externally and calls Secretariat.submitSignedPayment().
  const signer = config.signer.mode === "custodial_test"
    ? createLocalEoaSignerFromEnv(config.signer.privateKeyEnvVar)
    : undefined;

  // 7. Seller execution adapter
  const sellerAdapter = new HttpSellerExecutionAdapter(config.sellerTimeoutMs);

  // 8. Post-settlement engine (shared stores)
  const postSettlementEngine = new PostSettlementEngine(
    stores.evidenceStore,
    stores.executionStore,
    sellerAdapter,
    {
      workerId: `api-server-${process.pid}`,
      sellerUrl: config.sellerUrl,
      sellerMethod: config.sellerMethod,
      lockDurationMs: config.executionLockMs,
      maxExecutionAttempts: config.maxExecutionAttempts,
    },
  );

  // 9. Secretariat / StateMachine (shared everything)
  // R2.1-FIX-5: Pass executionStore as typed AtomicSettlementHandoff.
  // PostgresExecutionStore implements settleAndCreateExecutionObligation() transactionally.
  const secretariat = new Secretariat({
    evidenceStore: stores.evidenceStore,
    signer,
    adapters: new Map(), // Legacy PaymentAdapter map — empty for V2-only path
    settlementAdapter,
    reconciliationEngine,
    atomicSettlementHandoff: stores.executionStore,
  });

  // 10. Reconciliation worker (shared store + engine)
  const reconciliationWorker = new ReconciliationWorker(
    stores.evidenceStore,
    reconciliationEngine,
    {
      pollIntervalMs: config.reconciliation.pollIntervalMs,
      leaseDurationMs: config.reconciliation.leaseDurationMs,
      errorBackoffMs: config.reconciliation.errorBackoffMs,
      batchSize: config.reconciliation.batchSize,
      workerId: `recon-worker-${process.pid}`,
    },
  );

  // 11. A1-B: FSM feedback service — uses the SAME shared Secretariat instance
  // (getOperation/saveOperation is the only durable path to connect A1-A with
  // the Operation FSM). No new persistence mechanism.
  const executionFeedbackService = new ExecutionFeedbackService(secretariat);

  // 12. A1-A: Production execution worker — permanent polling consumer for
  // recovery_jobs(EXECUTION, PENDING) created by settlement. Uses the existing
  // claim/lease/fencing infrastructure via the SAME shared postSettlementEngine
  // and stores.executionStore instances. No new queue/schema/execution mechanism.
  const executionWorker = new ExecutionWorker(postSettlementEngine, stores.executionStore, {
    pollIntervalMs: config.reconciliation.pollIntervalMs,
    batchSize: config.reconciliation.batchSize,
    workerId: `exec-worker-${process.pid}`,
    feedbackService: executionFeedbackService,
  });

  // --- Lifecycle methods ---

  let shutdownCalled = false;

  /**
   * R2.1-FIX-4: Recovery failure is FATAL for V0 economic safety.
   * If recovery fails, the error propagates and prevents worker startup.
   * This ensures no orphaned work is silently abandoned.
   */
  async function recover(): Promise<void> {
    // Reconciliation crash recovery — failure is fatal
    const reconResults = await reconciliationEngine.recoverAfterCrash();
    if (reconResults.size > 0) {
      logger.info(`[composition] recoverAfterCrash: reconciled ${reconResults.size} intents`);
    }

    // Post-settlement execution recovery — failure is fatal
    const execRecovered = await postSettlementEngine.recoverPendingJobs();
    if (execRecovered.length > 0) {
      logger.info(`[composition] PostSettlementEngine: recovered ${execRecovered.length} jobs`);
    }
  }

  function startWorker(): void {
    reconciliationWorker.start();
    logger.info("[composition] ReconciliationWorker started");
    // A1-A: start the production execution consumer for recovery_jobs(EXECUTION, PENDING)
    executionWorker.start();
    logger.info("[composition] ExecutionWorker started");
  }

  async function shutdown(): Promise<void> {
    if (shutdownCalled) return; // idempotent
    shutdownCalled = true;

    logger.info("[composition] Graceful shutdown initiated");
    await reconciliationWorker.stop();
    logger.info("[composition] ReconciliationWorker stopped");
    await executionWorker.stop();
    logger.info("[composition] ExecutionWorker stopped");
  }

  return {
    stores,
    rpcChecker,
    reconciliationEngine,
    settlementAdapter,
    sellerAdapter,
    postSettlementEngine,
    secretariat,
    paymentVerifier,
    reconciliationWorker,
    executionWorker,
    recover,
    startWorker,
    shutdown,
  };
}
