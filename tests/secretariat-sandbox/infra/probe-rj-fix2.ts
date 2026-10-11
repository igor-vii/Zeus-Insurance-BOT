import { memdb } from "./pg-mem-boot.js";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url); // sandbox-local pg (patched belt&braces)
const pgPkg = memdb.adapters.createPg();
const Pool = pgPkg.default?.Pool ?? pgPkg.Pool;
const pool = new Pool();
const nextProbe = new Date(Date.now() + 1500);
// Case A: drizzle-style INSERT WITHOUT created_at/updated_at (shim must append them)
await pool.query(
  `insert into "reconciliation_jobs" ("job_id","payment_intent_id","status","probe_count","next_probe_at") values ($1,$2,$3,$4,$5)`,
  ["rj-A", "pi-A", "PENDING", 0, nextProbe]
);
const a = await pool.query(`select "created_at","updated_at","locked_by","next_probe_at" from "reconciliation_jobs" where "job_id"=$1`, ["rj-A"]);
console.log("A rows:", JSON.stringify(a.rows));
// Case B: execution_attempts without created_at
await pool.query(
  `insert into "execution_attempts" ("attempt_id","operation_id","execution_id","attempt_number","status") values ($1,$2,$3,$4,$5)`,
  ["ea-B", "op-B", "ex-B", 1, "STARTED"]
);
const b = await pool.query(`select "created_at","updated_at" from "execution_attempts" where "attempt_id"=$1`, ["ea-B"]);
console.log("B rows:", JSON.stringify(b.rows));
process.exit(0);
