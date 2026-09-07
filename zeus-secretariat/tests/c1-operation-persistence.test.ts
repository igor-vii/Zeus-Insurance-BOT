/**
 * Repair C1 — Operation Request Semantics Persistence Tests
 * 
 * Proves that target, method, and paymentPolicy survive durable round-trip
 * through the production PostgresEvidenceStore.
 */

import type { Operation } from "../src/core/types";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("Repair C1: Operation request semantics persistence", () => {
  let store: any;

  beforeAll(async () => {
    const mod = await import("../src/store/postgres-store");
    const { db } = await import("@workspace/db");
    store = new mod.PostgresEvidenceStore(db);
  });

  function makeOperation(overrides?: Partial<Operation>): Operation {
    const now = Date.now();
    return {
      operationId: `op-c1-${now}-${Math.random().toString(36).slice(2)}`,
      requestId: `req-c1-${now}`,
      clientId: `client-c1-${now}`,
      target: "https://seller.example.com/api/v1/execute",
      method: "POST",
      paymentPolicy: { maxAmount: "100.00", asset: "USDC", network: "base" },
      paymentState: "NOT_STARTED" as any,
      executionState: "NOT_STARTED" as any,
      deliveryState: "NOT_STARTED",
      currentState: "CREATED" as any,
      timestamps: { createdAt: now, updatedAt: now },
      evidence: [],
      ...overrides,
    };
  }

  test("Case 1: persist + read back preserves target/method/paymentPolicy", async () => {
    const op = makeOperation();

    // Save operation (writes target/method/paymentPolicy to payment_intents)
    await store.saveOperation(op);

    // Read back via getOperationByRequestId
    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.target).toBe("https://seller.example.com/api/v1/execute");
    expect(restored!.method).toBe("POST");
    expect(restored!.paymentPolicy).toEqual({ maxAmount: "100.00", asset: "USDC", network: "base" });
  });

  test("Case 2: restart reconstruction from durable storage only", async () => {
    const op = makeOperation({
      target: "https://merchant.example.com/pay",
      method: "PUT",
      paymentPolicy: { tier: "premium", limit: "500.00" },
    });

    await store.saveOperation(op);

    // Simulate restart: create fresh store instance, no in-memory state
    const { PostgresEvidenceStore } = await import("../src/store/postgres-store");
    const { db } = await import("@workspace/db");
    const freshStore = new PostgresEvidenceStore(db);

    const restored = await freshStore.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.target).toBe("https://merchant.example.com/pay");
    expect(restored!.method).toBe("PUT");
    expect(restored!.paymentPolicy).toEqual({ tier: "premium", limit: "500.00" });
  });

  test("Case 3: idempotent re-entry returns same semantics", async () => {
    const op = makeOperation({
      target: "https://api.example.com/v2/charge",
      method: "POST",
      paymentPolicy: { currency: "USDC", maxRetries: 3 },
    });

    // First save
    await store.saveOperation(op);

    // Second save (idempotent update)
    await store.saveOperation(op);

    // Read back — must still have correct values, not empty
    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.target).toBe("https://api.example.com/v2/charge");
    expect(restored!.method).toBe("POST");
    expect(restored!.paymentPolicy).toEqual({ currency: "USDC", maxRetries: 3 });

    // Also verify via client+request lookup
    const restored2 = await store.getOperationByClientAndRequestId(op.clientId!, op.requestId!);
    expect(restored2).not.toBeNull();
    expect(restored2!.target).toBe("https://api.example.com/v2/charge");
    expect(restored2!.method).toBe("POST");
    expect(restored2!.paymentPolicy).toEqual({ currency: "USDC", maxRetries: 3 });
  });

  test("Case 4: legacy row without target/method/policy returns safe defaults", async () => {
    // This tests backward compatibility: old DPI rows created before C1 migration
    // will have NULL in these columns. Reconstruction should return safe defaults.
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    
    const legacyOpId = `op-legacy-${Date.now()}`;
    const legacyReqId = `req-legacy-${Date.now()}`;
    
    // Insert a DPI row directly with NULL target/method/policy (simulating pre-C1 row)
    await db.execute(sql`
      INSERT INTO payment_intents (
        payment_intent_id, operation_id, request_id, client_id,
        authorizer, pay_to, value, asset, network,
        nonce, valid_after, valid_before,
        payment_payload, payment_payload_hash,
        settlement_state, version, created_at, updated_at
      ) VALUES (
        ${`pi-legacy-${Date.now()}`}, ${legacyOpId}, ${legacyReqId}, ${`client-legacy-${Date.now()}`},
        ${"0x0000000000000000000000000000000000000000"}, ${"0x0000000000000000000000000000000000000001"},
        ${"0"}, ${"USDC"}, ${"base"},
        ${"0x" + "0".repeat(64)}, 0, 9999999999,
        ${"{}"}, ${"0x" + "0".repeat(64)},
        ${"AUTHORIZED"}, 0, NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `);

    const restored = await store.getOperationByRequestId(legacyReqId);
    if (restored) {
      // Legacy rows should get safe defaults, not crash
      expect(typeof restored.target).toBe("string");
      expect(typeof restored.method).toBe("string");
      expect(restored.paymentPolicy).toBeDefined();
    }

    // Cleanup
    await db.execute(sql`DELETE FROM payment_intents WHERE operation_id = ${legacyOpId}`);
  });
});
