import { lastQueryDiag, memdb } from "./pg-mem-boot";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { paymentIntentsTable as t } from "/workspace/lib/db/dist/schema/index.js";
const dz = drizzle(new Pool());
(async () => {
  await dz.insert(t).values({
    paymentIntentId: "pi_repro", operationId: "op_repro", authorizer: "0xaaa", payTo: "0xbbb",
    value: "100", asset: "USDC", network: "base", nonce: "0x1", validAfter: new Date(),
    validBefore: new Date(), paymentPayload: { a: 1 }, paymentPayloadHash: "h",
    settlementState: "AUTHORIZED", probeCount: 0, version: 0,
  });
  // intercept raw pg-mem result for the exact SELECT text drizzle sends:
  const selText = `select "payment_intent_id", "operation_id", "created_at", "updated_at" from "payment_intents" where "payment_intents"."operation_id" = $1 limit 1`;
  const raw = memdb.public.query(selText.replace("$1", `'op_repro'`));
  console.log("RAW snake:", JSON.stringify((raw as any).cache?.slice(0,1) ?? raw).slice(0,200));
  const rawCamel = memdb.public.query(`select "payment_intent_id" as "paymentIntentId", "created_at" as "createdAt" from "payment_intents" where "operation_id"='op_repro' limit 1`);
  console.log("RAW camel-aliased:", JSON.stringify((rawCamel as any).cache?.slice(0,1) ?? rawCamel).slice(0,200));
  const rows = await dz.select().from(t).where(eq(t.operationId, "op_repro")).limit(1);
  console.log("DRIZZLE row sample:", JSON.stringify(rows[0]).slice(0,200));
})().catch(e=>{console.error("ERR", String(e.message).split("\n")[0]); process.exit(1);});
