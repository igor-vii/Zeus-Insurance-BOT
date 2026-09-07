import express = require("express");
import http from "node:http";
import { jest } from "@jest/globals";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, type Address } from "viem";

import { EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES, Eip3009PaymentVerifier } from "../src/core/eip3009-verifier";
import { Secretariat } from "../src/core/state-machine";
import type {
  DurableEvidenceStore,
  DurablePaymentIntent,
  EvidenceRecord,
  Operation,
} from "../src/core/types";
import type { PaymentPayload, SettlementAdapter } from "../src/adapters/x402-facilitator-client";

jest.mock("../../api-server/src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PRIVATE_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
const account = privateKeyToAccount(PRIVATE_KEY);
const authorizer = account.address;
const payTo = "0x00000000000000000000000000000000000000b2" as Address;
const asset = "0x00000000000000000000000000000000000000a1" as Address;
const requestId = "req-public-2d-2";
const operationId = "op-public-2d-2";
const paymentIntentId = "pi-public-2d-2";
const nonce = `0x${"02".padStart(64, "0")}` as `0x${string}`;
const validAfter = 1_700_000_000;
const validBefore = 1_700_000_300;
const domain = {
  name: "USD Coin",
  version: "2",
  chainId: 84532,
  verifyingContract: asset,
} as const;

function operationFixture(): Operation {
  return {
    operationId,
    requestId,
    target: "https://seller.example.com/resource",
    method: "POST",
    paymentPolicy: {
      maxPrice: "1000000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: [asset],
      authorizationMode: "explicit",
    },
    paymentState: "NOT_STARTED",
    executionState: "NOT_STARTED",
    deliveryState: "NOT_STARTED",
    currentState: "AWAITING_SIGNATURE",
    timestamps: {
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    evidence: [
      {
        operationId,
        phase: "DISCOVERY",
        event: "PAYMENT_REQUIREMENT_RECEIVED",
        timestamp: 1_700_000_000_000,
        payload: {
          requirement: {
            amount: "1000000",
            asset,
            network: "base-sepolia",
            payee: payTo,
          },
        },
      },
    ],
  };
}

function intentFixture(): DurablePaymentIntent {
  return {
    paymentIntentId,
    operationId,
    requestId,
    authorizer,
    payTo,
    value: "1000000",
    asset,
    network: "base-sepolia",
    nonce,
    validAfter,
    validBefore,
    paymentPayload: "",
    paymentPayloadHash: keccak256(toBytes("")),
    settlementState: "PENDING_SIGNATURE",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function makeStore() {
  let intent = intentFixture();
  let operation = operationFixture();
  const store: Partial<DurableEvidenceStore> & {
    getPaymentIntentByRequestId: (id: string) => Promise<DurablePaymentIntent | null>;
    getOperationByRequestId: (id: string) => Promise<Operation | null>;
  } = {
    async getPaymentIntentByRequestId(id) {
      return id === requestId ? { ...intent } : null;
    },
    async getPaymentIntentByOperationId(id) {
      return id === operationId ? { ...intent } : null;
    },
    async getOperationByRequestId(id) {
      return id === requestId ? operation : null;
    },
    async updatePaymentIntentAuthorization(id, fields) {
      if (id !== paymentIntentId) throw new Error("unexpected payment intent");
      intent = { ...intent, ...fields };
    },
    async updatePaymentIntentStatus(id, status) {
      if (id !== paymentIntentId) throw new Error("unexpected payment intent");
      intent = { ...intent, settlementState: status };
    },
    async markNonceSigned(value) {
      if (value !== nonce) throw new Error("unexpected nonce");
    },
    async saveOperation(value) {
      operation = value;
    },
    async append(_record: EvidenceRecord) {},
    readIntent: () => intent,
    readOperation: () => operation,
  };
  return store as DurableEvidenceStore & {
    getPaymentIntentByRequestId: (id: string) => Promise<DurablePaymentIntent | null>;
    getOperationByRequestId: (id: string) => Promise<Operation | null>;
    readIntent: () => DurablePaymentIntent;
    readOperation: () => Operation;
  } & Record<string, unknown>;
}

async function signedPayload(): Promise<PaymentPayload> {
  const signature = await account.signTypedData({
    domain,
    types: EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorizer,
      to: payTo,
      value: BigInt("1000000"),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "base-sepolia",
      amount: "1000000",
      asset,
      payTo,
      maxTimeoutSeconds: validBefore - validAfter,
    },
    payload: {
      signature,
      authorization: {
        from: authorizer,
        to: payTo,
        value: "1000000",
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
}

describe("Step 2D-2: public signed payment route", () => {
  let server: http.Server;
  let payload: PaymentPayload;
  let store: ReturnType<typeof makeStore>;
  let secretariat: Secretariat;
  let submitCalls: PaymentPayload[];

  beforeEach(async () => {
    payload = await signedPayload();
    store = makeStore();
    submitCalls = [];

    const settlementAdapter: SettlementAdapter = {
      async submit(_intent, submittedPayload) {
        submitCalls.push(submittedPayload);
        return {
          status: "SUBMITTED",
          txHash: "0xsubmitted",
          rawResponse: { accepted: true },
        };
      },
    };

    secretariat = new Secretariat({
      evidenceStore: store,
      adapters: new Map(),
      settlementAdapter,
      atomicSettlementHandoff: {
        async settleAndCreateExecutionObligation() {
          return true;
        },
      },
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    jest.restoreAllMocks();
  });

  async function startApp() {
    const { createRequestsRouter } = await import("../../api-server/src/routes/requests");
    const verifier = new Eip3009PaymentVerifier({ store, domain });
    const app = express();
    app.use(express.json());
    app.use("/v1", createRequestsRouter(secretariat, verifier));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    return `http://127.0.0.1:${address.port}`;
  }

  test("valid signed payment is verified and continues through canonical submission", async () => {
    const continuation = jest.spyOn(secretariat, "submitSignedPayment");
    const baseUrl = await startApp();

    const response = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      requestId,
      status: "PROCESSING",
      paymentRequired: {
        amount: "1000000",
        asset,
        network: "base-sepolia",
        payee: payTo,
      },
      settlementTxHash: "0xsubmitted",
      evidenceCount: expect.any(Number),
    });
    expect(body.operationId).toBeUndefined();
    expect(body.paymentIntentId).toBeUndefined();
    expect(continuation).toHaveBeenCalledTimes(1);
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0].payload.signature).toBe(payload.payload.signature);
    expect(store.readIntent?.().settlementState).toBe("AUTHORIZED");
  });

  test("invalid signature is rejected before submission and durable authorization", async () => {
    const baseUrl = await startApp();
    const invalidPayload = {
      ...payload,
      payload: { ...payload.payload, signature: "0x" + "11".repeat(65) },
    };

    const response = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalidPayload),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      error: {
        code: "INVALID_SIGNATURE",
        message: "The EIP-712 signature could not be verified",
        field: "signature",
      },
    });
    expect(submitCalls).toHaveLength(0);
    expect(store.readIntent?.().settlementState).toBe("PENDING_SIGNATURE");
    expect(store.readIntent?.().paymentPayload).toBe("");
  });

  test("binding mismatch is rejected without economic action", async () => {
    const baseUrl = await startApp();
    const mismatchedPayload = {
      ...payload,
      accepted: { ...payload.accepted, amount: "1000001" },
    };

    const response = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mismatchedPayload),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALUE_MISMATCH");
    expect(submitCalls).toHaveLength(0);
    expect(store.readIntent?.().settlementState).toBe("PENDING_SIGNATURE");
  });

  test("identical retry is idempotent and does not submit twice", async () => {
    const baseUrl = await startApp();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };

    const first = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, request);
    const second = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(submitCalls).toHaveLength(1);
  });

  test("changed payload retry is rejected after the request has been accepted", async () => {
    const baseUrl = await startApp();
    const first = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);

    const changedPayload = {
      ...payload,
      resource: { url: "https://seller.example.com/changed-resource" },
    };
    const second = await fetch(`${baseUrl}/v1/requests/${requestId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changedPayload),
    });
    const body = await second.json();

    expect(second.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "PAYMENT_PAYLOAD_RETRY_MISMATCH",
        message: "The payment payload does not match the previously accepted payload",
      },
    });
    expect(submitCalls).toHaveLength(1);
  });

  test("unknown request does not enter the canonical continuation", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/v1/requests/missing-request/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "REQUEST_NOT_FOUND",
        message: "The request was not found",
      },
    });
    expect(submitCalls).toHaveLength(0);
  });
});