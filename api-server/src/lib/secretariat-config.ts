/**
 * BLOCK 8 R2.0: Canonical Secretariat Production Configuration
 *
 * Single source of truth for all Secretariat production configuration.
 * Validates env vars at startup; fails explicitly on missing/invalid config.
 *
 * This module ONLY parses/validates configuration.
 * It does NOT create DB connections, RPC clients, or runtime services.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcProviderEntry {
  readonly providerId: string;
  readonly underlyingProvider: string;
  readonly rpcUrl: string;
  readonly maxStalenessBlocks: number;
}

export interface ReconciliationConfig {
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly errorBackoffMs: number;
  readonly batchSize: number;
}

export interface SignerConfig {
  /** Current mode: only "LOCAL_EOA" is implemented (custodial). */
  readonly mode: "LOCAL_EOA";
  /** Env var name containing the private key. */
  readonly privateKeyEnvVar: string;
  /**
   * WARNING: LOCAL_EOA is a custodial development/test signer.
   * Non-custodial external-signature signer is NOT YET IMPLEMENTED.
   * See TRACE #8-E for architectural analysis.
   */
  readonly nonCustodialReady: false;
}

export interface SecretariatProductionConfig {
  readonly rpcProviders: readonly RpcProviderEntry[];
  readonly facilitatorBaseUrl: string;
  readonly facilitatorApiKey: string | undefined;
  readonly facilitatorTimeoutMs: number;
  readonly sellerUrl: string;
  readonly sellerTimeoutMs: number;
  readonly sellerMethod: string;
  readonly executionLockMs: number;
  readonly maxExecutionAttempts: number;
  readonly reconciliation: ReconciliationConfig;
  readonly signer: SignerConfig;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Secretariat config: required env var ${name} is missing or empty`);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function parsePositiveInt(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) {
    throw new Error(`Secretariat config: ${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

function parseUrl(value: string, name: string): string {
  try {
    new URL(value);
  } catch {
    throw new Error(`Secretariat config: ${name} is not a valid URL: "${value}"`);
  }
  return value.replace(/\/$/, ""); // strip trailing slash
}

// ---------------------------------------------------------------------------
// RPC providers parser
// ---------------------------------------------------------------------------

/**
 * Parse ZEUS_RPC_PROVIDERS JSON array.
 * Format: [{"providerId":"alchemy","underlyingProvider":"alchemy","rpcUrl":"https://...","maxStalenessBlocks":10}, ...]
 * Requires at least 2 providers with different underlyingProvider values (§14, §15).
 */
function parseRpcProviders(): RpcProviderEntry[] {
  const raw = requireEnv("ZEUS_RPC_PROVIDERS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Secretariat config: ZEUS_RPC_PROVIDERS is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error("Secretariat config: ZEUS_RPC_PROVIDERS must be an array with at least 2 entries (§14)");
  }
  const providers: RpcProviderEntry[] = [];
  for (const entry of parsed) {
    if (!entry.providerId || !entry.underlyingProvider || !entry.rpcUrl) {
      throw new Error("Secretariat config: each RPC provider must have providerId, underlyingProvider, and rpcUrl");
    }
    parseUrl(entry.rpcUrl, `RPC provider ${entry.providerId} rpcUrl`);
    providers.push({
      providerId: entry.providerId,
      underlyingProvider: entry.underlyingProvider,
      rpcUrl: entry.rpcUrl,
      maxStalenessBlocks: typeof entry.maxStalenessBlocks === "number" ? entry.maxStalenessBlocks : 10,
    });
  }
  // §15: Verify independence
  const uniqueUnderlying = new Set(providers.map(p => p.underlyingProvider));
  if (uniqueUnderlying.size < 2) {
    throw new Error("Secretariat config: ZEUS_RPC_PROVIDERS must have at least 2 different underlyingProvider values (§15)");
  }
  return providers;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Load and validate all Secretariat production configuration from environment.
 * Throws explicit errors on missing/invalid required configuration.
 * Does NOT create any runtime services or connections.
 */
export function loadSecretariatProductionConfig(): SecretariatProductionConfig {
  return {
    // RPC — required, validated
    rpcProviders: parseRpcProviders(),

    // Facilitator — required
    facilitatorBaseUrl: parseUrl(requireEnv("ZEUS_FACILITATOR_URL"), "ZEUS_FACILITATOR_URL"),
    facilitatorApiKey: process.env["ZEUS_FACILITATOR_API_KEY"]?.trim() || undefined,
    facilitatorTimeoutMs: parsePositiveInt(
      optionalEnv("ZEUS_FACILITATOR_TIMEOUT_MS", "30000"),
      "ZEUS_FACILITATOR_TIMEOUT_MS",
    ),

    // Seller — reuses existing ZEUS_SELLER_URL
    sellerUrl: parseUrl(requireEnv("ZEUS_SELLER_URL"), "ZEUS_SELLER_URL"),
    sellerTimeoutMs: parsePositiveInt(
      optionalEnv("ZEUS_SELLER_TIMEOUT_MS", "30000"),
      "ZEUS_SELLER_TIMEOUT_MS",
    ),
    sellerMethod: optionalEnv("ZEUS_SELLER_METHOD", "POST"),
    executionLockMs: parsePositiveInt(
      optionalEnv("ZEUS_EXECUTION_LOCK_MS", "60000"),
      "ZEUS_EXECUTION_LOCK_MS",
    ),
    maxExecutionAttempts: parsePositiveInt(
      optionalEnv("ZEUS_MAX_EXECUTION_ATTEMPTS", "3"),
      "ZEUS_MAX_EXECUTION_ATTEMPTS",
    ),

    // Reconciliation worker — uses existing canonical defaults where available
    reconciliation: {
      pollIntervalMs: parsePositiveInt(
        optionalEnv("ZEUS_RECON_POLL_MS", "5000"),
        "ZEUS_RECON_POLL_MS",
      ),
      leaseDurationMs: parsePositiveInt(
        optionalEnv("ZEUS_RECON_LEASE_MS", "30000"),
        "ZEUS_RECON_LEASE_MS",
      ),
      errorBackoffMs: parsePositiveInt(
        optionalEnv("ZEUS_RECON_ERROR_BACKOFF_MS", "10000"),
        "ZEUS_RECON_ERROR_BACKOFF_MS",
      ),
      batchSize: parsePositiveInt(
        optionalEnv("ZEUS_RECON_BATCH_SIZE", "100"),
        "ZEUS_RECON_BATCH_SIZE",
      ),
    },

    // Signer — documents current custodial limitation
    signer: {
      mode: "LOCAL_EOA" as const,
      privateKeyEnvVar: optionalEnv("ZEUS_SIGNER_PRIVATE_KEY_ENV", "ZEUS_SIGNER_PRIVATE_KEY"),
      nonCustodialReady: false as const,
    },
  };
}
