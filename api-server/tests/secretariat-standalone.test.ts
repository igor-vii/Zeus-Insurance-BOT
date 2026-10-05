import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSecretariatApp } from "../src/lib/secretariat-app.js";
import type { SecretariatComposition } from "../src/lib/secretariat-composition.js";

const calls: string[] = [];

function fakeComposition(overrides: Partial<SecretariatComposition> = {}): SecretariatComposition {
  const fake = {
    stores: { evidenceStore: {}, executionStore: {} },
    rpcChecker: {},
    reconciliationEngine: {},
    settlementAdapter: {},
    sellerAdapter: {},
    postSettlementEngine: {},
    reconciliationWorker: {},
    secretariat: {
      createRequest: async () => ({
        requestId: "req_test",
        status: "AWAITING_PAYMENT_SIGNATURE",
        paymentRequired: { amount: "1", asset: "0x0000000000000000000000000000000000000001", network: "eip155:84532", payee: "0x0000000000000000000000000000000000000002", deadline: 9999999999 },
      }),
      getOperationByRequestId: async () => null,
      submitSignedPayment: async () => undefined,
    },
    paymentVerifier: {
      verify: async () => ({ status: "INVALID", code: "REQUEST_NOT_FOUND", message: "The request was not found" }),
    },
    recover: async () => { calls.push("recover"); },
    startWorker: () => { calls.push("startWorker"); },
    shutdown: async () => { calls.push("shutdown"); },
  } as unknown as SecretariatComposition;
  return Object.assign(fake, overrides);
}

beforeEach(() => calls.splice(0));

describe("standalone Secretariat API boundary", () => {
  test("serves the existing /v1 router through the standalone app", async () => {
    const fake = fakeComposition();
    const instance = createSecretariatApp({ composition: fake });
    const server = await instance.listen(0);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      assert.deepEqual(calls, ["recover", "startWorker"]);
      const invalid = await fetch(`${base}/v1/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");

      const valid = await fetch(`${base}/v1/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "https://seller.example.com/task",
          method: "POST",
          payload: { input: "test" },
          clientId: "client_test",
          policy: {
            maxPrice: "1",
            allowedNetworks: ["eip155:84532"],
            allowedAssets: ["0x0000000000000000000000000000000000000001"],
            authorizationMode: "explicit",
          },
        }),
      });
      assert.equal(valid.status, 201);
      assert.equal((await valid.json()).requestId, "req_test");

      const missing = await fetch(`${base}/v1/requests/missing`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "REQUEST_NOT_FOUND");

      const payment = await fetch(`${base}/v1/requests/missing/payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(payment.status, 404);
      assert.equal((await payment.json()).error.code, "REQUEST_NOT_FOUND");
    } finally {
      await instance.shutdown();
    }
    assert.deepEqual(calls, ["recover", "startWorker", "shutdown"]);
    await assert.rejects(fetch(`${base}/health`));
  });

  test("recovery failure prevents worker startup and HTTP binding", async () => {
    const fake = fakeComposition({
      recover: async () => { calls.push("recover"); throw new Error("recovery exploded"); },
    });
    const instance = createSecretariatApp({ composition: fake });
    await assert.rejects(instance.listen(0), /recovery exploded/);
    assert.deepEqual(calls, ["recover"]);
  });

  test("worker starts at most once for a successful lifecycle", async () => {
    let starts = 0;
    const fake = fakeComposition({ startWorker: () => { calls.push("startWorker"); starts++; } });
    const instance = createSecretariatApp({ composition: fake });
    const server = await instance.listen(0);
    try {
      assert.equal(starts, 1);
      assert.equal(calls.filter((c) => c === "recover").length, 1);
    } finally {
      await instance.shutdown();
    }
  });
});
