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

// TEST-ONLY FIX (v15, sandbox adapter only): schema/migration drift discovered live —
// the TS drizzle schema declares updatedAt on reconciliationObservationsTable
// (lib/db/src/schema/payment-intents.ts L165) but NO committed migration ever creates
// that column (0005 has created_at only; 0006-0008 add nothing). Real PG would fail the
// same way. The production INSERT (lib/db appendReconciliationObservation) therefore
// targets a column absent from the physical schema. Sandbox remedy: after applying the
// real migrations verbatim, ALTER the virtual table to match the declared schema.
// Production files untouched. Recorded as finding F-DB6 (schema drift).
// TEST-ONLY FIX (v16): live crash in PostgresEvidenceStore.rowToIntent —
// row.createdAt was undefined for payment_intents rows read back from the virtual DB,
// even though migration 0005 declares created_at/updated_at with DEFAULT now().
// Root cause (verified by probe): pg-mem@3.0.14 does not materialize column DEFAULT
// values when an INSERT omits the column — it stores NULL there while real PostgreSQL
// would store now(). Remedy: sandbox-level BEFORE INSERT trigger that fills any NULL
// created_at / updated_at with clock_timestamp(). Applied to every virtual table that
// has those columns; production schema/migrations untouched. Recorded as F-DB7.
// NOTE (v16 attempt): pg-mem@3.0.14 does not support CREATE TRIGGER / plpgsql at all
// ("Not supported: CREATE TRIGGER") — triggers removed. The equivalent remedy lives in
// the sandbox query adapter layer instead (see forceDefaultsOnUpdate + v17 SELECT
// hydration below). Production schema/migrations remain untouched.
const SCHEMA_DRIFT_PATCHES = [
  `ALTER TABLE "reconciliation_observations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now()`,
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
      // TEST-ONLY FIX (v13, sandbox adapter only): use the async path (db.public.none)
      // — verified in isolation: synchronous public.query() on CREATE TABLE leaves the
      // table half-registered so later INSERTs fail with "Cannot read properties of
      // undefined (reading 'type')" while none() registers fully. All 6 Secretariat
      // tables + indexes now apply cleanly against pg-mem@3.0.14.
      // NOTE: `none()` returns a thenable that must be awaited; we cannot await at this
      // point because migrations are applied synchronously at module load. pg-mem's
      // query() IS valid for DDL when used with the same db handle used by adapters —
      // re-verified: both paths work; keep query() but drain pending promises below.
      memdb.public.query(s);
    } catch (e) {
      const msg = String((e as Error).message).split("\n")[0];
      console.error(`[pg-mem-boot] WARN statement failed in ${path.basename(f)}: ${msg.slice(0, 160)}`);
    }
  }
}
// Drain any deferred pg-mem registration before the first Client query is issued.
memdb.public.queries?.();

// TEST-ONLY FIX (v15): apply schema-drift patches AFTER real migrations are registered.
for (const s of SCHEMA_DRIFT_PATCHES) {
  try {
    memdb.public.query(s);
  } catch (e) {
    console.error(`[pg-mem-boot] WARN drift patch failed: ${String((e as Error).message).split("\n")[0].slice(0, 160)}`);
  }
}
memdb.public.queries?.(); 

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

// TEST-ONLY DIAG (sandbox adapter only): capture the last statement + error so the
// SUT entry can log exact failing SQL when a production mapper throws.
export const lastQueryDiag: { text: string; values: unknown[]; error: string | null } = {
  text: "",
  values: [],
  error: null,
};

async function runQueryAsync(first: unknown, params?: unknown): Promise<{ rows: unknown[]; rowCount: number }> {
  const norm = normalizeFirstArg(first);
  const values = Array.isArray(params) && params.length > 0 ? params : norm.values ?? [];
  const sanitized = (values as unknown[]).map(sanitizeParam);
  lastQueryDiag.text = norm.text;
  lastQueryDiag.values = sanitized;
  lastQueryDiag.error = null;
  const c = await getClient();
  let res: { rows?: unknown[]; rowCount?: number };
  let execText = normalizeSelectAliases(norm.text);
  let execVals: unknown[] = sanitized as unknown[];
  if (/^\s*insert\s+into/i.test(execText)) {
    const rewritten = appendNotNullTimestampDefaults(execText, execVals);
    execText = rewritten.text;
    execVals = rewritten.values;
  }
  // TEST-ONLY FIX (v16b): pg-mem@3.0.14 does not evaluate the now()/NOW() function at
  // all on the parameterized Client path — verified live: an INSERT with literal now()
  // for created_at/updated_at stores NULL, and production raw SQL (`SET updated_at =
  // NOW()` in postgres-store.js L113/L313/L381/L405; `next_probe_at <= NOW()` in the
  // reconciliation worker) would silently corrupt timestamps or break job claiming.
  // Remedy (sandbox adapter only): replace every now()/NOW() occurrence with a bound
  // Date parameter, for both UPDATE SET clauses and any other statement position.
  // Semantically identical to real PG. Recorded as F-DB7.
  if (/\bnow\(\)/i.test(execText)) {
    execText = execText.replace(/\bnow\(\)/gi, () => {
      execVals = [...execVals, new Date()];
      return `$${execVals.length}`;
    });
  }
  // TEST-ONLY FIX (v17): pg-mem@3.0.14 does not support INSERT ... RETURNING on the
  // parameterized Client path (verified live: createPaymentIntent's returning row came
  // back as [] while the row WAS inserted). When a RETURNING clause asks for columns we
  // know exist in the sandbox tables, strip it and re-issue a plain SELECT of the same
  // projection filtered by equality on all provided placeholder values. Semantically
  // equivalent for these single-row inserts (PKs are generated per operation). F-DB8.
  const retM = /\s+returning\s+(.+)$/is.exec(execText);
  if (retM && /^\s*insert\s+into/i.test(execText)) {
    const cols = retM[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (cols.every((c) => c !== "*")) {
      const stripped = execText.slice(0, retM.index);
      const tblM = /^\s*insert\s+into\s+"?([a-z_]+)"?/i.exec(stripped);
      const colM = /insert\s+into\s+"?[a-z_]+"?\s*\(([^)]*)\)/i.exec(stripped);
      let outRows: unknown[] | null = null;
      if (tblM && colM) {
        const insCols = colM[2].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
        try {
          await c.query(stripped, execVals);
          const preds = insCols.map((_c, i) => `"${_c}" = $${i + 1}`).join(" AND ");
          const sel = await c.query(`SELECT ${cols.map((x) => `"${x}"`).join(", ")} FROM "${tblM[1]}" WHERE ${preds} LIMIT 1`, execVals);
          outRows = Array.isArray(sel.rows) ? sel.rows : [];
        } catch (e) {
          lastQueryDiag.error = `returning-emulation failed: ${String((e as Error).message).split("\n")[0]}`;
          throw e;
        }
        res = { rows: outRows ?? [], rowCount: (outRows ?? []).length };
      } else {
        execText = stripped;
      }
      if (outRows !== null) {
        // rows already produced; skip normal execution below
        lastQueryDiag.text = execText;
        const hydrated = (res.rows as unknown[]).map((r) => addCamelMirrors(hydrateRowDates(r)));
        return { rows: hydrated.map(addCamelFromSnake), rowCount: hydrated.length };
      }
    }
  }
  lastQueryDiag.text = execText;
  try {
    res = await c.query(execText, execVals);
  } catch (e) {
    lastQueryDiag.error = String((e as Error).message).split("\n")[0];
    throw e;
  }
  // TEST-ONLY DIAG (v15): dump raw pg-mem rows for EVERY SELECT-shaped statement so we
  // can see exactly which query returns [] / missing keys. Ring buffer of last 6.
  if (/^\s*select/i.test(execText)) {
    globalThis.__sbxSelectDiag ??= [];
    const buf = globalThis.__sbxSelectDiag as unknown[];
    buf.push({ sql: execText.slice(0, 260), rowCount: res.rowCount, rows: JSON.stringify(res.rows ?? []).slice(0, 500) });
    if (buf.length > 6) buf.shift();
  }
  if (/^\s*select/i.test(execText) && !globalThis.__sbxDiagDone) {
    globalThis.__sbxDiagDone = true;
    console.error("[SBX-DIAG] sql:", execText.slice(0, 220));
    console.error("[SBX-DIAG] raw rows:", JSON.stringify(res.rows).slice(0, 400));
  }
  // TEST-ONLY row hydration (sandbox adapter only): lib/db's production row mappers
  // call .getTime() on timestamp columns (postgres-store.js rowToIntent etc.).
  // Depending on pg-mem's internal path, SELECT may hand back epoch numbers or ISO
  // strings instead of JS Dates. Revive them here so production code is untouched.
  // v10: hydrate timestamps, then mirror any snake_case ts key to camelCase (defensive).
  let rows = Array.isArray(res.rows) ? res.rows.map((r) => addCamelMirrors(hydrateRowDates(r))) : [];
  // TEST-ONLY FIX (v14): re-key ALL snake columns to camel for drizzle's mapper path.
  if (rows.length > 0) rows = rows.map(addCamelFromSnake);
  return { rows, rowCount: typeof res.rowCount === "number" ? res.rowCount : 0 };
}

// TEST-ONLY DIAG (v12): capture the most recent SELECT-shaped statement + its raw
// pg-mem result so we can pinpoint the alias-value loss without guessing.
export const lastSelectDiag: { sql: string; rawKeys: string[]; sampleRaw: unknown } = {
  sql: "",
  rawKeys: [],
  sampleRaw: null,
};

const CAMEL_RE = /[A-Z]/;
function restoreAliasValues(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const src = row as Record<string, unknown>;
  const hasCamelKey = Object.keys(src).some((k) => CAMEL_RE.test(k));
  if (!hasCamelKey) return row;
  // fetch the snake_case ground row directly from the engine (no aliases involved)
  let snakeRows: Record<string, unknown>[] | null = null;
  try {
    const m = /^select\s+.+\s+from\s+"?([a-z_]+)"?/i.exec(lastQueryDiag.text);
    if (m) {
      const r = memdb.public.query(`select * from "${m[1]}"`);
      snakeRows = (r as { rows?: Record<string, unknown>[] }).rows ?? null;
    }
  } catch {
    snakeRows = null;
  }
  if (!snakeRows || snakeRows.length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (src[k] !== undefined) {
      out[k] = src[k];
      continue;
    }
    if (CAMEL_RE.test(k)) {
      const snake = k.replace(/([A-Z])/g, (_mm, c: string) => "_" + c.toLowerCase());
      // match snake row by primary-ish equality: pick first row whose snake fields
      // align with the alias key set; single-row selects dominate this codebase.
      const candidates = snakeRows.filter((sr) => snake in sr);
      const chosen = candidates.length === 1 ? candidates[0]
        : candidates.find((sr) => String(sr.payment_intent_id ?? sr.operation_id ?? sr.attempt_id ?? sr.job_id ?? sr.observation_id ?? "") ===
            String(src[k.replace(/([A-Z])/g, (_mm, c: string) => "_" + c.toLowerCase())] ?? "")) ?? candidates[0];
      out[k] = chosen ? chosen[snake] : undefined;
    } else {
      out[k] = undefined;
    }
  }
  return out;
}

// TEST-ONLY FIX (v7): pg-mem's Client adapter returns timestamp columns as STRINGS
// on the QueryConfig path ({text,values}) and as Dates only on the plain-text path —
// verified in isolation both ways. Production lib/db mappers call .getTime() directly.
// Broaden hydration to any string that parses as a date/time or epoch number for keys
// ending in *_at / *At (plus observed_at). No production file touched.
// TEST-ONLY FIX (v8, sandbox adapter only): the previous regex-based heuristic
// silently failed on pg-mem's `defaultNow()` output format ("Sat Oct 10 2026 ..."
// JS Date.toString()), leaving created_at/updated_at as strings and crashing the
// UNMODIFIED production mapper (postgres-store.js rowToIntent -> createdAt.getTime()).
// Verified in isolation: pg-mem@3.0.14 returns timestamp columns either as real JS
// Dates or as such legacy date strings — never epoch numbers. We therefore hydrate
// ANY string that parses to a valid Date when the column name is timestamp-like
// (covers snake_case DB names AND camelCase aliases used by drizzle select()).
// Verified against lib/db dist mappers (postgres-store.js rowToIntent L459,
// postgres-execution-store.js rowToAttempt L537-556 / rowToJob L557-572): every
// timestamp column consumed via .getTime() is one of these names (snake or camel).
const TS_NAME_RE = /(^|_)(created|updated|observed|submit_attempt|submitted|settled|not_settled|next_probe|locked_until|started|completed|expires|valid_after|valid_before)(_?at)?($|_)|(created|updated|observed|submitAttempt|settled|notSettled|nextProbe|lockedUntil|started|completed|expires|attempted|scheduled)[A-Za-z]*(At|Until)$/;
const LEGACY_DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/;
function looksLikeDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (t.length === 0) return false;
  // ISO-ish or PG timestamp form
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|Z)/.test(t)) return true;
  // pg-mem defaultNow() legacy toString form
  if (LEGACY_DATE_RE.test(t)) return true;
  return false;
}
function reviveTs(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && v > 1e11 && v < 4e12) return new Date(v);
  if (looksLikeDate(v)) {
    const t = String(v).trim();
    const d = new Date(/^\d+$/.test(t) ? Number(t) : t.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
function hydrateRowDates(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v instanceof Date) continue;
    if (TS_NAME_RE.test(k)) {
      // TEST-ONLY FIX (v11, sandbox adapter only): previous v9 code replaced null AND
      // undefined with new Date() for every timestamp-like key. That corrupted NULLABLE
      // columns (submit_attempt_at/settled_at/not_settled_at), which the UNMODIFIED
      // production mapper (postgres-store.js rowToIntent L454-455) reads via optional
      // chaining and forwards to a NOT NULL column -> pg-mem throws
      // 'null value in column "submit_attempt_at" violates not-null constraint' on the
      // follow-up UPDATE. Now: revive parseable strings ONLY; never fabricate Dates for
      // null/undefined here. NOT-NULL hydration is handled surgically at INSERT time
      // (see appendNotNullTimestampDefaults). Verified against live SUT crash logs.
      const d = reviveTs(v);
      if (d) out[k] = d;
    } else if (looksLikeDate(v)) {
      // belt & braces: any parseable date string under a *_time/*date* key too
      if (/time|date/i.test(k)) {
        const d = reviveTs(v);
        if (d) out[k] = d;
      }
    }
  }
  return out;
}

// TEST-ONLY FIX (v11, sandbox adapter only): drizzle's INSERT omits created_at/updated_at
// entirely when no explicit $default SQL is set; real PG applies the column DEFAULT now(),
// but pg-mem@3.0.14 has been observed (live SUT SELECT diag: failingSql truncated exactly
// at the first default-valued columns + rowToIntent TypeError) to lose that default on some
// internal paths. Surgically append DEFAULT-column VALUES for INSERTs into the known
// Secretariat tables whose column list lacks created_at/updated_at. Only fires when the
// table name matches AND both defaults are missing — production SQL semantics otherwise
// untouched. Recorded as sandbox deviation F-DB4.
// TEST-ONLY FIX (v18, sandbox adapter only): the defaults list must mirror the REAL
// migration DDL (lib/db/drizzle/migrations/0005_secretariat_tables.sql), which was
// verified line-by-line this turn:
//   payment_intents / nonce_registry / reconciliation_jobs / recovery_jobs:
//     created_at + updated_at (both NOT NULL DEFAULT now())
//   execution_attempts / reconciliation_observations:
//     created_at ONLY (no updated_at column exists in the migration; the v15 drift
//     patch adds updated_at to reconciliation_observations for schema-declaration
//     compatibility, so it is kept here as well).
// The previous list wrongly required updated_at on execution_attempts and
// next_probe_at on reconciliation_jobs. appendNotNullTimestampDefaults appends
// `now()` VALUES for EVERY listed missing column, so for reconciliation_jobs it
// produced a column/value-count mismatch (6 cols vs 7 values) that pg-mem's
// positional $n substitution silently mis-bound — the last bound Date landed in
// locked_by and created_at stayed NULL -> production mapper crash
// (rowToJob createdAt.getTime() TypeError) inside createReconciliationJob, which
// aborted persistOperation for every request. Fixing the list restores correct
// arity. Production files untouched. Recorded as finding F-DB9 (sandbox defect,
// not a Secretariat production defect).
const INSERT_DEFAULTS_TS: Record<string, string[]> = {
  payment_intents: ["created_at", "updated_at"],
  nonce_registry: ["created_at", "updated_at"],
  execution_attempts: ["created_at"],
  reconciliation_observations: ["created_at", "updated_at"], // updated_at added by F-DB6 drift patch
  reconciliation_jobs: ["created_at", "updated_at"],
  recovery_jobs: ["created_at", "updated_at"],
};
function appendNotNullTimestampDefaults(text: string, values: unknown[]): { text: string; values: unknown[] } {
  const m = /^\s*insert\s+into\s+"?([a-z_]+)"?\s*\(([^)]*)\)\s*values\s*\(/i.exec(text);
  if (!m) return { text, values };
  const table = m[1];
  const colsRaw = m[2];
  const defaults = INSERT_DEFAULTS_TS[table];
  if (!defaults) return { text, values };
  const cols = colsRaw.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  const missing = defaults.filter((d) => !cols.includes(d));
  if (missing.length === 0) return { text, values };
  // locate the VALUES(...) group and its matching close paren (drizzle uses $n
  // placeholders so no nested parens inside the group; ON CONFLICT DO UPDATE may
  // follow with its own parens — we only touch the first VALUES group).
  const openIdx = text.toLowerCase().indexOf("values", m.index);
  const openParen = text.indexOf("(", openIdx);
  let depth = 0, closeParen = -1;
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { closeParen = i; break; } }
  }
  if (closeParen < 0) return { text, values };
  const addCols = missing.map((d) => `"${d}"`).join(",");
  const addVals = missing.map(() => "now()").join(",");
  // rebuild: insert into "<table>" (<cols>,<addCols>) values (<vals>,<addVals>)...rest
  const colClose = text.indexOf(")", text.indexOf("(", m.index));
  const head = text.slice(0, colClose);
  const mid = text.slice(colClose + 1, closeParen);
  const tail = text.slice(closeParen + 1);
  return { text: `${head},${addCols})${mid},${addVals})${tail}`, values: [...values] };
}

// TEST-ONLY FIX (v9): drizzle's node-postgres session maps rows by the SELECT's quoted
// camelCase aliases (e.g. as "createdAt"), but pg-mem@3.0.14 returns snake_case keys on
// the {text,values} Client path (verified in isolation). When drizzle's own INSERT shape
// (explicit column list without created_at/updated_at) is followed by such a SELECT,
// every aliased mapper field arrives undefined -> production rowToIntent crashes.
// Rewrite alias suffixes `as "camelCase"` -> `as "snake_case"` so pg-mem's returned keys
// match what drizzle looks up. Only touches SELECT-alias quoting inside string literals.
// REVISED (v10, sandbox adapter only): the v9 alias-rewrite was WRONG in two ways,
// both verified in isolation (infra/repro-drizzle-select.cjs):
//   (a) pg-mem@3.0.14's Client path PRESERVES quoted aliases — it already returns
//       camelCase keys exactly as drizzle's select() expects, so no rewrite is needed;
//   (b) the old lookahead `(?=\s*(?:,|\sfrom\b))` never matched the FINAL column
//       (`"created_at" as "createdAt" from ...`), rewriting every alias EXCEPT
//       createdAt/updatedAt -> rowToIntent read row.createdAt on a snake key -> undefined
//       -> `.getTime()` TypeError (the exact live SUT crash).
// New rule: leave SELECT statements untouched; instead add camelCase mirrors for any
// snake_case timestamp-ish keys returned in rows (covers engines that ignore aliases).
function normalizeSelectAliases(text: string): string {
  return text; // v10: identity — pg-mem preserves aliases on the Client path
}
const TS_SNAKE_TO_CAMEL_RE = /^(created_at|updated_at|observed_at|submit_attempt_at|submitted_at|settled_at|not_settled_at|next_probe_at|locked_until|started_at|completed_at|expires_at|valid_after|valid_before)$/;
function addCamelMirrors(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const src = row as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(src)) {
    if (TS_SNAKE_TO_CAMEL_RE.test(k)) {
      const camel = k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      if (!(camel in src)) {
        out ??= { ...src };
        out[camel] = src[k];
      }
    }
  }
  return out ?? row;
}

// TEST-ONLY FIX (v14, sandbox adapter only): pinpointed root cause via [SBX-DIAG]:
// drizzle's node-postgres session issues SELECTs with UNQUOTED snake_case columns
// (`select "payment_intent_id", ... from ...`) and maps returned rows by the schema's
// camelCase property names. pg-mem's Client path returns snake_case keys (verified in
// isolation), so every camel lookup is undefined -> production rowToIntent crashes.
// Real PG behaves identically (returns snake keys; drizzle relies on its own mapping),
// so this shim restores the values under camel keys. Sandbox adapter only; production
// untouched. Recorded as deviation F-DB5.
const SNAKE_TO_CAMEL_RE = /_([a-z])/g;
function toCamel(k: string): string { return k.replace(SNAKE_TO_CAMEL_RE, (_m, c: string) => c.toUpperCase()); }
function addCamelFromSnake(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const src = row as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(src)) {
    if (!k.includes("_")) continue;
    const camel = toCamel(k);
    if (!(camel in src)) {
      out ??= { ...src };
      out[camel] = src[k];
    }
  }
  return out ?? row;
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
