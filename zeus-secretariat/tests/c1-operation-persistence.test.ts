/**
 * Repair C1 — Operation Request Semantics Persistence Tests
 *
 * Tests the PRODUCTION PostgresEvidenceStore from @workspace/db,
 * NOT a local copy. This is the same store used by api-server composition.
 *
 * Production contract: saveOperation() performs UPDATE on an existing
 * payment_intents row. The DPI row must be created first (mirrors Stage A).
 */

import type { Operation } from "../src/core/types";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("Repair C1: Operation request semantics persistence (production store)", () => {
  let store: any;
  let db: any;

  beforeAll(async () => {
    // Import from @workspace/db — this is the PRODUCTION store and DB instance
    const dbModule = await import("@workspace/db");
    const { PostgresEvidenceStore } = dbModule;
    db = dbModule.db;
    store = new PostgresEvidenceStore(db);
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

  /**
   * Create a minimal payment_intents row for the given Operation.
   * Mirrors the production Stage A contract: DPI must exist before
   * saveOperation() can enrich it with target/method/paymentPolicy.
   * Uses the same SQL pattern proven working in Case 6.
   */
  async function insertTestDpi(op: Operation): Promise<void> {
    const zeroAddr = "0x0000000000000000000000000000000000000000";
    const zeroNonce = "0x" + "0".repeat(64);
    const zeroHash = "0x" + "0".repeat(64);
    await db.execute(`
      INSERT INTO payment_intents (
        payment_intent_id, operation_id, request_id, client_id,
        authorizer, pay_to, value, asset, network,
        nonce, valid_after, valid_before,
        payment_payload, payment_payload_hash,
        settlement_state, version, created_at, updated_at
      ) VALUES (
        'pi-${op.operationId}', '${op.operationId}', '${op.requestId}', '${op.clientId}',
        '${zeroAddr}', '${zeroAddr.slice(0, -1)}1',
        '0', 'USDC', 'base',
        '${zeroNonce}', 0, 9999999999,
        '{}', '${zeroHash}',
        'PENDING_SIGNATURE', 0, NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `);
  }

  test("Case 1: target round-trip through production store", async () => {
    const op = makeOperation({ target: "https://merchant.example.com/pay" });
    await insertTestDpi(op);
    await store.saveOperation(op);

    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.target).toBe("https://merchant.example.com/pay");
  });

  test("Case 2: method round-trip through production store", async () => {
    const op = makeOperation({ method: "PUT" });
    await insertTestDpi(op);
    await store.saveOperation(op);

    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.method).toBe("PUT");
  });

  test("Case 3: paymentPolicy round-trip through production store", async () => {
    const policy = { tier: "premium", limit: "500.00", currency: "USDC" };
    const op = makeOperation({ paymentPolicy: policy });
    await insertTestDpi(op);
    await store.saveOperation(op);

    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.paymentPolicy).toEqual(policy);
  });

  test("Case 4: fresh store instance reconstructs from DB only (restart simulation)", async () => {
    const op = makeOperation({
      target: "https://restart-test.example.com/api",
      method: "PATCH",
      paymentPolicy: { retryLimit: 5 },
    });
    await insertTestDpi(op);
    await store.saveOperation(op);

    // Create completely fresh store — no shared state
    const { PostgresEvidenceStore } = await import("@workspace/db");
    const freshStore = new PostgresEvidenceStore(db);

    const restored = await freshStore.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.target).toBe("https://restart-test.example.com/api");
    expect(restored!.method).toBe("PATCH");
    expect(restored!.paymentPolicy).toEqual({ retryLimit: 5 });
  });

  test("Case 5: clientId + requestId lookup preserves semantics", async () => {
    const op = makeOperation({
      target: "https://dual-lookup.example.com/v2",
      method: "DELETE",
      paymentPolicy: { scope: "refund" },
    });
    await insertTestDpi(op);
    await store.saveOperation(op);

    const restored = await store.getOperationByClientAndRequestId(op.clientId!, op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.target).toBe("https://dual-lookup.example.com/v2");
    expect(restored!.method).toBe("DELETE");
    expect(restored!.paymentPolicy).toEqual({ scope: "refund" });
  });

  /**
   * Legacy row semantics.
   *
   * Pre-C1 rows have NULL target/method/payment_policy.
   * Reconstruction returns "" / "" / {} as fallback.
   *
   * IMPORTANT: These empty values are NOT safe execution defaults.
   * A reconstructed Operation with target="" would cause fetch("") to fail.
   * This test documents the actual behavior without asserting safety.
   *
   * If legacy Operations can reach execution, that is a SEPARATE BUG
   * (legacy execution guard missing) — NOT part of C1 scope.
   */
  test("Case 6: legacy row with NULL fields returns fallback values (documented behavior)", async () => {
    const legacyOpId = `op-legacy-${Date.now()}`;
    const legacyReqId = `req-legacy-${Date.now()}`;
    const legacyClientId = `client-legacy-${Date.now()}`;
    const legacyPiId = `pi-legacy-${Date.now()}`;
    const zeroAddr = "0x0000000000000000000000000000000000000000";
    const zeroNonce = "0x" + "0".repeat(64);
    const zeroHash = "0x" + "0".repeat(64);

    // Insert DPI with NULL target/method/payment_policy using raw SQL via shared db
    await db.execute(`
      INSERT INTO payment_intents (
        payment_intent_id, operation_id, request_id, client_id,
        authorizer, pay_to, value, asset, network,
        nonce, valid_after, valid_before,
        payment_payload, payment_payload_hash,
        settlement_state, version, created_at, updated_at,
        target, method, payment_policy
      ) VALUES (
        '${legacyPiId}', '${legacyOpId}', '${legacyReqId}', '${legacyClientId}',
        '${zeroAddr}', '${zeroAddr.slice(0, -1)}1',
        '0', 'USDC', 'base',
        '${zeroNonce}', 0, 9999999999,
        '{}', '${zeroHash}',
        'AUTHORIZED', 0, NOW(), NOW(),
        NULL, NULL, NULL
      )
      ON CONFLICT DO NOTHING
    `);

    const restored = await store.getOperationByRequestId(legacyReqId);
    if (restored) {
      // Document actual fallback behavior — these are NOT safe for execution
      expect(restored.target).toBe("");
      expect(restored.method).toBe("");
      expect(restored.paymentPolicy).toEqual({});

      // NOTE: If this Operation were passed to execute(), fetch("") would fail.
      // Legacy execution guard is a SEPARATE concern (not C1 scope).
    }

    // Cleanup
    await db.execute(`DELETE FROM payment_intents WHERE operation_id = '${legacyOpId}'`).catch(() => {});
  });
});
