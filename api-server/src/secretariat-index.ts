import { createSecretariatApp } from "./lib/secretariat-app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["SECRETARIAT_PORT"] ?? process.env["PORT"];
if (!rawPort) throw new Error("SECRETARIAT_PORT (or PORT) environment variable is required for the standalone Secretariat API.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid SECRETARIAT_PORT value: "${rawPort}"`);

const standalone = createSecretariatApp();
try {
  await standalone.listen(port);
  logger.info({ port }, "[secretariat-standalone] Secretariat API ready on /v1");
} catch (err) {
  logger.error({ err }, "[secretariat-standalone] Startup failed — exiting");
  process.exit(1);
}

let shuttingDown = false;
async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "[secretariat-standalone] Shutdown signal received");
  try { await standalone.shutdown(); }
  catch (err) { logger.error({ err }, "[secretariat-standalone] Error during graceful shutdown"); }
  process.exit(0);
}
process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
