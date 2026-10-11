const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE t (a text, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now())`);
const { Client } = db.adapters.createPg();
(async () => {
  const c = new Client(); await c.connect();
  await c.query(`insert into "t" ("a","created_at","updated_at") values ($1,now(),$2)`, ['x', new Date()]);
  const sel = await c.query(`select "a", "created_at", "updated_at" from "t"`);
  console.log('keys:', Object.keys(sel.rows[0]).join(','));
  for (const k of Object.keys(sel.rows[0])) console.log(k, '=', JSON.stringify(String(sel.rows[0][k])).slice(0,60), '| isDate:', sel.rows[0][k] instanceof Date);
})();
