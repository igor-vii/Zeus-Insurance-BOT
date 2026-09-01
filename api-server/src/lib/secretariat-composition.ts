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

import { db } from "@workspace/db";
import {
  createSharedStores,
  MultiRpcChecker,
  ReconciliationEngine,
  ReconciliationWorker,
  X402FacilitatorClient,
  PostSettlementEngine,
  HttpSellerExecutionAdapter,
  Secretariat,
  DEFAULT_RECONCILIATION_SCHEDULE,
  DEFAULT_FINALITY_POLICY,
} from "zeus-secretariat";
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
  readonly reconciliationWorker: InstanceType<typeof ReconciliationWorker>;

  /** Run startup recovery (call BEFORE startWorker). */
  recover(): Promise<void>;

  /** Start the reconciliation worker polling loop. */
  startWorker(): void;

  /** Graceful shutdown. Idempotent — safe to call multiple times. */
  shutdown(): Promise<void>;
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

  // 6. Payment signer (custodial LOCAL_EOA — see TRACE #8-E)
  const signer = createLocalEoaSignerFromEnv(config.signer.privateKeyEnvVar);

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
  const secretariat = new Secretariat({
    evidenceStore: stores.evidenceStore,
    signer,
    adapters: new Map(), // Legacy PaymentAdapter map — empty for V2-only path
    settlementAdapter,
    reconciliationEngine,
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

  // --- Lifecycle methods ---

  let shutdownCalled = false;

  async function recover(): Promise<void> {
    // Reconciliation crash recovery
    try {
      const results = await reconciliationEngine.recoverAfterCrash();
      if (results.size > 0) {
        logger.info(`[composition] recoverAfterCrash: reconciled ${results.size} intents`);
      }
    } catch (err) {
      logger.warn("[composition] recoverAfterCrash failed", err);
    }

    // Post-settlement execution recovery
    try {
      const recovered = await postSettlementEngine.recoverPendingJobs();
      if (recovered.length > 0) {
        logger.info(`[composition] PostSettlementEngine: recovered ${recovered.length} jobs`);
      }
    } catch (err) {
      logger.warn("[composition] PostSettlementEngine recovery failed", err);
    }
  }

  function startWorker(): void {
    reconciliationWorker.start();
    logger.info("[composition] ReconciliationWorker started");
  }

  async function shutdown(): Promise<void> {
    if (shutdownCalled) return; // idempotent
    shutdownCalled = true;

    logger.info("[composition] Graceful shutdown initiated");
    await reconciliationWorker.stop();
    logger.info("[composition] ReconciliationWorker stopped");
  }

  return {
    stores,
    rpcChecker,
    reconciliationEngine,
    settlementAdapter,
    sellerAdapter,
    postSettlementEngine,
    secretariat,
    reconciliationWorker,
    recover,
    startWorker,
    shutdown,
  };
}
