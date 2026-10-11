import { memdb } from "./pg-mem-boot.js";
async function main() {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  console.log("[DIAG] Pool ctor name:", (Pool as any).name); // BoundPool => patched sandbox pool active
  const pool = new Pool({ connectionString: "sandbox" });
  const db = drizzle(pool as never);
  const { sql } = await import("drizzle-orm");
  const { paymentIntentsTable } = await import("/workspace/lib/db/dist/schema/index.js");
  await db.execute(sql`insert into payment_intents ("payment_intent_id","operation_id","request_id","client_id","authorizer","pay_to","value","asset","network","nonce","valid_after","valid_before","payment_payload","payment_payload_hash","settlement_state","probe_count","version") values ('pi_diag','op_diag','r','c','0xa','0xb','100','usdc','base-sepolia','1',0,1,'{}','h','AUTHORIZED',0,0)`);
  const raw: any = await db.execute(sql`select * from payment_intents where operation_id='op_diag'`);
  const row = (Array.isArray(raw) ? raw : raw.rows)[0];
  console.log("[DIAG] raw keys:", JSON.stringify(Object.keys(row)));
  console.log("[DIAG] raw created_at:", String(row.created_at), "| typeof:", typeof row.created_at, "| isDate:", row.created_at instanceof Date);
  const dz = await db.select().from(paymentIntentsTable);
  const d0: any = dz[0];
  console.log("[DIAG] drizzle keys sample:", JSON.stringify(Object.keys(d0 ?? {})).slice(0, 300));
  console.log("[DIAG] drizzle createdAt:", String(d0?.createdAt), "| typeof:", typeof d0?.createdAt, "| isDate:", d0?.createdAt instanceof Date);
}
main().catch(e => { console.error("[DIAG] ERR", String(e).split("\n")[0]); process.exit(1); });
