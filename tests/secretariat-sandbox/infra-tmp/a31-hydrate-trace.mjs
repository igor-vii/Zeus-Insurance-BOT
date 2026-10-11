import { memdb } from "./pg-mem-boot.compiled.mjs";
async function main() {
  const a = memdb.adapters.createPg();
  const ac = new (a.Client)(); await ac.connect();
  await ac.query(`insert into "payment_intents" ("payment_intent_id","operation_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","probe_count","version","created_at","updated_at") values ('pi_t','op_t','0xa','0xb',100,'0xa','net','0x1',0,999,'{}','h','PENDING_SIGNATURE',0,0,'2026-10-11 16:00:00.000+00','2026-10-11 16:00:00.000+00')`);
  // now run through the COMPILED adapter pipeline (patched Pool):
  const { Pool } = await import("pg");
  const pool = new Pool({});
  const c = (await pool.connect())[0];
  const sel = await c.query(`select "payment_intent_id", "operation_id", "target", "created_at", "updated_at" from "payment_intents" where "payment_intents"."operation_id" = 'op_t' limit 1`);
  console.log("PIPELINE ROW:", JSON.stringify(sel.rows[0], (_k,v)=> v instanceof Date ? "DATE:"+v.toISOString() : v));
}
main().catch(e => console.error("FATAL", e));
