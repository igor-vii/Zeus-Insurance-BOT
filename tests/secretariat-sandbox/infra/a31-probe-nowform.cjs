// A3.1 §1: establish the ACTUAL form of now()-substituted params and stored values in sandbox adapter
const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE t (id text primary key, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now())`);
const { Client } = db.adapters.createPg();
(async () => {
  const c = new Client(); await c.connect();
  // emulate appendNotNullTimestampDefaults output: now() literal + appended Date param
  try {
    const r = await c.query(
      `insert into "t" ("id","created_at","updated_at") values ($1,now(),$2)`,
      ['x1', new Date()]
    );
    console.log('INSERT ok rowCount', r.rowCount);
  } catch (e) { console.log('INSERT ERR:', String(e.message).split('\n')[0].slice(0,140)); return; }
  const sel = await c.query(`select * from "t" where "id"=$1`, ['x1']);
  const row = sel.rows[0];
  for (const k of ['created_at','updated_at']) {
    const v = row[k];
    console.log(k, '| typeof:', typeof v, '| isDate:', v instanceof Date, '| value:', String(v).slice(0,60));
  }
})();
