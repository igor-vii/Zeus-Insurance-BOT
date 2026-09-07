/**
 * Repair C2-F1 — Evidence Reconstruction Tests
 *
 * Proves that Operation.evidence survives durable round-trip through
 * the production PostgresEvidenceStore append() → getOperationByRequestId() path.
 */

import type { Operation, EvidenceRecord } from "../src/core/types";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("Repair C2-F1: Evidence reconstruction after restart", () => {
  let store: any;
  let db: any;

  beforeAll(async () => {
    const dbModule = await import("@workspace/db");
    const { PostgresEvidenceStore } = dbModule;
    db = dbModule.db;
    store = new PostgresEvidenceStore(db);
  });

  function makeOperation(overrides?: Partial<Operation>): Operation {
    const now = Date.now();
    return {
      operationId: `op-c2-${now}-${Math.random().toString(36).slice(2)}`,
      requestId: `req-c2-${now}`,
      clientId: `client-c2-${now}`,
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
   * Create minimal DPI row so saveOperation() UPDATE and append() can find it.
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

  test("Case 1: evidence persists and reconstructs via production append() path", async () => {
    const op = makeOperation();
    await insertTestDpi(op);
    await store.saveOperation(op);

    // Record evidence through the PRODUCTION persistence path
    const evidence1: EvidenceRecord = {
      operationId: op.operationId,
      phase: "FINAL",
      timestamp: Date.now(),
      event: "OPERATION_CREATED",
      payload: { requestId: op.requestId, target: op.target },
    };
    await store.append(evidence1);

    const evidence2: EvidenceRecord = {
      operationId: op.operationId,
      phase: "PAYMENT",
      timestamp: Date.now() + 1,
      event: "PAYMENT_AUTHORIZED",
      payload: { authorization: "0xabc123", nonce: "0xdef456" },
    };
    await store.append(evidence2);

    // Reconstruct via fresh store (simulates restart)
    const { PostgresEvidenceStore } = await import("@workspace/db");
    const freshStore = new PostgresEvidenceStore(db);

    const restored = await freshStore.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    expect(restored!.evidence.length).toBeGreaterThanOrEqual(2);

    // Verify specific evidence records are present
    const createdEvent = restored!.evidence.find((e: EvidenceRecord) => e.event === "OPERATION_CREATED");
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.phase).toBe("FINAL");
    expect(createdEvent!.payload).toEqual({ requestId: op.requestId, target: op.target });

    const authEvent = restored!.evidence.find((e: EvidenceRecord) => e.event === "PAYMENT_AUTHORIZED");
    expect(authEvent).toBeDefined();
    expect(authEvent!.phase).toBe("PAYMENT");
    expect(authEvent!.payload).toEqual({ authorization: "0xabc123", nonce: "0xdef456" });
  });

  test("Case 2: evidence metadata preserved (operationId, phase, timestamp)", async () => {
    const op = makeOperation();
    await insertTestDpi(op);
    await store.saveOperation(op);

    const ts = Date.now();
    const evidence: EvidenceRecord = {
      operationId: op.operationId,
      phase: "SETTLEMENT",
      timestamp: ts,
      event: "SETTLEMENT_CONFIRMED",
      payload: { txHash: "0x1234", blockNumber: 42 },
    };
    await store.append(evidence);

    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();

    const settlementEvent = restored!.evidence.find((e: EvidenceRecord) => e.event === "SETTLEMENT_CONFIRMED");
    expect(settlementEvent).toBeDefined();
    expect(settlementEvent!.operationId).toBe(op.operationId);
    expect(settlementEvent!.phase).toBe("SETTLEMENT");
    expect(settlementEvent!.timestamp).toBe(ts);
    expect(settlementEvent!.payload).toEqual({ txHash: "0x1234", blockNumber: 42 });
  });

  test("Case 3: empty evidence for operation with no appended records", async () => {
    const op = makeOperation();
    await insertTestDpi(op);
    await store.saveOperation(op);

    // Do NOT append any evidence
    const restored = await store.getOperationByRequestId(op.requestId!);
    expect(restored).not.toBeNull();
    // Should be empty array or null-safe equivalent
    expect(Array.isArray(restored!.evidence)).toBe(true);
  });
});
