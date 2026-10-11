import { memdb, lastQueryDiag } from "./pg-mem-boot.js";
(async () => {
  const now = Date.now();
  // emulate production createPaymentIntent INSERT (drizzle shape: no ts columns) through the REAL adapter path:
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  // use raw table names via sql to avoid @workspace/db resolution here:
  const { sql } = await import("drizzle-orm");
  await db.execute(sql.raw(`insert into "payment_intents" ("payment_intent_id","operation_id","request_id","client_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state") values ('pi_raw','op_raw','r','c','0xa','0xb',100,'0xasset','base-sepolia','0x1',0,99999999,'{}','h','PENDING_SIGNATURE')`));
  console.log("[RAW] insert exec ok | adapter saw:", lastQueryDiag.text.slice(0, 240));
  const engineRows = (memdb.public.query(`select * from "payment_intents"`) as any).rows;
  const row = engineRows?.[0];
  console.log("[RAW] engine keys count:", Object.keys(row ?? {}).length);
  for (const k of ["created_at", "updated_at"]) {
    const v = row?.[k];
    console.log(`[RAW] ${k} | typeof:`, typeof v, "| isDate:", v instanceof Date, "| value:", String(v).slice(0, 50));
  }
})().catch((e) => console.error("[RAW] FATAL:", String(e).split("\n")[0]));
