import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { paymentMiddleware } from "x402-express";
import router from "./routes/index.js";
import { logger } from "./lib/logger";
import { startBackgroundSync } from "./lib/background-sync";
import { startEventListener } from "./lib/event-listener";
import { ZEUS_TREASURY, x402Routes } from "./config/x402.js";
import { connectMCPServer } from "./mcp-server/index.js";
import llmsTxtRouter from "./routes/llms-txt.js";
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
  "https://zeus-insurance-frontend.onrender.com", // Production frontend
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again later.",
});
app.use(limiter);

// x402 payment middleware — guards selected /api/insurance/* routes.
// Disabled gracefully if ZEUS_TREASURY is not configured.
if (ZEUS_TREASURY) {
  app.use(paymentMiddleware(ZEUS_TREASURY, x402Routes));
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
