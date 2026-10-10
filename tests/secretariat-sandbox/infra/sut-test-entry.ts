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
// TEST-ONLY isolated virtual DB (pg-mem, real production schema migrations applied).
// MUST be imported before anything that constructs a pg Pool (lib/db).
import { memdb } from "./pg-mem-boot.js";
import fs from "node:fs";
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
// The public Zod schema of POST /v1/requests strips `authorizer`, but
// createPendingPaymentIntent() requires request.authorizer. The middleware
// reads the client-supplied X-Test-Authorizer header and injects it into the
// body BEFORE zod parsing happens inside the router (router is mounted after).
// IMPORTANT: express.json() runs BEFORE this middleware, so mutating req.body
// here is invisible to the router's own zod safeParse (which strips unknown
// keys). The injection therefore happens at the PARSED-ARGUMENT level: we
// wrap createRequest and re-attach the authorizer captured from the header.
app.use("/v1/requests", (req, _res, next) => {
  const hdr = req.header?.("x-test-authorizer");
  if (hdr && req.body && typeof req.body === "object") {
    // stash for the createRequest wrapper below (single-threaded test process;
    // requestId correlation makes it safe even with concurrent requests)
    const rid = (req.body as Record<string, unknown>).requestId as string | undefined;
    if (rid) pendingAuthorizers.set(rid, hdr);
    (req as unknown as Record<string, unknown>).__testAuthorizer = hdr;
  }
  next();
});
const pendingAuthorizers = new Map<string, string>();

// TEST-ONLY signer override (sandbox adapter only; production composition
// untouched). The custodial_test LocalEoaSigner in the composition would
// otherwise bind every DPI to the server key address, contradicting the
// client-supplied authorizer. We replace config.signer with a per-operation
// view whose getAddress() returns the authorizer of the request currently
// being processed by this single-threaded test process. Stage B
// (submitSignedPayment) never uses the signer: payment payloads are verified
// against the persisted DPI authorizer via Eip3009PaymentVerifier.
{
  const s = composition.secretariat as unknown as {
    config: { signer?: { signerType: string; getAddress(): Promise<string>; signPayment(req: unknown): Promise<never> } };
    createRequest(request: { authorizer?: string; requestId?: string }): Promise<unknown>;
  };

  // TEST-ONLY authorizer re-injection at the PARSED level (F-Z3 workaround).
  // The router's zod schema strips `authorizer` from the HTTP body before
  // calling createRequest. We wrap createRequest and restore the value that
  // the middleware above captured from X-Test-Authorizer, correlated by
  // requestId. No production file changed.
  const origCreateRequest = s.createRequest.bind(s);
  s.createRequest = async (request) => {
    if (!request.authorizer && request.requestId) {
      const hdr = pendingAuthorizers.get(request.requestId);
      if (hdr) {
        request = { ...request, authorizer: hdr };
        pendingAuthorizers.delete(request.requestId);
      }
    }
    return origCreateRequest(request);
  };

  let currentAuthorizer: string | null = null;
  s.config.signer = {
    signerType: "SANDBOX_CLIENT_BOUND",
    async getAddress() {
      if (!currentAuthorizer) throw new Error("sandbox signer: no active authorizer binding");
      return currentAuthorizer;
    },
    async signPayment(): Promise<never> {
      throw new Error("SANDBOX_SIGNER_CANNOT_SIGN: non-custodial flow only");
    },
  };
  // Bind the current authorizer right before prepareStageA runs.
  const origPrepare = s.prepareStageA.bind(s);
  (s as unknown as { prepareStageA(req: unknown, opts?: unknown): Promise<unknown> }).prepareStageA =
    async (req: unknown, opts?: unknown) => {
      currentAuthorizer = (req as { authorizer?: string }).authorizer ?? null;
      try {
        return await origPrepare(req, opts);
      } finally {
        currentAuthorizer = null;
      }
    };
}

app.get(["/health", "/healthz"], (_req, res) => res.json({ status: "ok" }));

// TEST-ONLY DIAGNOSTIC WRAPPER (finding F-D1 instrumentation; production class
// untouched). Captures the real internal failure reason of Stage-A discovery/
// policy validation, which the public router collapses into a generic 422.
{
  const s = composition.secretariat as unknown as {
    prepareStageA(req: unknown, opts?: unknown): Promise<{ status: string; operation?: { evidence: unknown[] }; result?: unknown }>;
  };
  const orig = s.prepareStageA.bind(s);
  s.prepareStageA = async (req: unknown, opts?: unknown) => {
    let out: Awaited<ReturnType<typeof orig>> | null = null;
    let thrown: unknown = null;
    try {
      out = await orig(req, opts);
    } catch (e) {
      thrown = e;
    }
    try {
      const op = out?.operation as { currentState?: string; error?: string; evidence?: { phase: string; event: string; payload: unknown }[] } | undefined;
      logger.info(
        {
          diag: "stage-a",
          requestId: (req as { requestId?: string }).requestId,
          status: out?.status ?? null,
          state: op?.currentState ?? null,
          error: op?.error ?? String((thrown as Error)?.message ?? thrown ?? ""),
          lastEvidence: (op?.evidence ?? []).slice(-3),
        },
        "[sandbox-diag] prepareStageA outcome"
      );
    } catch { /* diagnostics must never break the flow */ }
    if (thrown) throw thrown;
    return out!;
  };
}

app.use("/v1", createRequestsRouter(composition.secretariat, composition.paymentVerifier));

await composition.recover();
composition.startWorker();
const server = app.listen(port);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
logger.info({ port }, "[secretariat-sandbox-test] Test SUT ready on /v1 (authorizer-injection middleware active)");

// TEST-ONLY: on SIGUSR1, dump every Secretariat-owned table of the isolated
// virtual DB to evidence/secretariat-test/secretariat-test-db-dump.json (§6).
const DUMP_TABLES = [
  "payment_intents",
  "nonce_registry",
  "execution_attempts",
  "reconciliation_observations",
  "reconciliation_jobs",
  "recovery_jobs",
];
function dumpDb(): void {
  const tables: Record<string, unknown[]> = {};
  for (const t of DUMP_TABLES) {
    try {
      const rows = memdb.public.query(`SELECT * FROM "${t}"`).execute() as unknown[];
      tables[t] = JSON.parse(JSON.stringify(rows));
    } catch (e) {
      tables[t] = [];
      logger.error({ err: String(e), table: t }, "[sandbox] dump table failed");
    }
  }
  const out = {
    database: {
      type: "pg-mem (in-process PostgreSQL-compatible engine; no PG server binary available in this environment)",
      isolated: true,
      schemaSource: "lib/db/drizzle/0000_init.sql + lib/db/drizzle/migrations/0005_secretariat_tables.sql (production migrations applied verbatim; 0004_partitioning skipped — watcher partitioning not used by Secretariat stores; deviation F-DB2)",
      dumpedAt: new Date().toISOString(),
    },
    tables,
  };
  fs.writeFileSync("/workspace/evidence/secretariat-test/secretariat-test-db-dump.json", JSON.stringify(out, null, 2));
  logger.info("[sandbox] DB dump written");
}
process.on("SIGUSR1", () => {
  dumpDb();
});

async function shutdown(): Promise<void> {
  dumpDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await composition.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
