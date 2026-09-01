/**
 * BLOCK 8 R2.1 — Production Composition Root Tests
 *
 * Verifies shared instance invariants, lifecycle ordering, and shutdown semantics.
 * Uses mocked dependencies to avoid real DB/RPC/signer requirements.
 */

// Mock external dependencies before imports
jest.mock("@workspace/db", () => ({ db: { mock: true } }));
jest.mock("zeus-secretariat", () => {
  const actual = jest.requireActual("zeus-secretariat");
  return {
    ...actual,
    // Override store constructors to return trackable instances
    createSharedStores: jest.fn((db: unknown) => ({
      evidenceStore: { __instance: "evidenceStore", db },
      executionStore: { __instance: "executionStore", db },
    })),
  };
});
jest.mock("zeus-secretariat/adapters/local-eoa-signer", () => ({
  createLocalEoaSignerFromEnv: jest.fn(() => ({ signerType: "LOCAL_EOA", getAddress: async () => "0xTest", signPayment: async () => ({}) })),
}));
jest.mock("../src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Set required env vars for config validation
const VALID_RPC = JSON.stringify([
  { providerId: "a", underlyingProvider: "alchemy", rpcUrl: "https://a.example.com", maxStalenessBlocks: 10 },
  { providerId: "b", underlyingProvider: "infura", rpcUrl: "https://b.example.com", maxStalenessBlocks: 10 },
]);

describe("BLOCK 8 R2.1: Production Composition Root", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env["ZEUS_RPC_PROVIDERS"] = VALID_RPC;
    process.env["ZEUS_FACILITATOR_URL"] = "https://facilitator.example.com";
    process.env["ZEUS_SELLER_URL"] = "https://seller.example.com";
    process.env["ZEUS_SIGNER_PRIVATE_KEY"] = "0x" + "a".repeat(64);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test("R2.1-1: composition creates all required components", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    expect(c.stores).toBeDefined();
    expect(c.rpcChecker).toBeDefined();
    expect(c.reconciliationEngine).toBeDefined();
    expect(c.settlementAdapter).toBeDefined();
    expect(c.sellerAdapter).toBeDefined();
    expect(c.postSettlementEngine).toBeDefined();
    expect(c.secretariat).toBeDefined();
    expect(c.reconciliationWorker).toBeDefined();
    expect(typeof c.recover).toBe("function");
    expect(typeof c.startWorker).toBe("function");
    expect(typeof c.shutdown).toBe("function");
  });

  test("R2.1-2: shared evidenceStore used by engine and worker", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    // Both engine and worker receive the same evidenceStore reference
    expect(c.stores.evidenceStore).toBe((c.reconciliationEngine as any).store);
    expect(c.stores.evidenceStore).toBe((c.reconciliationWorker as any).store);
  });

  test("R2.1-3: shared reconciliationEngine used by worker and secretariat", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    expect(c.reconciliationEngine).toBe((c.reconciliationWorker as any).engine);
    expect(c.reconciliationEngine).toBe((c.secretariat as any).config.reconciliationEngine);
  });

  test("R2.1-4: PostSettlementEngine uses shared stores", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    expect(c.stores.evidenceStore).toBe((c.postSettlementEngine as any).paymentStore);
  });

  test("R2.1-5: worker is NOT started during construction", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    // Worker should exist but not be running
    expect(c.reconciliationWorker).toBeDefined();
    expect((c.reconciliationWorker as any).running).toBeFalsy();
  });

  test("R2.1-6: startWorker activates polling", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    c.startWorker();
    expect((c.reconciliationWorker as any).running).toBe(true);
    await c.shutdown();
  });

  test("R2.1-7: shutdown is idempotent", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    c.startWorker();
    await c.shutdown();
    // Second shutdown should not throw or cause issues
    await c.shutdown();
    expect((c.reconciliationWorker as any).running).toBe(false);
  });

  test("R2.1-8: recover runs without errors", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    // recover should not throw even with no data
    await expect(c.recover()).resolves.not.toThrow();
  });

  test("R2.1-9: repeated factory calls create independent graphs", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const a = createSecretariatComposition();
    const b = createSecretariatComposition();
    // Different compositions have different instances
    expect(a.reconciliationEngine).not.toBe(b.reconciliationEngine);
    expect(a.reconciliationWorker).not.toBe(b.reconciliationWorker);
    // But within each composition, sharing holds
    expect(a.stores.evidenceStore).toBe((a.reconciliationEngine as any).store);
    expect(b.stores.evidenceStore).toBe((b.reconciliationEngine as any).store);
  });
});


// ---------------------------------------------------------------------------
// R2.1-FIX-6: Strengthened tests
// ---------------------------------------------------------------------------

describe("BLOCK 8 R2.1-FIX-6: Strengthened Composition Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env["ZEUS_RPC_PROVIDERS"] = JSON.stringify([
      { providerId: "a", underlyingProvider: "alchemy", rpcUrl: "https://a.example.com", maxStalenessBlocks: 10 },
      { providerId: "b", underlyingProvider: "infura", rpcUrl: "https://b.example.com", maxStalenessBlocks: 10 },
    ]);
    process.env["ZEUS_FACILITATOR_URL"] = "https://facilitator.example.com";
    process.env["ZEUS_SELLER_URL"] = "https://seller.example.com";
    process.env["ZEUS_SIGNER_PRIVATE_KEY"] = "0x" + "a".repeat(64);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test("R2.1-FIX-6-1: recovery failure prevents worker startup", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();

    // Mock recoverAfterCrash to throw
    const origRecover = c.reconciliationEngine.recoverAfterCrash;
    c.reconciliationEngine.recoverAfterCrash = async () => { throw new Error("RECOVERY_FAILED"); };

    // recover() should throw — worker must NOT be started
    await expect(c.recover()).rejects.toThrow("RECOVERY_FAILED");

    // Worker should not have been started
    expect((c.reconciliationWorker as any).running).toBeFalsy();

    // Restore
    c.reconciliationEngine.recoverAfterCrash = origRecover;
  });

  test("R2.1-FIX-6-2: PostSettlementEngine receives ExecutionStore (not InMemoryExecutionStore)", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();

    // PostSettlementEngine.paymentStore should be the shared evidenceStore
    expect((c.postSettlementEngine as any).paymentStore).toBe(c.stores.evidenceStore);

    // executionStore should be the shared executionStore (PostgresExecutionStore satisfies ExecutionStore interface)
    expect((c.postSettlementEngine as any).executionStore).toBe(c.stores.executionStore);
  });

  test("R2.1-FIX-6-3: shutdown completes worker stop before returning", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    c.startWorker();

    expect((c.reconciliationWorker as any).running).toBe(true);

    // shutdown should resolve only after worker is stopped
    await c.shutdown();

    expect((c.reconciliationWorker as any).running).toBe(false);
  });

  test("R2.1-FIX-6-4: double shutdown is safe and idempotent", async () => {
    const { createSecretariatComposition } = await import("../../src/lib/secretariat-composition");
    const c = createSecretariatComposition();
    c.startWorker();

    await c.shutdown();
    // Second shutdown should not throw or cause side effects
    await expect(c.shutdown()).resolves.not.toThrow();

    expect((c.reconciliationWorker as any).running).toBe(false);
  });

  test("R2.1-FIX-6-5: no as any in PostSettlementEngine construction", async () => {
    // Static verification: composition source should not contain "as any" for executionStore
    const fs = await import("fs");
    const source = fs.readFileSync(
      require("path").join(__dirname, "../../src/lib/secretariat-composition.ts"),
      "utf-8"
    );
    // The line that previously had "stores.executionStore as any" should now be clean
    expect(source).not.toMatch(/executionStore\s+as\s+any/);
  });
});
