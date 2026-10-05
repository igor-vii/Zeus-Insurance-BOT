/**
 * API BOUNDARY #1 — Standalone Secretariat Express application factory.
 *
 * This module is the ONLY place that wires HTTP to Secretariat for the
 * standalone process. It deliberately REUSES:
 *   - the existing production composition root (`createSecretariatComposition`)
 *   - the existing public `/v1` router (`createRequestsRouter`)
 *
 * Dependency direction (must not be inverted):
 *   secretariat-index.ts (HTTP server)
 *     → createSecretariatApp (this module)
 *       → createRequestsRouter (existing /v1 router, unchanged)
 *         → createSecretariatComposition (existing composition root, unchanged)
 *           → zeus-secretariat core / adapters / @workspace/db persistence
 *
 * Lifecycle semantics mirror the existing Insurance app exactly:
 *   1. `await listen()` runs composition.recover() BEFORE the worker starts
 *      and BEFORE the port accepts connections (recovery failure is fatal).
 *   2. `composition.startWorker()` runs after recovery, exactly once.
 *   3. `shutdown()` closes the HTTP server first (in-flight requests drain),
 *      then delegates to the existing composition shutdown lifecycle.
 *
 * WORKER OWNERSHIP: this process owns its own reconciliation worker. When
 * deployed alongside the Insurance API process against the SAME database,
 * both processes would run a worker; see api-boundary documentation in
 * secretariat-index.ts header for the current lease-based safety note.
 */

import express, { type Express } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Server } from "node:http";
import {
  createSecretariatComposition,
  type SecretariatComposition,
} from "./secretariat-composition.js";
import { createRequestsRouter } from "../routes/requests.js";
import { logger } from "./logger.js";

export interface StandaloneSecretariatApp {
  app: Express;
  /**
   * Start listening on `port`.
   * Order: composition already created → recover() → startWorker() → listen.
   * Rejects if recovery fails so the entrypoint can exit non-zero instead of
   * serving broken traffic.
   */
  listen(port: number): Promise<Server>;
  /** Graceful shutdown: HTTP close first, then existing composition shutdown. */
  shutdown(): Promise<void>;
}

export interface SecretariatAppOptions {
  /**
   * Optional composition injection for tests only. In production the existing
   * canonical factory (`createSecretariatComposition`) is used unchanged.
   */
  composition?: SecretariatComposition;
}

export function createSecretariatApp(
  options: SecretariatAppOptions = {},
): StandaloneSecretariatApp {
  // The existing production composition root — single shared dependency graph.
  const composition = options.composition ?? createSecretariatComposition();

  const app: Express = express();
  app.set("trust proxy", 1);
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Same default limiter shape as the Insurance app's general limiter.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: "Too many requests from this IP, please try again later.",
    }),
  );

  // Root-level health endpoint for load balancers (same convention as app.ts).
  app.get(["/health", "/healthz"], (_req, res) => {
    res.json({ status: "ok" });
  });

  // Existing Secretariat /v1 router mounted unchanged. It receives THE same
  // production composition instances — no second composition, no copy.
  app.use(
    "/v1",
    createRequestsRouter(composition.secretariat, composition.paymentVerifier),
  );

  let httpServer: Server | null = null;
  let workerStarted = false;

  async function listen(port: number): Promise<Server> {
    // Startup recovery MUST happen before the worker starts and before any
    // traffic is accepted (existing R2.1 lifecycle semantics).
    await composition.recover();

    if (!workerStarted) {
      composition.startWorker();
      workerStarted = true;
    }

    httpServer = app.listen(port);
    await new Promise<void>((resolve, reject) => {
      httpServer?.once("listening", () => resolve());
      httpServer?.once("error", (err) => reject(err));
    });
    logger.info({ port }, "[secretariat-standalone] Server listening");
    return httpServer;
  }

  async function shutdown(): Promise<void> {
    // 1. Stop accepting new connections; wait for in-flight requests.
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    // 2. Delegate to the EXISTING composition shutdown lifecycle (idempotent).
    await composition.shutdown();
  }

  return { app, listen, shutdown };
}
