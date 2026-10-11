// Reproduce the EXACT live INSERT shape from [SBX-DIAG] and inspect stored values.
const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE payment_intents (
  payment_intent_id text primary key, operation_id text not null unique, request_id text, client_id text,
  target jsonb, method jsonb, payment_policy jsonb,
  authorizer text not null, pay_to text not null, value bigint not null, asset text not null, network text not null,
  nonce text not null, valid_after bigint not null, valid_before bigint not null,
  payment_payload text not null, payment_payload_hash text not null, settlement_state text not null default 'PENDING_SIGNATURE',
  tx_hash text, facilitator_http_status int, facilitator_response_body jsonb, error_reason text,
  submit_attempt_at timestamp with time zone, settled_at timestamp with time zone, not_settled_at timestamp with time zone,
  settled_evidence_bundle jsonb, not_settled_evidence_bundle jsonb, reconciliation_observations jsonb,
  next_probe_at timestamp with time zone, probe_count int not null default 0, version int not null default 0,
  created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now())`);
const { Client } = db.adapters.createPg();
(async () => {
  const c = new Client(); await c.connect();
  const d = new Date();
  // drizzle-shape insert WITHOUT ts cols, then adapter-appended now() literals:
  const sql1 = `insert into "payment_intents" ("payment_intent_id","operation_id","request_id","client_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,"created_at","updated_at") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
  // NOTE: appendNotNullTimestampDefaults output actually looks like this:
  const fixed = `insert into "payment_intents" ("payment_intent_id","operation_id","request_id","client_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","created_at","updated_at") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16)`;
  const vals = ['pi1','op1','req1','cl1','0xaaaa','0xbbbb',100000,'0xasset','base-sepolia','0x1',0,1791740450,'{}','0xh','PENDING_SIGNATURE', d];
  try { await c.query(fixed, vals); console.log('INSERT ok'); } catch (e) { console.log('INSERT ERR:', String(e.message).split('\n')[0].slice(0,140)); return; }
  const sel = await c.query(`select * from "payment_intents" where "payment_intent_id"=$1`, ['pi1']);
  const row = sel.rows[0];
  for (const k of ['created_at','updated_at']) {
    const v = row[k];
    console.log(k, '| typeof:', typeof v, '| isDate:', v instanceof Date, '| value:', JSON.stringify(v)?.toString().slice(0,60));
  }
})();
