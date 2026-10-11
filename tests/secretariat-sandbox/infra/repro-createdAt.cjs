// Repro: exact drizzle-shaped INSERT (explicit cols, NO created_at/updated_at) + SELECT
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
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const c = await0();
async function await0(){ return pool.connect(); }
let conn;
pool.connect().then(cc=>{ conn=cc; run(cc); });
function run(c){
c.query(ins, ['pi_1','op_1','req_1','cl_1','0xaaa','0xbbb','100','USDC','base','0x1',new Date(),new Date(),{a:1},'hash','AUTHORIZED',null,0,0], (e1,r1)=>{
  if (e1) { console.error('INSERT ERR', String(e1.message).split('\n')[0]); process.exit(1); }
  console.log('INSERT rowCount=', r1.rowCount);
  c.query(`select "created_at","updated_at","submit_attempt_at","settled_at" from "payment_intents" where "operation_id"=$1`, ['op_1'], (e2,r2)=>{
    if (e2) { console.error('SELECT ERR', String(e2.message).split('\n')[0]); process.exit(1); }
    const row=r2.rows[0];
    console.log('SELECT keys:', Object.keys(row));
    console.log('typeof created_at:', typeof row.created_at, 'value:', String(row.created_at), 'isDate:', row.created_at instanceof Date);
    console.log('typeof updated_at:', typeof row.updated_at);
    console.log('hasOwnProperty created_at:', 'created_at' in row, '| value undefined?', row.created_at === undefined);
  });
});
// also test the QueryConfig ({text,values}) form through the same connection:
setTimeout(()=>{ try {
  const c2 = db.public.createConnection();
  c2.query({ text: `select * from "payment_intents" where "operation_id"=$1`, values: ['op_1'] }, (e3,r3)=>{
    console.log('CFG-FORM err:', e3 ? String(e3.message).split('\n')[0].slice(0,80) : null, r3 ? 'rowCount='+r3.rowCount : '');
  });
} catch(e){ console.log('CFG-FORM throw:', String(e.message).split('\n')[0].slice(0,120)); } }, 50);
}
