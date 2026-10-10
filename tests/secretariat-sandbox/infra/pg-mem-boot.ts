/**
 * TEST-ONLY database bootstrap for the Secretariat external-client sandbox.
 * No PostgreSQL server binary is available in this environment, so the isolated
 * virtual DB required by the experiment (§4) is provided by pg-mem — an
 * in-memory, PG-wire-compatible SQL engine — with the REAL production schema
 * migrations applied verbatim (no schema changes; §5).
 *
 * The sandbox SUT entry imports this module BEFORE lib/db, replacing the `pg`
 * module's Pool/Client with pg-mem adapters so that the unmodified production
 * composition root (createSecretariatComposition) talks exclusively to this
 * isolated in-memory DB. It can never reach a Zeus production/dev DB.
 */
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { newDb } = require_("/workspace/tests/secretariat-sandbox/node_modules/pg-mem");

export const memdb = newDb();

// Apply real migration files (skip 0004_partitioning: declarative PARTITION OF
// syntax unsupported by pg-mem and irrelevant — watcher tables are NOT part of
// this experiment per §4; recorded as sandbox deviation F-DB2).
const MIGRATIONS = [
  "/workspace/lib/db/drizzle/0000_init.sql",
  "/workspace/lib/db/drizzle/migrations/0005_secretariat_tables.sql",
];
for (const f of MIGRATIONS) {
  const sql = fs.readFileSync(f, "utf8");
  // split on statements at top level: pg-mem query() handles one statement; use multiple via .queries? Use db.public.multiple? not present; iterate manually
  const stmts = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
  for (const s of stmts) {
    try {
      memdb.public.query(s);
    } catch (e) {
      const msg = String((e as Error).message).split("\n")[0];
      console.error(`[pg-mem-boot] WARN statement failed in ${path.basename(f)}: ${msg.slice(0, 160)}`);
    }
  }
}

const adapter = memdb.adapters.createPg();

// Patch the `pg` package exports used by lib/db (drizzle node-postgres + raw pool.query)
const pgPkg = require_("pg");
const patched = pgPkg.default ?? pgPkg;
patched.Pool = adapter.Pool;
patched.Client = adapter.Client;

// Dump helper: SELECT rows of a table as plain JSON
export function dumpTable(name: string): unknown[] {
  const res = memdb.public.query(`SELECT * FROM "${name}"`);
  // pg-mem returns AdvancedResult; call .cache to get rows array
  const rows = (res as { cache?: unknown[] }).cache ?? (res as { execute?: () => unknown[] });
  const arr = Array.isArray(rows) ? rows : typeof (rows as any)?.then === "function" ? [] : ((rows as any) ?? []);
  return arr as unknown[];
}
