import app, { gracefulShutdown } from "./app";
import { logger } from "./lib/logger";
import type { Server } from "http";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server: Server = app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// ── Graceful Shutdown (R2.1) ────────────────────────────────────────────────
// SIGTERM and SIGINT both trigger the same idempotent shutdown path.
let shuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // idempotent
  shuttingDown = true;

  logger.info({ signal }, "Shutdown signal received");

  // 1. Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // 2. Run application-level graceful shutdown (worker, event listener, etc.)
  try {
    await gracefulShutdown();
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown");
  }

  // 3. Exit
  logger.info("Process exiting");
  process.exit(0);
}

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
