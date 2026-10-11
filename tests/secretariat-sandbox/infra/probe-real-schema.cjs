const fs=require('fs'); const {newDb}=require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
(async()=>{
const db=newDb();
for (const f of ['/workspace/lib/db/drizzle/migrations/0005_secretariat_tables.sql','/workspace/lib/db/drizzle/migrations/0008_c1_operation_semantics.sql']) {
  const sql=fs.readFileSync(f,'utf8');
  for (const s of sql.split(/;\s*(?:\r?\n|$)/).map(x=>x.split(/\r?\n/).filter(l=>!l.trim().startsWith('--')).join('\n').trim()).filter(Boolean)) {
    try { await db.public.none(s); } catch(e){ console.log('MIGWARN:', String(e.message).split('\n')[0].slice(0,140),'||',s.slice(0,60).replace(/\n/g,' ')); }
  }
}
const adapter=db.adapters.createPg();
const c=new adapter.Client(); await c.connect();
let r;
try { r = await c.query(`insert into "payment_intents" ("payment_intent_id","operation_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","probe_count","version") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  ['pi1','op1','0xaa','0xbb','100','USDC','base','0x1','1760000000','1760006000','{"e":1}','hash','AUTHORIZED',0,0]);
  console.log('INSERT ok rowCount:', r.rowCount); } catch(e){ console.error('INSERT ERR:', String(e.message).split('\n')[0].slice(0,300)); }
r = await c.query(`select "payment_intents"."payment_intent_id" as "paymentIntentId", "payment_intents"."settlement_state" as "settlementState", "payment_intents"."created_at" as "createdAt" from "payment_intents" limit 1`);
console.log('SELECT rows:', JSON.stringify(r.rows));
})().catch(e=>console.error('FATAL', e.message.split('\n')[0]));
