const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db = newDb();
db.public.query(`create table t (id text primary key, val int, created_at timestamp not null default now())`);
const adapter = db.adapters.createPg();
// emulate OUR pool: connect() resolves to [client, release] with runQueryAsync-like wrapper
adapter.Pool.prototype.connect = async function () {
  const c = new adapter.Client(); await c.connect();
  const fakeClient = {
    query: async (first, paramsOrCb) => {
      const cfg = typeof first === 'string' ? { text: first, values: Array.isArray(paramsOrCb) ? paramsOrCb : undefined } : { ...first };
      delete cfg.types; delete cfg.rowMode;
      if (!global.__selLogged && /^\s*select/i.test(cfg.text)) { global.__selLogged = true; console.log('SQL:', cfg.text.slice(0,250)); }
      const r = await c.query(cfg.text, cfg.values);
      if (/^\s*select/i.test(cfg.text) && !global.__rowsLogged) { global.__rowsLogged = true; console.log('ROWS:', JSON.stringify(r.rows)); }
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
    },
    release(){}, on(){}, off(){}, once(){}, end: async()=>{},
  };
  return [fakeClient, fakeClient.release];
};
const { drizzle } = require('drizzle-orm/node-postgres');
const { pgTable, text, integer, timestamp } = require('drizzle-orm/pg-core');
const t = pgTable('t', { id: text('id').primaryKey(), val: integer('val'), createdAt: timestamp('created_at') });
(async () => {
  const pool = new adapter.Pool();
  const dz = drizzle(pool);
  await dz.insert(t).values({ id: 'x', val: 1 });
  const rows = await dz.select().from(t).where(require('drizzle-orm').eq(t.id, 'x'));
  console.log('DRIZZLE row:', JSON.stringify(rows[0]));
})().catch(e => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
