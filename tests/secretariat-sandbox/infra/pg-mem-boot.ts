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
// TEST-ONLY FIX (v4, sandbox adapter only): v2 passed drizzle's config object into
// pg-mem schema-level query() ("Not supported: {...}" crash on recoverAfterCrash IN-list);
// v3 used db.public.prepare(text, types) which ALSO fails because pg-mem@3.0.14's
// prepareQuery->collectParams receives the VALUES array in the `types` slot when called
// as prepare(text, valuesArray) from our wrapper — verified in isolation:
//   - THE ONLY reliable parameterized path is the pg Client adapter:
//       new adapter.Client(); await c.connect(); await c.query(text, valuesArray)
//     which internally runs replaceQueryArgs$(sql, values) -> toLiteral() substitution
//     and returns {rows, rowCount} (verified: IN ($1,$2) with ['x','y'] -> 2 rows).
//   - rowMode:"array" from drizzle is ignored (drizzle consumes .rows objects on this
//     path); recorded as sandbox deviation F-DB3.
let sandboxClient: { connect(): Promise<unknown>; query(t: string, v?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number }> } | null = null;
async function getClient(): Promise<NonNullable<typeof sandboxClient>> {
  if (!sandboxClient) {
    const c = new (adapter.Client as new () => NonNullable<typeof sandboxClient>)();
    await c.connect();
    sandboxClient = c;
  }
  return sandboxClient;
}

// pg-mem's MemPg.adaptQuery throws "getTypeParser is not supported" when drizzle's
// node-postgres session passes a config object containing `types` ({types:{}}).
// Verified in isolation: Client.query(text, valuesArray) works. So we normalize the
// first argument here (sandbox adapter code only): strip unsupported keys (`types`,
// `rowMode`) from the config object and keep its text/values. Recorded as F-DB3.
function normalizeQueryArg(textOrCfg: unknown): { text: string; values: unknown[] | null } {
  if (typeof textOrCfg === "string") return { text: textOrCfg, values: null };
  const cfg = textOrCfg as { text?: string; values?: unknown[]; types?: unknown; rowMode?: unknown };
  return { text: String(cfg.text ?? ""), values: Array.isArray(cfg.values) ? cfg.values : null };
}

// TEST-ONLY FIX (v5): drizzle's node-postgres session passes a full pg QueryConfig
// object ({text, values, rowMode:"array", types:{}, name?}) as the FIRST argument to
// client.query(). The previous code treated any non-string first arg as an options
// object and passed `undefined` text -> pg-mem threw "getTypeParser is not supported".
// Normalize both call shapes here (sandbox adapter only).
function normalizeFirstArg(first: unknown): { text: string; values: unknown[] | null } {
  if (typeof first === "string") return { text: first, values: null };
  if (first && typeof first === "object") {
    const cfg = first as { text?: string; query?: string; values?: unknown[] };
    const text = String(cfg.text ?? cfg.query ?? "");
    return { text, values: Array.isArray(cfg.values) ? cfg.values : null };
  }
  return { text: "", values: null };
}

// TEST-ONLY FIX (v6, sandbox adapter only): pg-mem's replaceQueryArgs$ -> toLiteral()
// cannot parse a raw JS Date substituted into INSERT VALUES ($1) — verified in isolation:
// both `new Date(...)` and its ISO string fail with "query failed to parse". Real PG accepts
// the ISO form natively. We convert Date params to the PG-canonical
// "YYYY-MM-DD HH:MM:SS.SSS+00" form (verified round-trip: SELECT returns a JS Date).
const PG_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?.*$/;
function dateToPgTimestamp(d: Date): string {
  const iso = new Date(d.getTime() + d.getTimezoneOffset() * 60000).toISOString();
  const m = PG_TS_RE.exec(iso);
  if (!m) return iso.slice(0, 19) + "+00";
  const ms = (m[3] ?? "").padEnd(3, "0");
  return `${m[1]} ${m[2]}.${ms}+00`;
}
function sanitizeParam(v: unknown): unknown {
  if (v instanceof Date) return dateToPgTimestamp(v);
  if (typeof v === "bigint") return v.toString();
  return v;
}

async function runQueryAsync(first: unknown, params?: unknown): Promise<{ rows: unknown[]; rowCount: number }> {
  const norm = normalizeFirstArg(first);
  const values = Array.isArray(params) && params.length > 0 ? params : norm.values ?? [];
  const sanitized = (values as unknown[]).map(sanitizeParam);
  const c = await getClient();
  const res = await c.query(norm.text, sanitized as unknown[]);
  // TEST-ONLY row hydration (sandbox adapter only): lib/db's production row mappers
  // call .getTime() on timestamp columns (postgres-store.js rowToIntent etc.).
  // Depending on pg-mem's internal path, SELECT may hand back epoch numbers or ISO
  // strings instead of JS Dates. Revive them here so production code is untouched.
  const rows = Array.isArray(res.rows) ? res.rows.map(hydrateRowDates) : [];
  return { rows, rowCount: typeof res.rowCount === "number" ? res.rowCount : 0 };
}

const TS_LIKE_KEYS = /(at|_at)$/i;
function hydrateRowDates(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v == null || v instanceof Date) continue;
    if ((typeof v === "number" && v > 1e11 && v < 4e12) || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) {
      if (TS_LIKE_KEYS.test(k) || /timestamp/i.test(k)) {
        const d = new Date(typeof v === "number" ? v : v.replace(" ", "T"));
        if (!Number.isNaN(d.getTime())) out[k] = d;
      }
    }
  }
  return out;
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
      query: async (first: unknown, paramsOrCb?: unknown, cb?: unknown) => {
        // support (text, values), (QueryConfig), and callback signatures
        const params = Array.isArray(paramsOrCb) ? (paramsOrCb as unknown[]) : [];
        const out = await runQueryAsync(first, params);
        if (typeof cb === "function") { (cb as Function)(null, out); return undefined; }
        if (typeof paramsOrCb === "function") { (paramsOrCb as Function)(null, out); return undefined; }
        return out;
      },
      release: () => {},
      on: () => {}, off: () => {}, once: () => {}, end: async () => {},
    };
    return [fakeClient, fakeClient.release];
  };
  // Also support pool.query(text, params[, cb]) / pool.query(QueryConfig[, cb]) style.
  (p as Record<string, unknown>).query = async (first: unknown, paramsOrCb?: unknown, cb?: unknown) => {
    await ensure();
    const params = Array.isArray(paramsOrCb) ? (paramsOrCb as unknown[]) : [];
    const out = await runQueryAsync(first, params);
    if (typeof cb === "function") { (cb as Function)(null, out); return undefined; }
    if (typeof paramsOrCb === "function") { (paramsOrCb as Function)(null, out); return undefined; }
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
