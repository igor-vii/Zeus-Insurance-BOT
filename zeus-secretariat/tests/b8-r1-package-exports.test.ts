/**
 * BLOCK 8 R1 — Package Exports & Shared Store Factory Tests
 */

// Test 1: Public exports are accessible through canonical package entrypoint
describe("BLOCK 8 R1: Public Package Exports", () => {
  test("R1.1: ReconciliationEngine is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.ReconciliationEngine).toBeDefined();
    expect(typeof mod.ReconciliationEngine).toBe("function");
  });

  test("R1.2: ReconciliationWorker is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.ReconciliationWorker).toBeDefined();
    expect(typeof mod.ReconciliationWorker).toBe("function");
  });

  test("R1.3: MultiRpcChecker is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.MultiRpcChecker).toBeDefined();
    expect(typeof mod.MultiRpcChecker).toBe("function");
  });

  test("R1.4: PostgresEvidenceStore is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.PostgresEvidenceStore).toBeDefined();
    expect(typeof mod.PostgresEvidenceStore).toBe("function");
  });

  test("R1.5: PostgresExecutionStore is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.PostgresExecutionStore).toBeDefined();
    expect(typeof mod.PostgresExecutionStore).toBe("function");
  });

  test("R1.6: createSharedStores factory is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.createSharedStores).toBeDefined();
    expect(typeof mod.createSharedStores).toBe("function");
  });

  test("R1.7: PostSettlementEngine is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.PostSettlementEngine).toBeDefined();
    expect(typeof mod.PostSettlementEngine).toBe("function");
  });

  test("R1.8: HttpSellerExecutionAdapter is exported", async () => {
    const mod = await import("../src/index");
    expect(mod.HttpSellerExecutionAdapter).toBeDefined();
    expect(typeof mod.HttpSellerExecutionAdapter).toBe("function");
  });
});

// Test 2-4: Shared store factory behavior
describe("BLOCK 8 R1: Shared Store Factory", () => {
  test("R1.9: createSharedStores returns evidenceStore and executionStore", async () => {
    const { createSharedStores } = await import("../src/store/factory");
    // Pass a truthy value as db placeholder — factory validates non-null
    const stores = createSharedStores({ mock: true });
    expect(stores.evidenceStore).toBeDefined();
    expect(stores.executionStore).toBeDefined();
  });

  test("R1.10: createSharedStores throws without db parameter", async () => {
    const { createSharedStores } = await import("../src/store/factory");
    expect(() => createSharedStores(null as any)).toThrow(/requires a db instance/);
    expect(() => createSharedStores(undefined as any)).toThrow(/requires a db instance/);
  });

  test("R1.11: returned stores are reusable instances (identity)", async () => {
    const { createSharedStores } = await import("../src/store/factory");
    const stores = createSharedStores({ mock: true });
    // Same reference when accessed multiple times
    expect(stores.evidenceStore).toBe(stores.evidenceStore);
    expect(stores.executionStore).toBe(stores.executionStore);
    // Different instances from separate factory calls
    const stores2 = createSharedStores({ mock: true });
    expect(stores.evidenceStore).not.toBe(stores2.evidenceStore);
  });
});
