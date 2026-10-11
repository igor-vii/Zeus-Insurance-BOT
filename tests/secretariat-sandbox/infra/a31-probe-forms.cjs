// A3.1 §1: establish ACTUAL createdAt/updatedAt forms at the adapter boundary, pre-fix.
const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE t (id text primary key, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now())`);
const { Client } = db.adapters.createPg();
(async () => {
  const c = new Client(); await c.connect();
  // INSERT without defaults columns (drizzle shape), Date params sanitized to PG string like sandbox does
  const r1 = await c.query(`insert into "t" ("id") values ($1)`, ['x1']);
  console.log('INSERT rowCount:', r1.rowCount);
  const q = async (label, text, args) => {
    try {
      const res = args ? await c.query(text, args) : await c.query(text);
      const row = res.rows[0];
      const v = row.created_at;
      console.log(label, '| keys:', JSON.stringify(Object.keys(row)),
        '| typeof created_at:', typeof v,
        '| isDate:', v instanceof Date,
        '| value:', String(v).slice(0,60));
    } catch (e) { console.log(label, 'ERR', String(e.message).split('\n')[0].slice(0,100)); }
  };
  await q('plain-text SELECT *      ', `select * from "t" where "id"='x1'`);
  await q('param SELECT *           ', `select * from "t" where "id"=$1`, ['x1']);
  await q('param quoted-cols snake  ', `select "created_at","updated_at" from "t" where "id"=$1`, ['x1']);
  await q('param aliased camel      ', `select "created_at" as "createdAt","updated_at" as "updatedAt" from "t" where "id"=$1`, ['x1']);
})();
