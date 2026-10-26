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
  StandardX402Transport,
  PostSettlementEngine,
  HttpSellerExecutionAdapter,
  Secretariat,
  ExecutionWorker,
  ExecutionFeedbackService,
  DEFAULT_RECONCILIATION_SCHEDULE,
  DEFAULT_FINALITY_POLICY,
} from "zeus-secretariat";
import type { Eip3009Domain } from "zeus-secretariat";
import type { PaymentSigner } from "zeus-secretariat/core/types";
import type { Address } from "viem";
import { createLocalEoaSignerFromEnv } from "zeus-secretariat/adapters/local-eoa-signer";
import { loadSecretariatProductionConfig } from "./secretariat-config.js";
import { logger } from "./logger.js";

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
  // F-113/C-2 (external audit 2026-10-26, Major): the repo's own x402 stack
  // advertises CAIP-2 network ids (config/x402.ts routes use "eip155:196" and
  // the patched x402 dependency accepts that id), so a DPI bound to such an
  // id previously hit the default arm and threw — the Secretariat could not
  // resolve the EIP-3009 domain for its own protected routes. Parse CAIP-2
  // `eip155:<chainId>` generically; the named aliases below stay for
  // backward compatibility with existing policies and fixtures.
  const caip2 = /^eip155:(\d+)$/.exec(network.trim().toLowerCase());
  if (caip2) return Number(caip2[1]);

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

/**
 * Chains where real money moves. For these the EIP-712 domain name/version
 * MUST be pinned explicitly via ZEUS_EIP3009_DOMAIN_NAME /
 * ZEUS_EIP3009_DOMAIN_VERSION — a guessed default would silently produce
 * signatures the on-chain token rejects (every payment fails verification).
 */
const PRODUCTION_CHAIN_IDS = new Set([196, 8453, 677]);

function resolvePaymentDomain(intent: {
  network: string;
  asset: string;
}): Eip3009Domain {
  const verifyingContract = intent.asset;
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) {
    throw new Error("Persisted payment asset is not a valid EVM address");
  }

  // F-113/C-3 (external audit 2026-10-26, Major): fail fast instead of
  // guessing the EIP-712 domain on a money chain. The "USD Coin"/"2" default
  // is correct for Circle's canonical FiatToken deployments, but the actual
  // values are a property of the token contract — pinning them explicitly on
  // production chains turns a silent config drift into a boot-time error.
  const chainId = chainIdForNetwork(intent.network);
  const envName = process.env["ZEUS_EIP3009_DOMAIN_NAME"]?.trim();
  const envVersion = process.env["ZEUS_EIP3009_DOMAIN_VERSION"]?.trim();
  if (PRODUCTION_CHAIN_IDS.has(chainId) && (!envName || !envVersion)) {
    throw new Error(
      `Secretariat composition: network ${intent.network} (chainId ${chainId}) is a production chain — ` +
      `ZEUS_EIP3009_DOMAIN_NAME and ZEUS_EIP3009_DOMAIN_VERSION must be set explicitly ` +
      `(do not rely on the built-in default)`,
    );
  }

  return {
    name: envName || "USD Coin",
    version: envVersion || "2",
    chainId,
    verifyingContract: verifyingContract as Address,
  };
}

export { chainIdForNetwork, resolvePaymentDomain };

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

  // 5b. R9-A1: standard x402 v2 client transport (third-party sellers).
  // Talks straight to seller URLs via the egress policy; the seller's own
  // facilitator verifies + settles. No Zeus facilitator involvement.
  const standardTransport = new StandardX402Transport(
    { timeoutMs: config.facilitatorTimeoutMs },
    stores.evidenceStore,
  );

  // R9-A1: default payment transport — ZEUS_PAYMENT_TRANSPORT "zeus" (default)
  // or "standard". Per-request policy.transport overrides this.
  const rawTransport = String(process.env.ZEUS_PAYMENT_TRANSPORT ?? "zeus").trim().toLowerCase();
  if (rawTransport !== "zeus" && rawTransport !== "standard") {
    throw new Error(
      `Invalid ZEUS_PAYMENT_TRANSPORT="${rawTransport}" — must be "zeus" or "standard"`
    );
  }
  const defaultPaymentTransport = rawTransport as "zeus" | "standard";

  // 6. Explicit custodial test signer only. The default path is non-custodial:
  // the client signs externally and calls Secretariat.submitSignedPayment().
  // R4 (typed): LocalEoaPaymentSigner implements the SIGNING-REQUEST protocol
  // (PaymentAuthorizationRequest → PaymentSignatureResult), NOT the Secretariat
  // PaymentSigner protocol (PaymentRequirement + SigningContext →
  // PaymentAuthorization). The custodial_test path predates the PaymentSigner
  // interface; it is TEST-ONLY (see loadSecretariatProductionConfig) and must
  // never run in production — the cast is explicit and documented, not silent.
  const signer = config.signer.mode === "custodial_test"
    ? (createLocalEoaSignerFromEnv(config.signer.privateKeyEnvVar) as unknown as PaymentSigner)
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
    // R9-A1: standard x402 client transport for third-party sellers
    standardTransport,
    defaultPaymentTransport,
    reconciliationEngine,
    atomicSettlementHandoff: stores.executionStore,
    // F-01 fix: the atomic settlement → execution handoff must honor the same
    // execution-attempt bound as the engine (ZEUS_MAX_EXECUTION_ATTEMPTS).
    maxExecutionAttempts: config.maxExecutionAttempts,
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

  // 11. A1-B: FSM feedback service — bound to the SAME shared durable evidence
  // store the Secretariat delegates getOperation/saveOperation to (the comment's
  // "only durable path" IS the evidenceStore; Secretariat itself only exposes
  // getOperation and internally calls evidenceStore.saveOperation). No new
  // persistence mechanism, no second instance.
  const executionFeedbackService = new ExecutionFeedbackService(stores.evidenceStore);

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
