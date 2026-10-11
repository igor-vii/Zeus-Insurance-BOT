import "/workspace/tests/secretariat-sandbox/infra/pg-mem-boot.js";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
async function main() {
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { PostgresEvidenceStore } = await import("/workspace/lib/db/dist/secretariat/postgres-store.js");
  const store = new PostgresEvidenceStore(db as never);
  const now = Date.now();
  const intent = {
    paymentIntentId: "pi_x", operationId: "op_x", requestId: "r", clientId: "c",
    authorizer: "0xa", payTo: "0xb", value: "100000", asset: "0xasset", network: "base-sepolia",
    nonce: "0x1", validAfter: 0, validBefore: Math.floor(now/1000)+3600,
    paymentPayload: "{}", paymentPayloadHash: "0xh", settlementState: "PENDING_SIGNATURE",
    probeCount: 0, createdAt: now, updatedAt: now,
  };
  await store.createPaymentIntent(intent as never);
  globalThis.__sbxDiagDone = false;
  try { await store.getPaymentIntentByOperationId("op_x"); console.log("readback OK"); }
  catch (e) { console.log("readback ERR:", String(e).split("\n")[0]); }
  // dump the FULL raw row from pg-mem directly
  const c = await pool.connect();
  const r = await (c as any).query(`select * from "payment_intents" where "operation_id"='op_x' limit 1`);
  console.log("FULL ROW:", JSON.stringify(r.rows[0]));
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
