import "./pg-mem-boot.js";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
(async () => {
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { PostgresEvidenceStore } = await import("/workspace/lib/db/dist/secretariat/postgres-store.js");
  const store = new PostgresEvidenceStore(db as never);
  const now = Date.now();
  const intent = {
    paymentIntentId: "pi_c", operationId: "op_c", requestId: "r", clientId: "c",
    authorizer: "0xa", payTo: "0xb", value: "100000", asset: "0xasset", network: "base-sepolia",
    nonce: "0x1", validAfter: 0, validBefore: Math.floor(now/1000)+3600,
    paymentPayload: "{}", paymentPayloadHash: "0xh", settlementState: "PENDING_SIGNATURE",
    probeCount: 0, createdAt: now, updatedAt: now,
  };
  await store.createPaymentIntent(intent as never);
  console.log("[CRASH] insert ok");
  // intercept the SELECT that rowToIntent consumes: replicate exactly what getPaymentIntentByOperationId does
  const { sql } = await import("drizzle-orm");
  const rows = await db.execute(sql.raw(`select * from "payment_intents" where "operation_id"='op_c' limit 1`));
  console.log("[CRASH] raw select rows:", JSON.stringify(rows).slice(0, 300));
  try { await store.getPaymentIntentByOperationId("op_c"); console.log("[CRASH] readback OK"); }
  catch (e) { console.log("[CRASH] readback ERR:", String(e).split("\n")[0]); }
})().catch((e) => console.error("[CRASH] FATAL:", String(e).split("\n")[0]));
