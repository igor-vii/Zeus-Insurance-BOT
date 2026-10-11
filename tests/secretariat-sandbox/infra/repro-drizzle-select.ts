import "/workspace/tests/secretariat-sandbox/infra/pg-mem-boot"; // installs patched pg Pool backed by virtual DB w/ real migrations
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { paymentIntentsTable } from "/workspace/lib/db/dist/schema/index.js";

const pool = new Pool();
const dz = drizzle(pool);
(async () => {
  await dz.insert(paymentIntentsTable).values({
    paymentIntentId: "pi_repro", operationId: "op_repro", requestId: null, clientId: null,
    authorizer: "0xaaa", payTo: "0xbbb", value: "100", asset: "USDC", network: "base", nonce: "0x1",
    validAfter: new Date(), validBefore: new Date(), paymentPayload: { a: 1 }, paymentPayloadHash: "h",
    settlementState: "AUTHORIZED", submitAttemptAt: null, probeCount: 0, version: 0,
  });
  const rows = await dz.select().from(paymentIntentsTable).where(eq(paymentIntentsTable.operationId, "op_repro")).limit(1);
  const r = rows[0] as Record<string, unknown>;
  console.log("keys:", Object.keys(r).join(","));
  console.log("typeof createdAt:", typeof r.createdAt, "isDate:", r.createdAt instanceof Date);
  console.log("typeof updatedAt:", typeof r.updatedAt, "isDate:", r.updatedAt instanceof Date);
  console.log("typeof paymentIntentId:", typeof r.paymentIntentId, "value:", String(r.paymentIntentId));
  console.log("typeof settlementState:", typeof r.settlementState, "value:", String(r.settlementState));
})().catch((e) => { console.error("ERR", String(e.message).split("\n")[0]); process.exit(1); });
