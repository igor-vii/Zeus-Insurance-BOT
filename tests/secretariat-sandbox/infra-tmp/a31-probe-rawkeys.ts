import { memdb } from "../infra/pg-mem-boot.js";
async function main() {
  const { Pool } = await import("pg");
  const pool = new Pool({});
  const c = (await (pool as any).connect())[0];
  // capture RAW pg-mem rows for the exact drizzle column-list select by calling the engine client directly:
  const adapterClient = new (memdb.adapters.createPg().Client as any)();
  await adapterClient.connect();
  const nowIso = "2026-10-11 16:00:00.000+00";
  await adapterClient.query(`insert into "payment_intents" ("payment_intent_id","operation_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","probe_count","version","created_at","updated_at") values ('pi_w','op_w','0xa','0xb',100,'0xa','net','0x1',0,999,'{}','h','PENDING_SIGNATURE',0,0,'${nowIso}','${nowIso}')`);
  const sel = await adapterClient.query(`select "payment_intent_id", "operation_id", "created_at", "updated_at" from "payment_intents" where "operation_id"='op_w' limit 1`);
  console.log("RAW KEYS:", Object.keys(sel.rows[0]).join(","));
  console.log("RAW created_at:", JSON.stringify(sel.rows[0].created_at), "| isDate:", sel.rows[0].created_at instanceof Date);
}
main().catch(e => console.error("FATAL", String(e).split("\n")[0]));
