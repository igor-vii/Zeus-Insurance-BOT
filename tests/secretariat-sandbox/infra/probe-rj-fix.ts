import { memdb } from "./pg-mem-boot.js";
const { Pool } = await import("/workspace/lib/db/node_modules/pg/lib/index.js");
const pool = new Pool();
// emulate drizzle's INSERT into reconciliation_jobs exactly as production builds it
const nextProbe = new Date(Date.now() + 1500);
const r = await pool.query(
  `insert into "reconciliation_jobs" ("job_id","payment_intent_id","status","probe_count","next_probe_at","created_at","updated_at") values ($1,$2,$3,$4,$5,now(),now())`,
  ["rj-test-1", "pi-test-1", "PENDING", 0, nextProbe]
);
console.log("insert rowCount:", r.rowCount);
const sel = await pool.query(`select "created_at","updated_at","locked_by","next_probe_at" from "reconciliation_jobs" where "job_id"=$1`, ["rj-test-1"]);
console.log("sel rows:", JSON.stringify(sel.rows));
process.exit(0);
