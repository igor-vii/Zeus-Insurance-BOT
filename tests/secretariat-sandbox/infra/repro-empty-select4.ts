import { memdb } from "./pg-mem-boot.js";
const { createRequire } = await import("node:module");
const pgm = createRequire("/workspace/lib/db/dist/index.js")("pg");
const P = pgm.default?.Pool ?? pgm.Pool;
const pool = new P({ connectionString: "unused" });
// drizzle execute() shape: rowMode array + types
const r: any = await (pool.query as any)({ text: 'select "payment_intent_id", "operation_id", "created_at", "updated_at" from "payment_intents" where "operation_id" = $1 limit 1', values: ["op_missing"], rowMode: "array", types: {} });
console.log("DRIZZLE-SHAPE EMPTY -> rows:", JSON.stringify(r.rows), "rowCount:", r.rowCount);
const { drizzle } = createRequire("/workspace/lib/db/dist/index.js")("drizzle-orm/node-postgres");
const db = drizzle(pool as any);
const { paymentIntents } = createRequire("/workspace/lib/db/dist/schema/index.js")("@workspace/db/schema");
