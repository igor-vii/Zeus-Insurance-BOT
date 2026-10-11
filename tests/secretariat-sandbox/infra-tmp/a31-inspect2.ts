import { memdb, lastQueryDiag } from "../infra/pg-mem-boot.js";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
async function main() {
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { PostgresEvidenceStore } = await import("/workspace/lib/db/dist/secretariat/postgres-store.js");
  const store = new PostgresEvidenceStore(db as never);
  const now = Date.now();
  const intent = {
    paymentIntentId: "pi_y", operationId: "op_y", requestId: "r", clientId: "c",
    authorizer: "0xa", payTo: "0xb", value: "100000", asset: "0xasset", network: "base-sepolia",
    nonce: "0x1", validAfter: 0, validBefore: Math.floor(now/1000)+3600,
    paymentPayload: "{}", paymentPayloadHash: "0xh", settlementState: "PENDING_SIGNATURE",
    probeCount: 0, createdAt: now, updatedAt: now,
  };
  await store.createPaymentIntent(intent as never);
  console.log("INSERT done");
  // ground truth in engine storage (raw, no adapter):
  const raw = (memdb.public.query(`select created_at, updated_at from "payment_intents" where operation_id='op_y'`) as any);
  console.log("ENGINE RAW:", JSON.stringify(raw.cache ?? raw.execute?.()));
  globalThis.__sbxDiagDone = false;
  try {
    const back = await store.getPaymentIntentByOperationId("op_y");
    console.log("readback OK", back?.createdAt, back?.updatedAt);
  } catch (e) {
    console.log("readback ERR:", String(e).split("\n")[0]);
    console.log("FULL SQL:", lastQueryDiag.text);
  }
}
main().catch(e => { console.error("FATAL", String(e).split("\n")[0]); process.exit(1); });
