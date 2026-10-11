import { memdb } from "./pg-mem-boot.js";
const { drizzle } = await import("drizzle-orm/node-postgres");
const { createRequire } = await import("node:module");
const pgm = createRequire("/workspace/lib/db/dist/index.js")("pg");
const pool = new (pgm.default?.Pool ?? pgm.Pool)({ connectionString: "unused" });
const db = drizzle(pool);
// emulate the exact failing shape: select all cols, where op_id=$1, limit 1 — EMPTY table
const cols = '"payment_intent_id", "operation_id", "request_id", "client_id", "target", "method", "payment_policy", "authorizer", "pay_to", "value", "asset", "network", "nonce", "valid_after", "valid_before", "payment_payload", "payment_payload_hash", "settlement_state", "tx_hash", "facilitator_http_status", "facilitator_response_body", "error_reason", "submit_attempt_at", "settled_at", "not_settled_at", "created_at", "updated_at"';
const r = await pool.query(`select ${cols} from "payment_intents" where "operation_id" = $1 limit 1`, ["op_missing"]);
console.log("EMPTY SELECT -> rows:", JSON.stringify(r.rows), "rowCount:", r.rowCount);
console.log("typeof rows:", typeof r.rows, "isArray:", Array.isArray(r.rows));
process.exit(0);
