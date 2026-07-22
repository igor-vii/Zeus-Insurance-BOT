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

const app: Express = express();

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
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  ...(replitDomain ? [`https://${replitDomain}`] : []),
]);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (e.g. curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      // Also allow any *.replit.app / *.repl.co subdomain for deployed previews
      if (/^https:\/\/[^.]+\.(replit\.app|repl\.co|netlify\.app)$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin not allowed — ${origin}`));
    },
    credentials: true,
  }),
);
app.use(cookieParser(process.env["SESSION_SECRET"]));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// x402 payment middleware — guards selected /api/insurance/* routes.
// Disabled gracefully if ZEUS_TREASURY is not configured.
if (ZEUS_TREASURY) {
  app.use(paymentMiddleware(ZEUS_TREASURY, x402Routes));
} else {
  logger.warn("ZEUS_TREASURY not set — x402 payment middleware disabled");
}

app.use("/api", router);

// MCP server — AI agent interface at POST /mcp
connectMCPServer(app);

// Start the 5-minute background sync scheduler
startBackgroundSync();

// Start on-chain event listener (disable with ENABLE_EVENT_LISTENER=false)
startEventListener();

export default app;
