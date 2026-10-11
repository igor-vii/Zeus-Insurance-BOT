// Repro of the EXACT live failure: drizzle-shaped SELECT with quoted camelCase aliases
// + pg-mem Client {text,values} path. Print row keys & typeof createdAt.
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE payment_intents (
  payment_intent_id text primary key, operation_id text not null unique, request_id text, client_id text,
  target text, method text, payment_policy jsonb, authorizer text not null, pay_to text not null, value text not null,
  asset text not null, network text not null, nonce text not null, valid_after timestamp with time zone not null,
  valid_before timestamp with time zone not null, payment_payload jsonb not null, payment_payload_hash text not null,
  settlement_state text not null default 'AUTHORIZED', tx_hash text, facilitator_http_status integer,
  facilitator_response_body text, error_reason text, submit_attempt_at timestamp with time zone, settled_at timestamp with time zone,
  not_settled_at timestamp with time zone, settled_evidence_bundle jsonb, not_settled_evidence_bundle jsonb,
  reconciliation_observations jsonb, probe_count integer not null default 0, version integer not null default 0,
  created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now())`);
const ins = `insert into "payment_intents" ("payment_intent_id","operation_id","request_id","client_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","submit_attempt_at","probe_count","version") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;
const sel = `select "payment_intent_id" as "paymentIntentId", "operation_id" as "operationId", "request_id" as "requestId", "client_id" as "clientId", "target", "method", "payment_policy" as "paymentPolicy", "authorizer", "pay_to" as "payTo", "value", "asset", "network", "nonce", "valid_after" as "validAfter", "valid_before" as "validBefore", "payment_payload" as "paymentPayload", "payment_payload_hash" as "paymentPayloadHash", "settlement_state" as "settlementState", "tx_hash" as "txHash", "facilitator_http_status" as "facilitatorHttpStatus", "facilitator_response_body" as "facilitatorResponseBody", "error_reason" as "errorReason", "submit_attempt_at" as "submitAttemptAt", "settled_at" as "settledAt", "not_settled_at" as "notSettledAt", "settled_evidence_bundle" as "settledEvidenceBundle", "not_settled_evidence_bundle" as "notSettledEvidenceBundle", "reconciliation_observations" as "reconciliationObservations", "probe_count" as "probeCount", "version", "created_at" as "createdAt", "updated_at" as "updatedAt" from "payment_intents" where "operation_id"=$1 limit 1`;
const { Pool } = db.adapters.createPg();
(async () => {
  const c = new (require('pg-mem').default ? Object : Object)(); // noop
  const pool = new Pool();
  const conn = await pool.connect();
  try {
    const r1 = await conn.query(ins, ['pi_1','op_1','req_1','cl_1','0xaaa','0xbbb','100','USDC','base','0x1',new Date(),new Date(),{a:1},'hash','AUTHORIZED',null,0,0]);
    console.log('INSERT rowCount=', r1.rowCount ?? '(no rowCount field)');
  } catch (e) { console.error('INSERT ERR:', String(e.message).split('\n')[0]); return; }
  try {
    const r2 = await conn.query(sel, ['op_1']);
    const row = r2.rows[0];
    console.log('SELECT rowCount=', r2.rowCount);
    console.log('row keys:', Object.keys(row));
    console.log('typeof createdAt:', typeof row.createdAt, '| value:', String(row.createdAt));
    console.log('typeof updatedAt:', typeof row.updatedAt);
    console.log('typeof submitAttemptAt:', typeof row.submitAttemptAt);
    console.log('typeof validAfter:', typeof row.validAfter);
  } catch (e) { console.error('SELECT ERR:', String(e.message).split('\n')[0].slice(0,200)); }
})();
