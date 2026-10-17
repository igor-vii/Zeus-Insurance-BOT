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

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
// NOTE: `@workspace/db` and its barrel are imported LAZILY inside tests/beforeAll,
// exactly like b8-1-repair3d-pg-runtime.test.ts — the lib/db entry module throws at
// import time when DATABASE_URL is unset ("DATABASE_URL must be set"), which would
// break the graceful-skip-without-DB mode. Type-only imports are erased at runtime.
import type { PostgresEvidenceStore as PostgresEvidenceStoreType } from "@workspace/db";
import type { DurablePaymentIntent, EvidenceRecord } from "../src/core/types";

/*
 * S1-C3-R1-A gate: unconditional skip replaced with the repository-standard
 * conditional skip (see c1/c2/b8-1-repair3d tests):
 *   - Without DATABASE_URL the whole PostgreSQL suite is SKIPPED explicitly
 *     (never faked) — ordinary local runs stay green but visibly skipped.
 *   - With ZEUS_REQUIRE_DATABASE=1 and no DATABASE_URL the SUITE FAILS at load
 *     time, so a required-PostgreSQL run can never report success while the
 *     integration suite was skipped. Use `pnpm test:durable` in CI/required mode.
 */
const HAS_DB = !!process.env["DATABASE_URL"];
if (process.env["ZEUS_REQUIRE_DATABASE"] === "1" && !HAS_DB) {
  throw new Error(
    "ZEUS_REQUIRE_DATABASE=1 but DATABASE_URL is not set: the durable-storage " +
      "PostgreSQL integration suite must RUN, not be skipped. Export a real " +
      "DATABASE_URL before invoking `pnpm test:durable`.",
  );
}
const describeIfDb = HAS_DB ? describe : describe.skip;

describeIfDb("Phase 2.2.1: Durable Storage (PostgreSQL)", () => {
  let store: PostgresEvidenceStoreType;
  let PES: typeof PostgresEvidenceStoreType;
  let db: any;

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    PES = dbMod.PostgresEvidenceStore;
  });

  beforeEach(() => {
    store = new PES(db);
  });

  // ---- Test AA: Restart Resilience ----

  test("AA: data survives simulated restart and duplicate nonce is rejected", async () => {
    const nonce = `test-nonce-${Date.now()}`;
    const operationId = `op-restart-${Date.now()}`;
    const payer = "0xTestPayer";

    const now = Math.floor(Date.now() / 1000);
    const intent: DurablePaymentIntent = {
      paymentIntentId: `intent-${Date.now()}`,
      operationId,
      settlementState: "AUTHORIZED",
      authorizer: payer,
      payTo: "0xTestPayee",
      value: "1000000",
      asset: "0xUSDC",
      network: "base-sepolia",
      nonce,
      validAfter: now - 3600,
      validBefore: now + 3600,
      paymentPayload: "base64payload",
      paymentPayloadHash: "0xhash",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Step 1: Create intent + reserve nonce
    await store.createIntentWithNonce(intent, payer);

    // Step 2: Simulate restart — create NEW store instance
    const store2 = new PES(db);

    // Step 3: Verify data survived
    const recovered = await store2.getPaymentIntentByOperationId(operationId);
    expect(recovered).not.toBeNull();
    expect(recovered!.operationId).toBe(operationId);
    expect(recovered!.settlementState).toBe("AUTHORIZED");
    expect((recovered as any).payer).toBe(payer);
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

    const now2 = Math.floor(Date.now() / 1000);
    const intent1: DurablePaymentIntent = {
      paymentIntentId: `intent-first-${Date.now()}`,
      operationId,
      settlementState: "AUTHORIZED",
      authorizer: "0xPayer1",
      payTo: "0xPayee1",
      value: "500000",
      asset: "0xUSDC",
      network: "base-sepolia",
      nonce: `0x${Date.now().toString(16)}a`,
      validAfter: now2 - 3600,
      validBefore: now2 + 3600,
      paymentPayload: "base64payload1",
      paymentPayloadHash: "0xhash1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const intent2: DurablePaymentIntent = {
      paymentIntentId: `intent-second-${Date.now()}`,
      operationId, // SAME operationId!
      settlementState: "SUBMITTED",
      authorizer: "0xPayer2",
      payTo: "0xPayee2",
      value: "999999",
      asset: "0xUSDC",
      network: "base-sepolia",
      nonce: `0x${Date.now().toString(16)}b`,
      validAfter: now2 - 3600,
      validBefore: now2 + 3600,
      paymentPayload: "base64payload2",
      paymentPayloadHash: "0xhash2",
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
    expect((recovered as any).payer).toBe("0xPayer1");
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
    const now3 = Math.floor(Date.now() / 1000);
    const intent: DurablePaymentIntent = {
      paymentIntentId: `intent-update-${Date.now()}`,
      operationId: `op-update-${Date.now()}`,
      settlementState: "AUTHORIZED",
      authorizer: "0xUpdatePayer",
      payTo: "0xUpdatePayee",
      value: "2000000",
      asset: "0xUSDC",
      network: "base-sepolia",
      nonce: `0x${Date.now().toString(16)}c`,
      validAfter: now3 - 3600,
      validBefore: now3 + 3600,
      paymentPayload: "base64payload3",
      paymentPayloadHash: "0xhash3",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.createPaymentIntent(intent);

    await store.updatePaymentIntentStatus(intent.paymentIntentId, "SUBMITTED", {
      signature: "0xdeadbeef",
    });

    let recovered = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(recovered!.settlementState).toBe("SUBMITTED");
    expect((recovered as any).signature).toBe("0xdeadbeef");

    await store.updatePaymentIntentStatus(intent.paymentIntentId, "SETTLED", {
      txHash: "0xabcdef1234567890",
    });

    recovered = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(recovered!.settlementState).toBe("SETTLED");
    expect(recovered!.txHash).toBe("0xabcdef1234567890");
  });

  // ---- Test AE: S1-C3 pre-intent evidence round-trip (real PostgreSQL) ----
  //
  // Durable regression of the empirically verified S1-C3 experiment: evidence
  // appended BEFORE any payment intent exists must persist with
  // payment_intent_id = NULL, be retrievable through getEvidence() across a
  // brand-new store instance AND a brand-new connection pool (no reliance on
  // in-memory state), dedupe identical re-appends via ON CONFLICT, preserve
  // distinct records, and leave zero rows behind after cleanup.

  function resultRows(result: any): any[] {
    return Array.isArray(result) ? result : (result?.rows ?? []);
  }

  test("AE: pre-intent append → row persisted with NULL intent FK → retrieval survives new store + new pool", async () => {
    const operationId = `s1c3-ae-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ts = Date.now();

    const record: EvidenceRecord = {
      operationId,
      phase: "DISCOVERY" as any,
      timestamp: ts,
      event: "pre_intent_probe" as any,
      payload: { probe: "s1c3-r1a", sequenceHint: 0 },
      sequence: 0,
    };

    try {
      // 1–2. No Payment Intent may exist for this operation before the append.
      const intentsBefore = resultRows(await db.execute(sql`
        SELECT payment_intent_id FROM payment_intents WHERE operation_id = ${operationId}
      `));
      expect(intentsBefore.length).toBe(0);

      // 3. Actual production PostgresEvidenceStore.append() — must not throw.
      await store.append(record);

      // 4. Verify the persisted reconciliation_observations row directly in SQL.
      const expectedIdentity = PES.evidenceIdentity(record);
      const rows = resultRows(await db.execute(sql`
        SELECT observation_id, payment_intent_id, attempt_id, rpc_provider_id
        FROM reconciliation_observations
        WHERE attempt_id = ${operationId} AND rpc_provider_id = 'evidence-log'
      `));
      expect(rows.length).toBe(1);
      expect(rows[0].payment_intent_id).toBeNull();          // pre-intent safe
      expect(rows[0].attempt_id).toBe(operationId);          // operation binding
      expect(rows[0].rpc_provider_id).toBe("evidence-log");  // provenance tag
      expect(rows[0].observation_id).toBe(expectedIdentity); // stable identity
      expect(expectedIdentity.split("|")).toEqual([
        "evlog", operationId, "s0", "DISCOVERY", "pre_intent_probe", String(ts), expect.any(String),
      ]);

      // 5–6. getEvidence() returns the persisted event, identity preserved.
      const evidence = await store.getEvidence(operationId);
      expect(evidence.length).toBe(1);
      expect(evidence[0].operationId).toBe(operationId);
      expect(evidence[0].event).toBe("pre_intent_probe");
      expect(evidence[0].timestamp).toBe(ts);

      // 7–8. Retrieval through a NEW store instance on a NEW pool — proves the
      // data is durable in PostgreSQL, not in process memory.
      const freshPool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const freshDb = drizzleNodePg(freshPool);
      const freshStore = new PES(freshDb as any);
      try {
        const reread = await freshStore.getEvidence(operationId);
        expect(reread.length).toBe(1);
        expect(reread[0].operationId).toBe(operationId);
        expect(reread[0].event).toBe("pre_intent_probe");
        expect(reread[0].timestamp).toBe(ts);
      } finally {
        await freshPool.end();
      }

      // 9a. Idempotency: re-appending the SAME logical record creates no duplicate.
      await store.append(record);
      const dupRows = resultRows(await db.execute(sql`
        SELECT observation_id FROM reconciliation_observations
        WHERE attempt_id = ${operationId} AND rpc_provider_id = 'evidence-log'
      `));
      expect(dupRows.length).toBe(1);
      const dupEvidence = await store.getEvidence(operationId);
      expect(dupEvidence.length).toBe(1);

      // 9b. A DISTINCT record (different sequence) is preserved alongside it.
      const record2: EvidenceRecord = { ...record, sequence: 1, event: "pre_intent_probe_2" as any };
      await store.append(record2);
      const twoRows = resultRows(await db.execute(sql`
        SELECT observation_id FROM reconciliation_observations
        WHERE attempt_id = ${operationId} AND rpc_provider_id = 'evidence-log'
      `));
      expect(twoRows.length).toBe(2);
      const twoEvidence = await store.getEvidence(operationId);
      expect(twoEvidence.length).toBe(2);
      expect(twoEvidence.map((e) => e.event)).toContain("pre_intent_probe_2");
    } finally {
      // 10. Clean up ONLY rows created by this test, then verify cleanup in SQL.
      await db.execute(sql`
        DELETE FROM reconciliation_observations WHERE attempt_id = ${operationId}
      `);
      const leftover = resultRows(await db.execute(sql`
        SELECT count(*)::int AS remaining FROM reconciliation_observations
        WHERE attempt_id = ${operationId}
      `));
      expect(leftover[0].remaining).toBe(0);
    }
  });
}, 30_000)
