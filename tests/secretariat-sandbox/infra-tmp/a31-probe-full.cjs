const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE t (a text, b bigint not null default 0, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now())`);
const { Client } = db.adapters.createPg();
(async () => {
  const c = new Client(); await c.connect();
  // emulate appendNotNullTimestampDefaults output: cols list WITHOUT ts, values WITHOUT ts, then appended "created_at","updated_at" + now(),now()
  const sqlx = `insert into "t" ("a","b","created_at","updated_at") values ($1,$2,now(),now())`;
  try { await c.query(sqlx, ['x', 5]); console.log('INSERT ok'); } catch(e){ console.log('INSERT ERR:', e.message.split('\n')[0].slice(0,140)); }
  const sel = await c.query(`select "a", "b", "created_at", "updated_at" from "t"`);
  console.log('keys:', Object.keys(sel.rows[0]).join(','));
  console.log('row:', JSON.stringify(sel.rows[0], (k,v)=> v instanceof Date ? 'DATE:'+v.toISOString() : v).slice(0,300));
})();
