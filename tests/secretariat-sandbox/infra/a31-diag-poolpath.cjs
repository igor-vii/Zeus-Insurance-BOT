// Does pg-mem's Pool path (used by makeSandboxPool) return Date or string for timestamps?
const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE t (id text primary key, created_at timestamp with time zone not null default now())`);
const { Pool } = db.adapters.createPg();
(async () => {
  const p = new Pool();
  const [client] = await p.connect();
  const d = new Date();
  const ins = await client.query(`insert into "t" ("id","created_at") values ($1,now())`, ['x']);
  console.log('INSERT rowCount:', ins.rowCount);
  const sel = await client.query(`select * from "t" where "id"=$1`, ['x']);
  const v = sel.rows[0].created_at;
  console.log('POOL PATH | typeof created_at:', typeof v, '| isDate:', v instanceof Date, '| value:', String(v).slice(0,60));
  // also test param-bound date
  const ins2 = await client.query(`insert into "t" ("id","created_at") values ($1,$2)`, ['y', d]);
  const sel2 = await client.query(`select * from "t" where "id"=$1`, ['y']);
  const v2 = sel2.rows[0].created_at;
  console.log('param-bound | typeof:', typeof v2, '| isDate:', v2 instanceof Date, '| value:', String(v2).slice(0,60));
})();
