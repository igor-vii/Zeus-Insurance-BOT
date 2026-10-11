import "./pg-mem-boot.js";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
(async () => {
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { PostgresEvidenceStore } = await import("/workspace/lib/db/dist/secretariat/postgres-store.js");
  const store = new PostgresEvidenceStore(db as never);
  const now = Date.now();
  await store.createPaymentIntent({
    paymentIntentId: "pi_k", operationId: "op_k", requestId: "r", clientId: "c",
    authorizer: "0xa", payTo: "0xb", value: "100000", asset: "0xasset", network: "base-sepolia",
    nonce: "0x1", validAfter: 0, validBefore: Math.floor(now/1000)+3600,
    paymentPayload: "{}", paymentPayloadHash: "0xh", settlementState: "PENDING_SIGNATURE",
    probeCount: 0, createdAt: now, updatedAt: now,
  } as never);
  console.log("[KEYS] insert ok");
  // monkeypatch: capture the rows array that rowToIntent will receive by intercepting via a re-select through dist schema? Simpler: replicate select shape with raw sql and print keys after adapter.
  const { sql } = await import("drizzle-orm");
  const res = await db.execute(sql.raw(`select * from "payment_intents" where "operation_id"='op_k' limit 1`));
  const rows = (res as any).rows ?? res;
  const r = Array.isArray(rows) ? rows[0] : (rows as any)?.[0];
  console.log("[KEYS] adapter-out keys:", Object.keys(r ?? {}).join(","));
  console.log("[KEYS] createdAt:", String(r?.createdAt), "| created_at:", String(r?.created_at));
})().catch((e) => console.error("[KEYS] FATAL:", String(e).split("\n")[0]));
