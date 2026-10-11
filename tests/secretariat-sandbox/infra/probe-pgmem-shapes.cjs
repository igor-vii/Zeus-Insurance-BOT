const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
(async () => {
  const db = newDb();
  await db.public.none(`create table t (id text primary key, val int, created_at timestamp not null default now())`);
  const adapter = db.adapters.createPg();
  const c = new adapter.Client(); await c.connect();
  // plain insert first to be safe
  await c.query(`insert into t (id, val) values ('a', 1)`);
  let r = await c.query(`select "t"."id" as "id", "t"."val" as "val", "t"."created_at" as "createdAt" from "t" where "t"."id" = 'a'`);
  console.log('ALIASED rows:', JSON.stringify(r.rows));
  r = await c.query(`select * from "t"`);
  console.log('STAR rows:', JSON.stringify(r.rows));
})().catch(e => console.error('ERR', e.message.split('\n')[0]));
