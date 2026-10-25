import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { paymentMiddleware } from "x402-express";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { startBackgroundSync } from "./lib/background-sync.js";
import { startEventListener } from "./lib/event-listener.js";
import { ZEUS_TREASURY, X402_FACILITATOR_URL, x402Routes } from "./config/x402.js";
import { connectMCPServer } from "./mcp-server/index.js";
import llmsTxtRouter from "./routes/llms-txt.js";
import { createRequestsRouter } from "./routes/requests.js";
// DISABLED in production — test endpoint security risk
// import testRouter from "./routes/test.js";
import rateLimit from "express-rate-limit";

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env["SENTRY_DSN"] ?? "",
  environment: process.env["NODE_ENV"] ?? "development",
  tracesSampleRate: 0.1,
});

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const replitDomain = process.env["REPLIT_DEV_DOMAIN"];
const corsOriginsEnv = process.env["CORS_ORIGINS"];
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  ...(replitDomain ? [`https://${replitDomain}`] : []),
  ...(corsOriginsEnv
    ? corsOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean)
    : []),
  "https://zeus-insurance-bot-frontend.vercel.app", // canonical production frontend (Vercel)
  "https://zeus-insurance-frontend.onrender.com", // legacy Render frontend (dead; kept one transition cycle)
  "https://zeus-insurance-bot.onrender.com", // actual Render origin (from user report)
  "https://zeus-insurance-bot-frontend.onrender.com", // alt Render origin
]);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (e.g. curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      // Wildcard dev domains removed for security
      callback(new Error(`CORS: origin not allowed — ${origin}`));
    },
    credentials: true,
  }),
);
app.use(cookieParser(process.env["SESSION_SECRET"]));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: Number(process.env["RATE_LIMIT_WINDOW_MS"] ?? 15 * 60 * 1000),
  // R6: configurable ceiling — the adversarial E2E legitimately exceeds 100
  // requests in a short window; production keeps the safe default.
  max: Number(process.env["RATE_LIMIT_MAX"] ?? 100),
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again later.",
});
app.use(limiter);

// x402 payment middleware — guards selected /api/insurance/* routes.
// Disabled gracefully if ZEUS_TREASURY is not configured.
// The facilitator is Zeus-operated (X402_FACILITATOR_URL / ZEUS_FACILITATOR_URL):
// the default public facilitator does not support eip155:196 (X Layer).
if (ZEUS_TREASURY) {
  const facilitator = X402_FACILITATOR_URL
    ? { url: X402_FACILITATOR_URL }
    : undefined;
  if (!facilitator) {
    // F-113/M-15 (external audit 2026-10-26): fail fast in production — the
    // default public facilitator does NOT support eip155:196 (the only
    // network x402Routes targets), so "start anyway and warn" guarantees that
    // every settlement of a protected route fails at runtime, after the
    // payment was already accepted. In development the warning is enough.
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "X402_FACILITATOR_URL is required when ZEUS_TREASURY is set in production: " +
        "the default facilitator does not support eip155:196, protected routes would fail settlement",
      );
    }
    logger.warn(
      "X402_FACILITATOR_URL not set — falling back to default facilitator " +
        "(does NOT support eip155:196; protected routes will fail settlement)",
    );
  }
  app.use(paymentMiddleware(ZEUS_TREASURY, x402Routes, facilitator));
} else {
  logger.warn("ZEUS_TREASURY not set — x402 payment middleware disabled");
}

// Root-level health endpoint — no /api prefix so Railway's healthcheck and
// load-balancers can reach it directly at GET /health or GET /healthz
app.get(["/health", "/healthz"], (_req, res) => {
  res.json({ status: "ok" });
});

app.use(llmsTxtRouter);
app.use("/api", router);

// MCP server — AI agent interface at POST /mcp
connectMCPServer(app);

// ── Secretariat Composition Root (R2.1) ─────────────────────────────────────
// Creates shared dependency graph for all Secretariat subsystems.
let secretariatShutdown: (() => Promise<void>) | null = null;

try {
  const { createSecretariatComposition } = await import("./lib/secretariat-composition.js");
  const composition = createSecretariatComposition();

  // Startup recovery MUST happen before worker starts
  await composition.recover();

  // Start reconciliation worker (polling loop)
  composition.startWorker();

  // Export shutdown for signal handlers in index.ts
  secretariatShutdown = composition.shutdown;

  // Public Stage-A Secretariat API. The router uses this exact production
  // instance; it must not create a second composition or duplicate Stage-A.
  app.use("/v1", createRequestsRouter(composition.secretariat, composition.paymentVerifier));

  logger.info("[app] Secretariat composition root initialized");
} catch (err) {
  // Config validation failure is FATAL — don't start a partially-initialized server
  logger.error({ err }, "[app] Secretariat composition failed — server cannot start");
  process.exit(1);
}

// ── Existing Background Services ────────────────────────────────────────────
// These are independent of Secretariat and remain as-is.

// Start the 5-minute background sync scheduler
startBackgroundSync();

// Start on-chain event listener (returns stop function)
const stopEventListener = startEventListener();

// ── Export shutdown hook for index.ts ────────────────────────────────────────
export async function gracefulShutdown(): Promise<void> {
  logger.info("[app] Graceful shutdown initiated");

  // 1. Stop Secretariat (worker + reconciliation)
  if (secretariatShutdown) {
    await secretariatShutdown();
  }

  // 2. Stop event listener
  if (stopEventListener) {
    stopEventListener();
  }

  // Note: startBackgroundSync uses interval.unref() — no explicit stop needed.
  // The interval will not prevent process exit.

  logger.info("[app] Graceful shutdown complete");
}

app.use(Sentry.expressErrorHandler());

export default app;
