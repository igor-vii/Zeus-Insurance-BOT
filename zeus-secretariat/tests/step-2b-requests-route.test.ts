import express = require("express");
import http from "node:http";
import { jest } from "@jest/globals";

jest.mock("@workspace/db", () => ({ db: { mock: true } }));
jest.mock("zeus-secretariat", () => {
  const actual = jest.requireActual("zeus-secretariat") as Record<string, unknown>;
  return {
    ...actual,
    createSharedStores: jest.fn(() => ({
      evidenceStore: {},
      executionStore: {},
    })),
  };
});
jest.mock("zeus-secretariat/adapters/local-eoa-signer", () => ({
  createLocalEoaSignerFromEnv: jest.fn(() => undefined),
}));
jest.mock("../../api-server/src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const VALID_RPC = JSON.stringify([
  {
    providerId: "a",
    underlyingProvider: "alchemy",
    rpcUrl: "https://a.example.com",
    maxStalenessBlocks: 10,
  },
  {
    providerId: "b",
    underlyingProvider: "infura",
    rpcUrl: "https://b.example.com",
    maxStalenessBlocks: 10,
  },
]);

describe("Step 2B: public Secretariat request route", () => {
  let server: http.Server;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env["ZEUS_RPC_PROVIDERS"] = VALID_RPC;
    process.env["ZEUS_FACILITATOR_URL"] = "https://facilitator.example.com";
    process.env["ZEUS_SELLER_URL"] = "https://seller.example.com";
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    jest.restoreAllMocks();
  });

  test("POST /v1/requests returns only the public Stage-A result", async () => {
    const { createSecretariatComposition } = await import(
      "../../api-server/src/lib/secretariat-composition"
    );
    const { createRequestsRouter } = await import(
      "../../api-server/src/routes/requests"
    );

    const composition = createSecretariatComposition();
    const createRequest = jest
      .spyOn(composition.secretariat, "createRequest")
      .mockResolvedValue({
        status: "AWAITING_PAYMENT_SIGNATURE",
        requestId: "req-public-2b",
        operationId: "internal-operation-id",
        paymentRequired: {
          amount: "1000000",
          asset: "0xUSDC",
          network: "base-sepolia",
          payee: "0x00000000000000000000000000000000000000b2",
        },
        paymentIntent: {
          paymentIntentId: "internal-payment-intent-id",
          authorizer: "0x00000000000000000000000000000000000000a1",
          payTo: "0x00000000000000000000000000000000000000b2",
          value: "1000000",
          asset: "0xUSDC",
          network: "base-sepolia",
          nonce: "0x01",
          validAfter: 0,
          validBefore: 1,
          settlementState: "PENDING_SIGNATURE",
        },
      });

    const app = express();
    app.use(express.json());
    app.use("/v1", createRequestsRouter(composition.secretariat));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "https://seller.example.com/resource",
        method: "POST",
        payload: { prompt: "hello" },
        clientId: "client-public-2b",
        requestId: "req-public-2b",
        policy: {
          maxPrice: "1000000",
          allowedNetworks: ["base-sepolia"],
          allowedAssets: ["0xUSDC"],
          authorizationMode: "explicit",
        },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      requestId: "req-public-2b",
      status: "AWAITING_PAYMENT_SIGNATURE",
      paymentRequired: {
        amount: "1000000",
        asset: "0xUSDC",
        network: "base-sepolia",
        payee: "0x00000000000000000000000000000000000000b2",
      },
    });
    expect(body.operationId).toBeUndefined();
    expect(body.paymentIntent).toBeUndefined();
    expect(createRequest).toHaveBeenCalledWith({
      target: "https://seller.example.com/resource",
      method: "POST",
      payload: { prompt: "hello" },
      clientId: "client-public-2b",
      requestId: "req-public-2b",
      policy: {
        maxPrice: "1000000",
        allowedNetworks: ["base-sepolia"],
        allowedAssets: ["0xUSDC"],
        authorizationMode: "explicit",
      },
    });
  });
});