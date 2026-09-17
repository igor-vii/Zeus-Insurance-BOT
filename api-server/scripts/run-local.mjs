#!/usr/bin/env node
/**
 * Local dev runner for api-server.
 *
 * Node's built-in `--env-file` strips quotes inside values, which breaks
 * JSON-valued env vars like ZEUS_RPC_PROVIDERS. This runner parses
 * .env.local correctly (values taken verbatim after the first '='),
 * then spawns the built server with the parsed env.
 *
 * Usage:
 *   node scripts/run-local.mjs           # uses .env.local
 *   node scripts/run-local.mjs .env.staging
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiServerRoot = resolve(here, "..");

const envFile = process.argv[2] ?? ".env.local";
const envPath = resolve(apiServerRoot, envFile);

let raw;
try {
  raw = readFileSync(envPath, "utf8");
} catch (err) {
  console.error(`run-local: cannot read ${envPath}: ${err.message}`);
  process.exit(1);
}

const parsed = {};
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;

  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1);

  // Strip surrounding single or double quotes only — do NOT strip
  // quotes inside the value (that is what --env-file does wrong).
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  parsed[key] = value;
}

// Do not override anything already set in the parent env — explicit
// `export` in the shell still wins.
const merged = { ...parsed, ...process.env };

console.log(`run-local: loaded ${Object.keys(parsed).length} vars from ${envPath}`);

const entry = resolve(apiServerRoot, "dist/index.mjs");

const child = spawn(
  process.execPath,
  ["--enable-source-maps", entry],
  { stdio: "inherit", env: merged }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
