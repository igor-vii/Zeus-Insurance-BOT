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
// TEST-ONLY FIX (sandbox adapter only): strip leading comment lines per statement.
// The previous filter `!s.startsWith("--")` dropped entire CREATE TABLE statements whose
// first line was a "-- ..." header comment — which is why payment_intents et al. were
// never created in the virtual DB. Statements are now cleaned then applied verbatim.
const MIGRATIONS = [
  "/workspace/lib/db/drizzle/0000_init.sql",
  "/workspace/lib/db/drizzle/migrations/0005_secretariat_tables.sql",
  "/workspace/lib/db/drizzle/migrations/0008_c1_operation_semantics.sql",
];
for (const f of MIGRATIONS) {
  const sql = fs.readFileSync(f, "utf8");
  const stmts = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
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

// TEST-ONLY FIX: drizzle's node-postgres session calls pool.connect() and then
// client.query(text, params). The stock pg-mem Pool has no connect(), and its
// connected Client does not forward params — both are wrapped here (sandbox
// adapter code only — no production file touched). Verified in isolation:
// pg-mem query(text,{params,rowMode:"array",types:{}}) returns {rows,rowCount}
// for parameterized SQL including IN ($1,$2,...) lists (drizzle passes
// rowMode:"array" + types:{} which the raw pg-mem adapter rejects).
function runQuery(text: string, params?: unknown[], rowMode?: string): { rows: unknown[]; rowCount: number } {
  const r = memdb.public.query(text, {
    params: params ?? [],
    ...(rowMode === "array" ? { rowMode: "array", types: {} } : {}),
  });
  if (r && typeof r.then === "function") {
    throw new Error("pg-mem returned a promise where a sync result was expected: " + text.slice(0, 80));
  }
  const res = r as { rows?: unknown[]; rowCount?: number };
  return { rows: Array.isArray(res.rows) ? res.rows : [], rowCount: typeof res.rowCount === "number" ? res.rowCount : 0 };
}

function makeSandboxPool(opts?: unknown) {
  const p = new (adapter.Pool as new (o?: unknown) => Record<string, never>)(opts);
  let started = false;
  const ensure = async () => {
    if (!started) { await memdb.public.startReplication?.(); started = true; }
  };
  (p as Record<string, unknown>).connect = async () => {
    await ensure();
    const fakeClient = {
      query: async (text: string, paramsOrCb?: unknown, cb?: unknown) => {
        // support (text, values) and (text, values, callback) signatures
        const params = Array.isArray(paramsOrCb) ? (paramsOrCb as unknown[]) : [];
        const out = runQuery(text, params);
        if (typeof cb === "function") { (cb as Function)(null, out); return undefined; }
        return out;
      },
      release: () => {},
      on: () => {}, off: () => {}, once: () => {}, end: async () => {},
    };
    return [fakeClient, fakeClient.release];
  };
  // Also support pool.query(text, params[, cb]) style (some call sites use it directly).
  (p as Record<string, unknown>).query = async (text: string, paramsOrCb?: unknown, cb?: unknown) => {
    await ensure();
    const params = Array.isArray(paramsOrCb) ? (paramsOrCb as unknown[]) : [];
    const out = runQuery(text, params);
    if (typeof cb === "function") { (cb as Function)(null, out); return undefined; }
    return out;
  };
  return p;
}

// Patch the `pg` package exports used by lib/db (drizzle node-postgres + raw pool.query).
// CRITICAL: resolve `pg` with a require anchored at /workspace/lib/db/dist/index.js so we
// mutate the SAME module instance that lib/db's ESM wrapper re-exports (verified identical
// object in sandbox probe). Mutating the sandbox-local copy would be invisible to the SUT.
const pgReq = createRequire("/workspace/lib/db/dist/index.js");
const pgPkg = pgReq("pg");
const patched = pgPkg.default ?? pgPkg;
patched.Pool = makeSandboxPool;
patched.Client = adapter.Client;
// Belt & braces: also patch every other physical `pg` copy on disk, then force-load
// each esm wrapper so its live namespace bindings alias the patched CJS exports.
const pgCopies = ["/workspace/lib/db/node_modules/pg", "/workspace/api-server/node_modules/pg", "/workspace/tests/secretariat-sandbox/node_modules/pg", "/workspace/zeus-secretariat/node_modules/pg"];
for (const dir of pgCopies) {
  try {
    const cjsPath = dir + "/lib/index.js";
    if (!fs.existsSync(cjsPath)) continue;
    const mod = require_(cjsPath);
    mod.Pool = makeSandboxPool;
    mod.Client = adapter.Client;
    import(dir + "/esm/index.mjs").catch(() => {}); // bind live ESM namespace to patched exports
  } catch { /* copy absent — fine */ }
}

// Dump helper: SELECT rows of a table as plain JSON
export function dumpTable(name: string): unknown[] {
  const res = memdb.public.query(`SELECT * FROM "${name}"`);
  // pg-mem returns AdvancedResult; call .cache to get rows array
  const rows = (res as { cache?: unknown[] }).cache ?? (res as { execute?: () => unknown[] });
  const arr = Array.isArray(rows) ? rows : typeof (rows as any)?.then === "function" ? [] : ((rows as any) ?? []);
  return arr as unknown[];
}
