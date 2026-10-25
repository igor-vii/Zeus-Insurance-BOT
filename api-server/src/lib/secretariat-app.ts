/** Standalone Secretariat API application boundary. Reuses the canonical composition and /v1 router. */
import express, { type Express } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Server } from "node:http";
import { createSecretariatComposition, type SecretariatComposition } from "./secretariat-composition.js";
import { createRequestsRouter } from "../routes/requests.js";
import { logger } from "./logger.js";

export interface StandaloneSecretariatApp {
  app: Express;
  listen(port: number): Promise<Server>;
  shutdown(): Promise<void>;
}

export interface SecretariatAppOptions {
  composition?: SecretariatComposition;
}

export function createSecretariatApp(options: SecretariatAppOptions = {}): StandaloneSecretariatApp {
  const composition = options.composition ?? createSecretariatComposition();
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    rateLimit({
      windowMs: Number(process.env["RATE_LIMIT_WINDOW_MS"] ?? 15 * 60 * 1000),
      // R6 (standalone parity with app.ts): the ceiling must be configurable —
      // the adversarial E2E and the Argus live matrix legitimately exceed 100
      // requests in a 15-minute window (long-poll status checks alone add up);
      // a hardcoded 100 produced mid-run HTTP 429s for the REST of the window.
      // Production keeps the safe default when the env is unset.
      max: Number(process.env["RATE_LIMIT_MAX"] ?? 100),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.get(["/health", "/healthz"], (_req, res) => res.json({ status: "ok" }));
  app.use("/v1", createRequestsRouter(composition.secretariat, composition.paymentVerifier));

  let httpServer: Server | null = null;
  let workerStarted = false;

  async function listen(port: number): Promise<Server> {
    await composition.recover();
    if (!workerStarted) {
      composition.startWorker();
      workerStarted = true;
    }
    httpServer = app.listen(port);
    await new Promise<void>((resolve, reject) => {
      httpServer?.once("listening", () => resolve());
      httpServer?.once("error", reject);
    });
    logger.info({ port }, "[secretariat-standalone] Server listening");
    return httpServer;
  }

  async function shutdown(): Promise<void> {
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => err ? reject(err) : resolve());
      });
      httpServer = null;
    }
    await composition.shutdown();
  }

  return { app, listen, shutdown };
}
