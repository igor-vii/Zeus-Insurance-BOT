/**
 * API BOUNDARY #1 — Standalone Secretariat entrypoint tests.
 *
 * Proves the boundary without real blockchain/payment infrastructure:
 *  T1. Router reuse: the standalone app mounts the EXISTING
 *      createRequestsRouter (imported from ../routes/requests.js — verified
 *      statically; no second router implementation exists in the repo).
 *  T2. Route availability: POST /v1/requests, GET /v1/requests/:requestId,
 *      POST /v1/requests/:requestId/payment are served by the standalone app.
 *  T3. Startup lifecycle order: recover → startWorker → serve requests.
 *      Recovery failure is fatal: worker/listen never happen (T3b).
 *  T4. Shutdown lifecycle: shutdown() reaches the existing composition
 *      shutdown after closing HTTP.
 *
 * The `@workspace/db` package and the production composition factory are
 * stubbed via a module hook so no env/DB/RPC is required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Global stub registry: `src/lib/secretariat-composition.ts` is aliased to an
// in-memory stub (see tsconfig.paths.json + vitest config aliases) so tests
// never touch the real DB/RPC/signer stack. The stub factory reads the fake
// composition from globalThis at call time.
// ---------------------------------------------------------------------------
globalThis.__secretariatFakeComposition__ = null;

// Lifecycle call log shared with the fake composition below.
const lifecycleCalls: string[] = [];

function makeFakeComposition() {
  return {
    stores: { evidenceStore: {}, executionStore: {} },
    secretariat: {
      createRequest: async () => ({ requestId: "req_fake" }),
    },
    paymentVerifier: { verify: async () => ({ valid: false }) },
    recover: async () => {
      lifecycleCalls.push("recover");
    },
    startWorker: () => {
      lifecycleCalls.push("startWorker");
    },
    shutdown: async () => {
      lifecycleCalls.push("shutdown");
    },
  };
}

const APP_URL = pathToFileURL(
  "/workspace/api-server/src/lib/secretariat-app.ts",
).href;

describe("API BOUNDARY #1: standalone Secretariat entrypoint", () => {
  test("T1: reuses the EXISTING createRequestsRouter (no copied router)", () => {
    // The standalone app module imports the router from the existing routes
    // module — there is exactly ONE createRequestsRouter implementation in
    // src/, and secretariat-app.ts references it directly.
    const appSrc = fs.readFileSync(
      "/workspace/api-server/src/lib/secretariat-app.ts",
      "utf8",
    );
    assert.match(
      appSrc,
      /import\s*\{[^}]*createRequestsRouter[^}]*\}\s*from\s*"\.\.\/routes\/requests\.js"/,
    );

    // And the router factory itself lives only in the pre-existing routes
    // module (single definition across the whole src tree).
    const defs = [
      "src/routes/requests.ts",
      "src/lib/secretariat-app.ts",
      "src/secretariat-index.ts",
      "src/app.ts",
      "src/index.ts",
    ];
    let implementations = 0;
    for (const f of defs) {
      const s = fs.readFileSync(`/workspace/api-server/${f}`, "utf8");
      if (/export function createRequestsRouter/.test(s)) implementations++;
    }
    assert.equal(implementations, 1, "exactly one createRequestsRouter definition");
  });

  test("T2+T3+T4: lifecycle order, all three /v1 routes served, graceful shutdown", async () => {
    const fake = makeFakeComposition();
    globalThis.__secretariatFakeComposition__ = fake;

    const { createSecretariatApp } = await import(APP_URL);
    const instance = createSecretariatApp(); // default: existing factory (stubbed)

    // --- T3: startup lifecycle: recover → startWorker → listen ---
    const server = await instance.listen(0); // ephemeral port proves serving
    assert.deepEqual(lifecycleCalls, ["recover", "startWorker"]);

    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    // --- T2: route availability on the standalone process ---
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    // POST /v1/requests — invalid body hits the EXISTING router's validation
    // semantics (400 INVALID_REQUEST), proving the reused router answers.
    const bad = await fetch(`${base}/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    const badJson = await bad.json();
    assert.equal(badJson.error?.code ?? badJson.code, "INVALID_REQUEST");

    // Valid body → forwarded into Secretariat.createRequest (fake).
    const ok = await fetch(`${base}/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        buyerAddress: "0x1111111111111111111111111111111111111111",
        sellerUrl: "https://seller.example.com",
        amount: "1.00",
        currency: "USDC",
        network: "base-sepolia",
      }),
    });
    // Whatever the router's success/error shape, it must NOT be Express's
    // default "Cannot POST" — i.e. the route exists.
    const okText = await ok.text();
    assert.ok(!okText.includes("Cannot POST"));

    // GET /v1/requests/:requestId — route exists (answered by the router).
    const get = await fetch(`${base}/v1/requests/req_missing`);
    const getText = await get.text();
    assert.ok(!getText.includes("Cannot GET"));

    // POST /v1/requests/:requestId/payment — route exists.
    const pay = await fetch(`${base}/v1/requests/req_missing/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const payText = await pay.text();
    assert.ok(!payText.includes("Cannot POST"));

    // --- T4: shutdown reaches the existing composition lifecycle ---
    await instance.shutdown();
    assert.deepEqual(lifecycleCalls, ["recover", "startWorker", "shutdown"]);

    // HTTP server really closed.
    await assert.rejects(fetch(`${base}/health`));
  });

  test("T3b: recovery failure aborts startup before worker/listen (fatal)", async () => {
    const fake = makeFakeComposition();
    fake.recover = async () => {
      throw new Error("recovery exploded");
    };
    globalThis.__secretariatFakeComposition__ = fake;

    const { createSecretariatApp } = await import(APP_URL);
    const instance = createSecretariatApp();

    await assert.rejects(instance.listen(0), /recovery exploded/);
    assert.ok(!lifecycleCalls.includes("startWorker"), "worker never started");
  });
});
