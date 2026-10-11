import "./pg-mem-boot.js";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createRequire } from "node:module";
const require_ = createRequire("/workspace/lib/db/dist/index.js");
const schema = require_("@workspace/db/schema");
(async () => {
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { paymentIntentsTable } = schema;
  await db.insert(paymentIntentsTable).values({
    paymentIntentId: "pi_diag", operationId: "op_diag", requestId: "r", clientId: "c",
    authorizer: "0xa", payTo: "0xb", value: "100", asset: "0xasset", network: "base-sepolia",
    nonce: "0x1", validAfter: 0, validBefore: 9999999999, paymentPayload: "{}", paymentPayloadHash: "h",
    settlementState: "PENDING_SIGNATURE", probeCount: 0, version: 0,
  });
  console.log("[DIAG] insert done");
  const raw = await import("./pg-mem-boot.js") as any;
  try { console.log("[DIAG] dump:", JSON.stringify(raw.dumpTable("payment_intents")).slice(0,400)); } catch(e){ console.log("[DIAG] dump err", String(e).slice(0,100)); }
  const rows = await db.select().from(paymentIntentsTable);
  const r: any = rows[0];
  console.log("[DIAG] row.createdAt:", String(r?.createdAt), "| typeof:", typeof r?.createdAt, "| row.created_at:", String(r?.created_at));
})().catch((e) => console.error("[DIAG] FATAL:", String(e).split("\n")[0]));
