import { memdb } from "./pg-mem-boot.js";
const { createRequire } = await import("node:module");
const pgm = createRequire("/workspace/lib/db/dist/index.js")("pg");
const P = pgm.default?.Pool ?? pgm.Pool;
console.log("Pool is sandbox fn:", P.name, String(P).slice(0, 60));
const pool = new P({ connectionString: "unused" });
const cols = '"payment_intent_id", "operation_id", "created_at", "updated_at"';
const r = await pool.query(`select ${cols} from "payment_intents" where "operation_id" = $1 limit 1`, ["op_missing"]);
console.log("EMPTY SELECT -> rows:", JSON.stringify(r.rows), "rowCount:", r.rowCount, "isArray:", Array.isArray(r.rows));
await pool.query('insert into "payment_intents" ("payment_intent_id","operation_id","request_id","client_id","target","method","payment_policy","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","settlement_state") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
 ["pi1","op1","rq1","c1","t","m",'{}',"auth","pay","1","asset","net","1",new Date(),new Date(),"PENDING_SIGNATURE"]);
const r2 = await pool.query(`select ${cols} from "payment_intents" where "operation_id" = $1 limit 1`, ["op1"]);
console.log("NONEMPTY -> ", JSON.stringify(r2.rows?.[0]));
process.exit(0);
