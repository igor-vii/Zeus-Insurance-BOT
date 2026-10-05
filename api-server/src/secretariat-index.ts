/**
 * API BOUNDARY #1 — Standalone Secretariat API process entrypoint.
 *
 * Runs the EXISTING Secretariat composition and the EXISTING /v1 router in an
 * independent HTTP process:
 *
 *   HTTP server (this file)
 *     → createSecretariatApp (existing composition + existing router, reused)
 *       → /v1/requests  |  /v1/requests/:requestId  |  /v1/requests/:requestId/payment
 *
 * It does NOT duplicate Secretariat business logic, recovery, worker, or
 * shutdown semantics — all of those come from the existing composition root.
 *
 * PORT configuration (repository convention: explicit required env var):
 *   - SECRETARIAT_PORT — preferred port for this standalone process.
 *   - PORT             — fallback (lets both processes share a config schema).
 *   The Insurance API keeps using PORT exactly as before; its default behavior
 *   is unchanged. To run both processes simultaneously, give each a different
 *   port value (e.g. Insurance PORT=3000, Secretariat SECRETARIAT_PORT=3100).
 *
 * WORKER OWNERSHIP:
 *   This process starts the reconciliation worker because it IS the standalone
 *   Secretariat process. If BOTH the Insurance API process and this process
 *   run against the SAME database, two workers poll concurrently. That is only
 *   safe while the durable store's lease/fencing semantics are relied upon
 *   (ReconciliationWorker acquires per-job leases; see b8-r2-repair9-fencing /
 *   b8-r1-stale-worker-fencing tests). No distributed election was added in
 *   this boundary task by design. Single-process deployments remain the default.
 */

import { createSecretariatApp } from "./lib/secretariat-app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["SECRETARIAT_PORT"] ?? process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "SECRETARIAT_PORT (or PORT) environment variable is required for the standalone Secretariat API.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid SECRETARIAT_PORT value: "${rawPort}"`);
}

const standalone = createSecretariatApp();

// Startup lifecycle (existing semantics): recover → startWorker → serve.
// Any failure here rejects and exits non-zero — never serve a broken API.
try {
  await standalone.listen(port);
  logger.info({ port }, "[secretariat-standalone] Secretariat API ready on /v1");
} catch (err) {
  logger.error({ err }, "[secretariat-standalone] Startup failed — exiting");
  process.exit(1);
}

// ── Graceful Shutdown ───────────────────────────────────────────────────────
// Mirrors index.ts: SIGTERM/SIGINT → close HTTP (drain in-flight) → existing
// composition shutdown lifecycle → exit. Idempotent.
let shuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "[secretariat-standalone] Shutdown signal received");

  try {
    await standalone.shutdown();
  } catch (err) {
    logger.error({ err }, "[secretariat-standalone] Error during graceful shutdown");
  }

  logger.info("[secretariat-standalone] Process exiting");
  process.exit(0);
}

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
