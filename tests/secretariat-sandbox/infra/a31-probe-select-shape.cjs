// A3.1 §1: what shape does the REAL production drizzle select() produce on raw pg-mem adapter?
const { newDb } = require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const { drizzle } = require('drizzle-orm/node-postgres');
const { pgTable, text, timestamp } = require('drizzle-orm/pg-core');
const t = pgTable('probe_t', { id: text('id').primaryKey(), createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow() });
(async () => {
  const db0 = newDb();
  db0.public.none(`CREATE TABLE probe_t (id text primary key, created_at timestamp with time zone not null default now())`);
  const { Pool } = db0.adapters.createPg();
  const pool = new Pool();
  const d = drizzle(pool, { schema: { probe_t: t } });
  await d.insert(t).values({ id: 'a1' });
  const rows = await d.select().from(t).where(require('drizzle-orm').eq(t.id,'a1'));
  console.log('drizzle select row keys:', JSON.stringify(Object.keys(rows[0]||{})));
  console.log('row.createdAt:', (rows[0]||{}).createdAt, '| typeof:', typeof (rows[0]||{}).createdAt, '| isDate:', (rows[0]||{}).createdAt instanceof Date);
})().catch(e=>console.error('ERR', e.message.split('\n')[0]));
