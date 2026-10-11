import { memdb, lastQueryDiag } from "./pg-mem-boot.js";
// emulate drizzle's select on empty payment_intents through the sandbox pool path
const require_ = (await import("node:module")).createRequire("/workspace/lib/db/dist/index.js");
const pg = require_("pg");
const pool = new pg.Pool({ connectionString: "x" });
const r = await pool.query('select "payment_intent_id", "created_at" from "payment_intents" where "operation_id" = $1 limit 1', ["nope"]);
console.log("RESULT:", JSON.stringify(r));
// also non-empty check: insert then select
await pool.query('insert into "payment_intents" ("payment_intent_id","operation_id","request_id","client_id","target","method","payment_policy","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","settlement_state") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
 ["pi1","op1","rq1","c1","t","m",'{}',"auth","pay","1","asset","net","1",new Date(),new Date(),"PENDING_SIGNATURE"]);
const r2 = await pool.query('select "payment_intent_id", "created_at", "updated_at" from "payment_intents" where "operation_id" = $1 limit 1', ["op1"]);
console.log("RESULT2:", JSON.stringify(r2.rows?.[0]));
process.exit(0);
