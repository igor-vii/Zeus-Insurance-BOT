// TEST-ONLY probe: replicate pg-mem-boot migration application to find why tables are missing.
const { newDb } = require("/workspace/tests/secretariat-sandbox/node_modules/pg-mem");
const fs = require("fs");
const db = newDb();
const files = [
  "/workspace/lib/db/drizzle/0000_init.sql",
  "/workspace/lib/db/drizzle/migrations/0005_secretariat_tables.sql",
  "/workspace/lib/db/drizzle/migrations/0008_c1_operation_semantics.sql",
];
for (const f of files) {
  const sql = fs.readFileSync(f, "utf8");
  const stmts = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.split(/\r?\n/).filter((l) => l.trim().substring(0, 2) !== "--").join("\n").trim())
    .filter((s) => s.length > 0);
  let ok = 0, fail = 0;
  for (const s of stmts) {
    try { db.public.query(s); ok++; }
    catch (e) { fail++; if (fail <= 6) console.log("FAIL:", String(e.message).split("\n")[0].slice(0, 120), "||STMT:", s.slice(0, 70).replace(/\n/g, " ")); }
  }
  console.log(`${f.split("/").pop()}: ok=${ok} fail=${fail}`);
}
for (const t of ["payment_intents","nonce_registry","execution_attempts","reconciliation_observations","reconciliation_jobs","recovery_jobs"]) {
  try { db.public.query(`SELECT * FROM "${t}" LIMIT 1`); console.log("TABLE OK:", t); }
  catch { console.log("TABLE MISSING:", t); }
}
