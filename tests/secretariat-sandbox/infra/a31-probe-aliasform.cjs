const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE t (id text primary key, created_at timestamp with time zone not null default now())`);
const { Client } = db.adapters.createPg();
(async () => {
  const c = new Client(); await c.connect();
  await c.query(`insert into "t" ("id") values ($1)`, ['x']); // relies on DEFAULT now()
  const sel = await c.query(`select "created_at" as "createdAt" from "t" where "id"=$1`, ['x']);
  const row = sel.rows[0];
  console.log('keys:', Object.keys(row).join(','));
  for (const k of Object.keys(row)) {
    const v = row[k];
    console.log(k, '| typeof:', typeof v, '| isDate:', v instanceof Date, '| value:', String(v).slice(0,50));
  }
})();
