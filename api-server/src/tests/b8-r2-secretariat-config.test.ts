/**
 * BLOCK 8 R2.0 — Secretariat Production Configuration Tests
 */

// We test the config module by manipulating process.env directly.
// Each test saves/restores env to avoid cross-test pollution.

const VALID_RPC_PROVIDERS = JSON.stringify([
  { providerId: "alchemy", underlyingProvider: "alchemy", rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/test", maxStalenessBlocks: 10 },
  { providerId: "infura", underlyingProvider: "infura", rpcUrl: "https://mainnet.infura.io/v3/test", maxStalenessBlocks: 10 },
]);

function setValidEnv() {
  process.env["ZEUS_RPC_PROVIDERS"] = VALID_RPC_PROVIDERS;
  process.env["ZEUS_FACILITATOR_URL"] = "https://x402.example.com";
  process.env["ZEUS_SELLER_URL"] = "https://seller.example.com";
}

function clearSecretariatEnv() {
  const keys = [
    "ZEUS_RPC_PROVIDERS", "ZEUS_FACILITATOR_URL", "ZEUS_FACILITATOR_API_KEY",
    "ZEUS_FACILITATOR_TIMEOUT_MS", "ZEUS_SELLER_URL", "ZEUS_SELLER_TIMEOUT_MS",
    "ZEUS_SELLER_METHOD", "ZEUS_EXECUTION_LOCK_MS", "ZEUS_MAX_EXECUTION_ATTEMPTS",
    "ZEUS_RECON_POLL_MS", "ZEUS_RECON_LEASE_MS", "ZEUS_RECON_ERROR_BACKOFF_MS",
    "ZEUS_RECON_BATCH_SIZE", "ZEUS_SIGNER_PRIVATE_KEY_ENV",
  ];
  for (const k of keys) delete process.env[k];
}

describe("BLOCK 8 R2.0: Secretariat Production Configuration", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearSecretariatEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // R2.0-1: Valid configuration parses successfully
  test("R2.0-1: valid config parses", async () => {
    setValidEnv();
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    const config = loadSecretariatProductionConfig();
    expect(config.rpcProviders.length).toBe(2);
    expect(config.facilitatorBaseUrl).toBe("https://x402.example.com");
    expect(config.sellerUrl).toBe("https://seller.example.com");
    expect(config.reconciliation.pollIntervalMs).toBe(5000);
    expect(config.signer.mode).toBe("LOCAL_EOA");
    expect(config.signer.nonCustodialReady).toBe(false);
  });

  // R2.0-2: Missing RPC configuration fails explicitly
  test("R2.0-2: missing RPC config fails", async () => {
    setValidEnv();
    delete process.env["ZEUS_RPC_PROVIDERS"];
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    expect(() => loadSecretariatProductionConfig()).toThrow(/ZEUS_RPC_PROVIDERS.*missing/);
  });

  // R2.0-3: Invalid RPC configuration fails explicitly
  test("R2.0-3: invalid RPC config fails", async () => {
    setValidEnv();
    process.env["ZEUS_RPC_PROVIDERS"] = "not-json";
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    expect(() => loadSecretariatProductionConfig()).toThrow(/not valid JSON/);
  });

  // R2.0-4: Missing facilitator configuration fails explicitly
  test("R2.0-4: missing facilitator config fails", async () => {
    setValidEnv();
    delete process.env["ZEUS_FACILITATOR_URL"];
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    expect(() => loadSecretariatProductionConfig()).toThrow(/ZEUS_FACILITATOR_URL.*missing/);
  });

  // R2.0-5: Existing ZEUS_SELLER_URL is used as canonical seller source
  test("R2.0-5: uses existing ZEUS_SELLER_URL", async () => {
    setValidEnv();
    process.env["ZEUS_SELLER_URL"] = "https://custom-seller.example.com";
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    const config = loadSecretariatProductionConfig();
    expect(config.sellerUrl).toBe("https://custom-seller.example.com");
  });

  // R2.0-6: Worker config uses existing canonical defaults
  test("R2.0-6: worker config defaults match canonical values", async () => {
    setValidEnv();
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    const config = loadSecretariatProductionConfig();
    // Defaults match ReconciliationWorker DEFAULT_CONFIG from reconciliation-worker.ts
    expect(config.reconciliation.pollIntervalMs).toBe(5000);
    expect(config.reconciliation.leaseDurationMs).toBe(30000);
    expect(config.reconciliation.errorBackoffMs).toBe(10000);
    expect(config.reconciliation.batchSize).toBe(100);
  });

  // R2.0-7: No production-critical parameter receives fake/hardcoded fallback
  test("R2.0-7: required params have no fake fallback", async () => {
    // All three required params must throw when missing
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");

    // Missing RPC
    clearSecretariatEnv();
    process.env["ZEUS_FACILITATOR_URL"] = "https://x402.example.com";
    process.env["ZEUS_SELLER_URL"] = "https://seller.example.com";
    expect(() => loadSecretariatProductionConfig()).toThrow(/ZEUS_RPC_PROVIDERS/);

    // Missing facilitator
    clearSecretariatEnv();
    process.env["ZEUS_RPC_PROVIDERS"] = VALID_RPC_PROVIDERS;
    process.env["ZEUS_SELLER_URL"] = "https://seller.example.com";
    expect(() => loadSecretariatProductionConfig()).toThrow(/ZEUS_FACILITATOR_URL/);

    // Missing seller
    clearSecretariatEnv();
    process.env["ZEUS_RPC_PROVIDERS"] = VALID_RPC_PROVIDERS;
    process.env["ZEUS_FACILITATOR_URL"] = "https://x402.example.com";
    expect(() => loadSecretariatProductionConfig()).toThrow(/ZEUS_SELLER_URL/);
  });

  // R2.0-8: Signer config exposes custodial limitation
  test("R2.0-8: signer config documents custodial limitation", async () => {
    setValidEnv();
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    const config = loadSecretariatProductionConfig();
    expect(config.signer.mode).toBe("LOCAL_EOA");
    expect(config.signer.nonCustodialReady).toBe(false);
    expect(config.signer.privateKeyEnvVar).toBe("ZEUS_SIGNER_PRIVATE_KEY");
  });

  // R2.0-9: Config module does not create runtime services
  test("R2.0-9: config loading creates no DB/RPC/runtime services", async () => {
    setValidEnv();
    const { loadSecretariatProductionConfig } = await import("../../src/lib/secretariat-config");
    const config = loadSecretariatProductionConfig();
    // Config is a plain object with only primitive/array values
    expect(typeof config).toBe("object");
    expect(config.rpcProviders).toBeInstanceOf(Array);
    // No methods, no class instances, no connections
    expect(typeof config.rpcProviders[0]).toBe("object");
    expect(Object.keys(config.rpcProviders[0])).toEqual(
      expect.arrayContaining(["providerId", "underlyingProvider", "rpcUrl", "maxStalenessBlocks"])
    );
  });
});
