const fs=require('fs'); const {newDb}=require('/workspace/tests/secretariat-sandbox/node_modules/pg-mem');
const db=newDb();
for (const f of ['/workspace/lib/db/drizzle/migrations/0005_secretariat_tables.sql','/workspace/lib/db/drizzle/migrations/0008_c1_operation_semantics.sql']) {
  const sql=fs.readFileSync(f,'utf8');
  for (const s of sql.split(/;\s*(?:\r?\n|$)/).map(x=>x.split(/\r?\n/).filter(l=>!l.trim().startsWith('--')).join('\n').trim()).filter(Boolean)) {
    try { db.public.query(s); } catch(e){ console.log('WARN:', String(e.message).split('\n')[0].slice(0,200), '||', s.slice(0,70).replace(/\n/g,' ')); }
  }
}
const r = db.public.query("select table_name from information_schema.tables where table_schema='public'");
console.log('tables:', (r.rows||[]).map(x=>Object.values(x)[0]).join(','));
