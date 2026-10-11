import { memdb, lastQueryDiag } from "../infra/pg-mem-boot.js";
async function main() {
  const { Pool } = await import("pg");
  const pool = new Pool({});
  const c = (await (pool as any).connect())[0]; // sandbox fakeClient -> runQueryAsync pipeline
  const a = memdb.adapters.createPg();
  const ac = new (a.Client as any)(); await ac.connect();
  const ins = `insert into "payment_intents" ("payment_intent_id","operation_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","probe_count","version","created_at","updated_at") values ('pi_f','op_f','0xa','0xb',100,'0xa','net','0x1',0,999,'{}','h','PENDING_SIGNATURE',0,0,'2026-10-11 16:00:00.000+00','2026-10-11 16:00:00.000+00')`;
  await ac.query(ins);
  const q = `select "payment_intent_id", "operation_id", "request_id", "client_id", "target", "method", "payment_policy", "authorizer", "pay_to", "value", "asset", "network", "nonce", "valid_after", "valid_before", "payment_payload", "payment_payload_hash", "settlement_state", "tx_hash", "facilitator_http_status", "facilitator_response_body", "error_reason", "submit_attempt_at", "settled_at", "not_settled_at", "settled_evidence_bundle", "not_settled_evidence_bundle", "reconciliation_observations", "next_probe_at", "probe_count", "version", "created_at", "updated_at" from "payment_intents" where "payment_intents"."operation_id" = 'op_f' limit 1`;
  const sel = await c.query(q);
  console.log("ADAPTER ROW:", JSON.stringify(sel.rows[0], (_k,v)=> v instanceof Date ? "DATE:"+v.toISOString() : v));
}
main().catch(e => console.error("FATAL", String(e).split("\n")[0]));
