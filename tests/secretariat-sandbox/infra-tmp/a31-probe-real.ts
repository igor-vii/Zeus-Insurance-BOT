import { memdb } from "../infra/pg-mem-boot.js";
async function main() {
  const adapter = (globalThis as any).__unused;
  // emulate exactly what runQueryAsync does for drizzle's insert + select, using the same client path
  const { lastQueryDiag } = await import("../infra/pg-mem-boot.js");
  // Use the patched Pool like production does:
  const { Pool } = await import("pg");
  const pool = new Pool({});
  const c = (await (pool as any).connect())[0];
  const insCols = ["payment_intent_id","operation_id","request_id","client_id","target","method","payment_policy","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","tx_hash","facilitator_http_status","facilitator_response_body","error_reason","submit_attempt_at","settled_at","not_settled_at","settled_evidence_bundle","not_settled_evidence_bundle","reconciliation_observations","next_probe_at","probe_count","version"];
  const vals = ["pi_z","op_z",null,null,null,null,null,"0xa","0xb","100000","0xasset","base-sepolia","0x1",0,9999999999,"{}","0xh","PENDING_SIGNATURE",null,null,null,null,null,null,null,null,null,null,0,0];
  let sqlText = `insert into "payment_intents" (${insCols.map(x=>`"${x}"`).join(",")}) values (${vals.map((_v,i)=>`$${i+1}`).join(",")})`;
  console.log("pre-insert table cols check...");
  // raw engine state BEFORE (to see if row exists after our own insert)
  const r1 = await c.query(sqlText, vals);
  console.log("INSERT rows:", r1.rowCount);
  const sel = await c.query(`select "created_at","updated_at" from "payment_intents" where "operation_id"=$1`, ["op_z"]);
  console.log("SELECT keys:", Object.keys(sel.rows[0] ?? {}).join(","));
  console.log("SELECT row:", JSON.stringify(sel.rows[0], (_k,v)=> typeof v === "object" && v !== null ? v : v));
  // engine ground truth:
  const g = memdb.public.query(`select created_at, updated_at from payment_intents where operation_id='op_z'`) as any;
  console.log("ENGINE:", JSON.stringify(g.cache ?? null));
}
main().catch(e => console.error("FATAL", e));
