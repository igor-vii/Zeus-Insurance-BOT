/**
 * Zeus Secretariat V0 — Phase 2.2.1 Tests
 *
 * Test AA: Real Restart Resilience
 *   1. Create Intent + Reserve Nonce
 *   2. Simulate restart (new store instance)
 *   3. Verify data survived
 *   4. Attempt duplicate nonce reservation → expect error
 *
 * Test AB: Idempotency
 *   1. Create two Intents with same operationId
 *   2. Second must be rejected by DB unique constraint
 *
 * NOTE: These tests require a real PostgreSQL connection via DATABASE_URL.
 * For CI without DB, they are skipped gracefully.
 */

import { PostgresEvidenceStore } from "../src/store/postgres-store";
import type { PaymentIntent } from "../src/core/types";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("Phase 2.2.1: Durable Storage (PostgreSQL)", () => {
  let store: PostgresEvidenceStore;

  beforeEach(() => {
    store = new PostgresEvidenceStore();
  });

  // ---- Test AA: Restart Resilience ----

  test("AA: data survives simulated restart and duplicate nonce is rejected", async () => {
    const nonce = `test-nonce-${Date.now()}`;
    const operationId = `op-restart-${Date.now()}`;
    const payer = "0xTestPayer";

    const intent: PaymentIntent = {
      intentId: `intent-${Date.now()}`,
      operationId,
      status: "AUTHORIZED",
      payer,
      payTo: "0xTestPayee",
      value: "1000000",
      nonce,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Step 1: Create intent + reserve nonce
    await store.createIntentWithNonce(intent, payer);

    // Step 2: Simulate restart — create NEW store instance
    const store2 = new PostgresEvidenceStore();

    // Step 3: Verify data survived
    const recovered = await store2.getPaymentIntentByOperationId(operationId);
    expect(recovered).not.toBeNull();
    expect(recovered!.operationId).toBe(operationId);
    expect(recovered!.status).toBe("AUTHORIZED");
    expect(recovered!.payer).toBe(payer);
    expect(recovered!.nonce).toBe(nonce);

    // Verify nonce survived
    const nonceRecord = await store2.getNonce(nonce);
    expect(nonceRecord).not.toBeNull();
    expect(nonceRecord!.status).toBe("RESERVED");
    expect(nonceRecord!.operationId).toBe(operationId);

    // Step 4: Attempt duplicate nonce reservation → must fail
    await expect(
      store2.reserveNonce(nonce, "different-op", payer),
    ).rejects.toThrow("NONCE_ALREADY_RESERVED");
  });

  // ---- Test AB: Idempotency ----

  test("AB: duplicate operationId is rejected by unique constraint", async () => {
    const operationId = `op-idempotent-${Date.now()}`;

    const intent1: PaymentIntent = {
      intentId: `intent-first-${Date.now()}`,
      operationId,
      status: "AUTHORIZED",
      payer: "0xPayer1",
      payTo: "0xPayee1",
      value: "500000",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const intent2: PaymentIntent = {
      intentId: `intent-second-${Date.now()}`,
      operationId, // SAME operationId!
      status: "SUBMITTED",
      payer: "0xPayer2",
      payTo: "0xPayee2",
      value: "999999",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // First insert succeeds
    await store.createPaymentIntent(intent1);

    // Second insert must fail due to UNIQUE constraint on operation_id
    await expect(store.createPaymentIntent(intent2)).rejects.toThrow();

    // Verify only first intent exists
    const recovered = await store.getPaymentIntentByOperationId(operationId);
    expect(recovered).not.toBeNull();
    expect(recovered!.payer).toBe("0xPayer1");
    expect(recovered!.value).toBe("500000");
  });

  // ---- Test AC: Nonce lifecycle transitions ----

  test("AC: nonce status transitions RESERVED → SIGNED → SUBMITTED → SETTLED", async () => {
    const nonce = `test-lifecycle-${Date.now()}`;
    const operationId = `op-lifecycle-${Date.now()}`;
    const payer = "0xLifecyclePayer";

    await store.reserveNonce(nonce, operationId, payer);

    let record = await store.getNonce(nonce);
    expect(record!.status).toBe("RESERVED");

    await store.markNonceSigned(nonce);
    record = await store.getNonce(nonce);
    expect(record!.status).toBe("SIGNED");

    await store.markNonceSubmitted(nonce);
    record = await store.getNonce(nonce);
    expect(record!.status).toBe("SUBMITTED");

    await store.markNonceSettled(nonce);
    record = await store.getNonce(nonce);
    expect(record!.status).toBe("SETTLED");
  });

  // ---- Test AD: Payment intent status update ----

  test("AD: payment intent status updates correctly with txHash", async () => {
    const intent: PaymentIntent = {
      intentId: `intent-update-${Date.now()}`,
      operationId: `op-update-${Date.now()}`,
      status: "AUTHORIZED",
      payer: "0xUpdatePayer",
      payTo: "0xUpdatePayee",
      value: "2000000",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.createPaymentIntent(intent);

    await store.updatePaymentIntentStatus(intent.intentId, "SUBMITTED", {
      signature: "0xdeadbeef",
    });

    let recovered = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(recovered!.status).toBe("SUBMITTED");
    expect(recovered!.signature).toBe("0xdeadbeef");

    await store.updatePaymentIntentStatus(intent.intentId, "SETTLED", {
      txHash: "0xabcdef1234567890",
    });

    recovered = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(recovered!.status).toBe("SETTLED");
    expect(recovered!.txHash).toBe("0xabcdef1234567890");
  });
});
