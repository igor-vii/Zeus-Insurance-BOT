/**
 * SECRETARIAT EXTERNAL-CLIENT TEST — sandbox SUT entry point.
 *
 * This file is TEST INFRASTRUCTURE ONLY (evidence/secretariat-test experiment).
 * It does NOT modify any production source file. It composes the UNMODIFIED
 * production pieces:
 *   - createSecretariatComposition()  (api-server/src/lib/secretariat-composition.ts)
 *   - createRequestsRouter()          (api-server/src/routes/requests.ts)
 *   - Secretariat core state machine  (zeus-secretariat)
 * and adds exactly ONE test-only adapter middleware in front of the router,
 * because the public Zod schema of POST /v1/requests drops the `authorizer`
 * field that ExecuteRequest requires for the non-custodial DPI binding
 * (finding F-Z3, documented in FINAL-REPORT.md). The middleware reads the
 * client-supplied `X-Test-Authorizer` header and injects `body.authorizer`,
 * leaving all discovery / policy / payment / execution logic untouched.
 *
 * Everything else (rate limit, cors, health, /v1 boundary, recovery worker)
 * mirrors secretariat-app.ts so the SUT behaves identically to the standalone
 * composition root under test.
 */
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createSecretariatComposition } from "../../../api-server/src/lib/secretariat-composition.js";
import { createRequestsRouter } from "../../../api-server/src/routes/requests.js";
import { logger } from "../../../api-server/src/lib/logger.js";

const port = Number(process.env.SECRETARIAT_PORT ?? 18791);

const composition = createSecretariatComposition();
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 5000, standardHeaders: true, legacyHeaders: false }));

// TEST-ONLY authorizer injection (F-Z3 workaround; no production code changed).
app.use("/v1/requests", (req, _res, next) => {
  const hdr = req.header?.("x-test-authorizer");
  if (hdr && req.body && typeof req.body === "object" && !req.body.authorizer) {
    (req.body as Record<string, unknown>).authorizer = hdr;
  }
  next();
});

app.get(["/health", "/healthz"], (_req, res) => res.json({ status: "ok" }));
app.use("/v1", createRequestsRouter(composition.secretariat, composition.paymentVerifier));

await composition.recover();
composition.startWorker();
const server = app.listen(port);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
logger.info({ port }, "[secretariat-sandbox-test] Test SUT ready on /v1 (authorizer-injection middleware active)");

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await composition.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
