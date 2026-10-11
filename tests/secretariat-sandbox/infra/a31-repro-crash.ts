// A3.1 regression test 2+3 (pre-fix repro): drive the UNMODIFIED production mapper
// path (PostgresEvidenceStore.rowToIntent via getPaymentIntentByOperationId) through
// the sandbox adapter exactly as the live SUT does, using drizzle node-postgres.
import "/workspace/tests/secretariat-sandbox/infra/pg-mem-boot.js"; // installs patched pg Pool
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { PostgresEvidenceStore } = await import("/workspace/lib/db/dist/secretariat/postgres-store.js");
  const store = new PostgresEvidenceStore(db as never);
  const now = Date.now();
  const intent = {
    paymentIntentId: "pi_a31_1", operationId: "op_a31_1", requestId: "req_a31_1", clientId: "cl_a31",
    authorizer: "0xaaaa", payTo: "0xbbbb", value: "100000", asset: "0x036CbD53842c942c0a9d39f23520231D3dF71be4",
    network: "base-sepolia", nonce: "0x1", validAfter: 0, validBefore: Math.floor(now/1000)+3600,
    paymentPayload: "{}", paymentPayloadHash: "0xh", settlementState: "PENDING_SIGNATURE" as const,
    probeCount: 0, createdAt: now, updatedAt: now,
  };
  await store.createPaymentIntent(intent as never);
  console.log("[A31] INSERT ok");
  // Test 1: save + re-read with correct timestamps
  const back = await store.getPaymentIntentByOperationId("op_a31_1");
  if (!back) throw new Error("A31-T1 FAIL: intent not found");
  if (typeof back.createdAt !== "number" || Number.isNaN(back.createdAt)) throw new Error("A31-T1 FAIL: createdAt not a valid epoch ms -> got " + String(back.createdAt));
  if (typeof back.updatedAt !== "number" || Number.isNaN(back.updatedAt)) throw new Error("A31-T1 FAIL: updatedAt not a valid epoch ms -> got " + String(back.updatedAt));
  console.log("[A31] T1 PASS: round-trip timestamps:", back.createdAt, back.updatedAt);
  // Test 3: missing mandatory timestamp must produce DIAGNOSABLE error (not fabricated now(), not TypeError)
  await store.appendReconciliationObservation({ attemptId:"at1", paymentIntentId:"pi_a31_1", timestamp: now, rpcProviderId:"mockA", headBlock:1, authorizationState:null, validBefore:0, result:"OBSERVED" } as never);
  const { paymentIntentsTable } = await import("@workspace/db/schema");
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`UPDATE payment_intents SET created_at = NULL WHERE payment_intent_id = ${"pi_a31_1"}`);
  let err: Error | null = null;
  try { await store.getPaymentIntentByOperationId("op_a31_1"); } catch (e) { err = e as Error; }
  if (!err) throw new Error("A31-T3 FAIL: expected diagnosable integrity error for NULL created_at, got silent success");
  const msg = err.message;
  const diagnosable = /DATA_INTEGRITY|missing required timestamp/i.test(msg);
  console.log("[A31] T3 readback error:", msg.split("\n")[0].slice(0,120), "| diagnosable:", diagnosable);
  if (!diagnosable) { console.error("[A31] T3 RESULT: CRASH-NOT-DIAGNOSABLE (this is the pre-fix defect)"); process.exitCode = 41; return; }
  console.log("[A31] T3 PASS");
}
main().catch((e) => { console.error("[A31] UNEXPECTED:", String(e).split("\n")[0]); process.exit(1); });
