import type {
  ExecuteRequest,
  PaymentPolicy,
  PaymentSigner,
} from "../src/core/types";
import { Secretariat } from "../src/core/state-machine";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("Step 2A: Stage-A primitive production persistence", () => {
  let db: any;
  let store: any;
  let originalFetch: typeof globalThis.fetch;
  let signerAddressCalls = 0;
  const operationIds: string[] = [];

  const request: ExecuteRequest = {
    target: "https://step-2a-seller.example.com/api",
    method: "POST",
    policy: {
      maxPrice: "1000000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: ["0xUSDC"],
      authorizationMode: "policy-bound",
    } satisfies PaymentPolicy,
    requestId: `req-step-2a-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    clientId: `client-step-2a-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    authorizer: "0x00000000000000000000000000000000000000a1",
  };

  const signer: PaymentSigner = {
    signerType: "STEP_2A_TEST",
    async getAddress() {
      signerAddressCalls++;
      throw new Error("Stage A must not obtain an address from the signer");
    },
    async signPayment() {
      throw new Error("Stage A must not sign");
    },
  };

  beforeAll(async () => {
    const dbModule = await import("@workspace/db");
    db = dbModule.db;
    store = new dbModule.PostgresEvidenceStore(db);
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      accepts: [{
        scheme: "exact",
        network: "base-sepolia",
        asset: "0xUSDC",
        amount: "1000000",
        payTo: "0x00000000000000000000000000000000000000b2",
        maxTimeoutSeconds: 300,
      }],
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const operationId of operationIds) {
      await db.execute(`DELETE FROM nonce_registry WHERE operation_id = '${operationId}'`).catch(() => {});
      await db.execute(`DELETE FROM payment_intents WHERE operation_id = '${operationId}'`).catch(() => {});
    }
  });

  test("persists the pending DPI and reuses it for an idempotent retry", async () => {
    const secretariat = new Secretariat({
      evidenceStore: store,
      signer,
      adapters: new Map(),
    } as any);

    const first = await secretariat.createRequest(request);
    expect(first.status).toBe("AWAITING_PAYMENT_SIGNATURE");
    if (first.status !== "AWAITING_PAYMENT_SIGNATURE") return;
    operationIds.push(first.operationId);

    expect(first.paymentIntent.settlementState).toBe("PENDING_SIGNATURE");
    expect(first.paymentIntent.authorizer).toBe(request.authorizer);
    expect(first.paymentIntent.payTo).toBe("0x00000000000000000000000000000000000000b2");
    expect(first.paymentIntent.value).toBe("1000000");
    expect(first.paymentIntent.asset).toBe("0xUSDC");
    expect(first.paymentIntent.network).toBe("base-sepolia");
    expect(first.paymentIntent.nonce).toMatch(/^0x[0-9a-f]+$/i);

    const persisted = await store.getPaymentIntentByOperationId(first.operationId);
    expect(persisted).not.toBeNull();
    expect(persisted!.settlementState).toBe("PENDING_SIGNATURE");
    expect(persisted!.nonce).toBe(first.paymentIntent.nonce);
    expect(persisted!.authorizer).toBe(request.authorizer);
    expect(persisted!.requestId).toBe(request.requestId);
    expect(persisted!.clientId).toBe(request.clientId);

    const second = await secretariat.createRequest(request);
    expect(second.status).toBe("AWAITING_PAYMENT_SIGNATURE");
    if (second.status !== "AWAITING_PAYMENT_SIGNATURE") return;
    expect(second.operationId).toBe(first.operationId);
    expect(second.paymentIntent.paymentIntentId).toBe(first.paymentIntent.paymentIntentId);
    expect(second.paymentIntent.nonce).toBe(first.paymentIntent.nonce);
    expect(signerAddressCalls).toBe(0);
  });
});