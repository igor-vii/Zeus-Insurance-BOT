import express = require("express");
import http from "node:http";
import { jest } from "@jest/globals";

import type { Operation } from "zeus-secretariat";

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

function operationFixture(
  overrides: Partial<Operation> = {},
): Operation {
  return {
    operationId: "internal-operation-id",
    requestId: "req-public-2c",
    target: "https://seller.example.com/resource",
    method: "POST",
    paymentPolicy: {
      maxPrice: "1000000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: ["0xUSDC"],
      authorizationMode: "explicit",
    },
    paymentState: "NOT_STARTED",
    executionState: "NOT_STARTED",
    deliveryState: "NOT_STARTED",
    currentState: "AWAITING_SIGNATURE",
    timestamps: {
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
    evidence: [],
    ...overrides,
  };
}

describe("Step 2C: public Secretariat request status route", () => {
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

  async function startApp(operation: Operation | null) {
    const { createSecretariatComposition } = await import(
      "../../api-server/src/lib/secretariat-composition"
    );
    const { createRequestsRouter } = await import(
      "../../api-server/src/routes/requests"
    );

    const composition = createSecretariatComposition();
    jest
      .spyOn(composition.secretariat, "getOperationByRequestId")
      .mockResolvedValue(operation);

    const app = express();
    app.use("/v1", createRequestsRouter(composition.secretariat));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not start");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  test("maps pending signature to the public contract", async () => {
    const paymentRequired = {
      amount: "1000000",
      asset: "0xUSDC",
      network: "base-sepolia",
      payee: "0x00000000000000000000000000000000000000b2",
    };
    const baseUrl = await startApp(
      operationFixture({
        evidence: [
          {
            operationId: "internal-operation-id",
            phase: "DISCOVERY",
            event: "PAYMENT_REQUIREMENT_RECEIVED",
            timestamp: 1700000000000,
            payload: { requirement: paymentRequired },
          },
        ],
      }),
    );

    const response = await fetch(`${baseUrl}/v1/requests/req-public-2c`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      requestId: "req-public-2c",
      status: "AWAITING_PAYMENT_SIGNATURE",
      paymentRequired,
      evidenceCount: 1,
    });
    expect(body.operationId).toBeUndefined();
    expect(body.paymentIntent).toBeUndefined();
  });

  test("maps successful execution to COMPLETED without internal fields", async () => {
    const baseUrl = await startApp(
      operationFixture({
        currentState: "SUCCESS",
        executionState: "CONFIRMED",
        deliveryState: "DELIVERED",
        resultData: { answer: "hello" },
        timestamps: {
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
          completedAt: 1700000001000,
        },
        settlementProof: {
          transactionHash: "0xsettled",
          timestamp: 1700000000500,
          amount: "1000000",
          asset: "0xUSDC",
          source: "rpc",
        },
        evidence: [
          {
            operationId: "internal-operation-id",
            phase: "FINAL",
            event: "DIRECT_SUCCESS",
            timestamp: 1700000001000,
            payload: { operationId: "internal-operation-id" },
          },
        ],
      }),
    );

    const response = await fetch(`${baseUrl}/v1/requests/req-public-2c`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      requestId: "req-public-2c",
      status: "COMPLETED",
      settlementTxHash: "0xsettled",
      outcome: { answer: "hello" },
      resolvedAt: 1700000001000,
      evidenceCount: 1,
    });
    expect(body.operationId).toBeUndefined();
    expect(body.paymentIntent).toBeUndefined();
    expect(body.recoveryInfo).toBeUndefined();
  });

  test("maps settlement processing to PROCESSING", async () => {
    const baseUrl = await startApp(
      operationFixture({
        currentState: "SETTLEMENT_PENDING",
        paymentState: "UNKNOWN",
        evidence: [
          {
            operationId: "internal-operation-id",
            phase: "PAYMENT",
            event: "PAYMENT_SUBMITTED",
            timestamp: 1700000000500,
            payload: {
              transactionHash: "0xsubmitted",
              rawData: { internal: "hidden" },
            },
          },
        ],
      }),
    );

    const response = await fetch(`${baseUrl}/v1/requests/req-public-2c`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      requestId: "req-public-2c",
      status: "PROCESSING",
      settlementTxHash: "0xsubmitted",
      evidenceCount: 1,
    });
    expect(body.rawData).toBeUndefined();
    expect(body.operationId).toBeUndefined();
  });

  test("returns 404 for an unknown request", async () => {
    const baseUrl = await startApp(null);

    const response = await fetch(`${baseUrl}/v1/requests/missing-request`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "REQUEST_NOT_FOUND",
        message: "The request was not found",
      },
    });
  });
});