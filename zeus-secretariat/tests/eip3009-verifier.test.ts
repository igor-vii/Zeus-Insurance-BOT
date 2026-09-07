import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  Eip3009PaymentVerifier,
  EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
  type DurablePaymentIntent,
  type Eip3009Domain,
  type PaymentPayload,
  type PaymentIntentByRequestIdStore,
} from "../src";

const account = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
const otherAccount = privateKeyToAccount(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
);

const DOMAIN: Eip3009Domain = {
  name: "USD Coin",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x1111111111111111111111111111111111111111",
};

const INTENT: DurablePaymentIntent = {
  paymentIntentId: "pi-verifier",
  operationId: "op-verifier",
  requestId: "req-verifier",
  authorizer: account.address,
  payTo: "0x2222222222222222222222222222222222222222",
  value: "1000000",
  asset: DOMAIN.verifyingContract,
  network: "base-sepolia",
  nonce: "0x" + "ab".repeat(32),
  validAfter: 1_700_000_000,
  validBefore: 1_700_003_600,
  paymentPayload: "",
  paymentPayloadHash: "",
  settlementState: "PENDING_SIGNATURE",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

class TestPaymentIntentStore implements PaymentIntentByRequestIdStore {
  readonly getPaymentIntentByRequestId = jest.fn(async (requestId: string) =>
    requestId === INTENT.requestId ? INTENT : null,
  );
}

function makeStore(): TestPaymentIntentStore {
  return new TestPaymentIntentStore();
}

async function makePayload(
  overrides: Partial<PaymentPayload["accepted"]> & {
    authorization?: Partial<PaymentPayload["payload"]["authorization"]>;
    signature?: Hex;
  } = {},
): Promise<PaymentPayload> {
  const authorization = {
    from: INTENT.authorizer,
    to: INTENT.payTo,
    value: INTENT.value,
    validAfter: String(INTENT.validAfter),
    validBefore: String(INTENT.validBefore),
    nonce: INTENT.nonce,
    ...overrides.authorization,
  };
  const signature = overrides.signature ?? await account.signTypedData({
    domain: DOMAIN,
    types: EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as Address,
      to: authorization.to as Address,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });

  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: INTENT.network,
      amount: INTENT.value,
      asset: INTENT.asset,
      payTo: INTENT.payTo,
      maxTimeoutSeconds: INTENT.validBefore - INTENT.validAfter,
      extra: { name: DOMAIN.name, version: DOMAIN.version },
      ...overrides,
    },
    payload: { signature, authorization },
  };
}

function verifier(store = makeStore()): Eip3009PaymentVerifier {
  return new Eip3009PaymentVerifier({ store, domain: DOMAIN });
}

describe("EIP-3009 external payment verification primitive", () => {
  test("returns VALID for a real EIP-712 signature bound to the persisted DPI", async () => {
    const result = await verifier().verify(INTENT.requestId!, await makePayload());

    expect(result).toEqual({
      status: "VALID",
      code: "VALID",
      requestId: INTENT.requestId,
      paymentIntentId: INTENT.paymentIntentId,
      authorizer: INTENT.authorizer,
    });
  });

  test.each([
    ["network", { network: "base" }, "NETWORK_MISMATCH"],
    ["asset", { asset: "0x3333333333333333333333333333333333333333" }, "ASSET_MISMATCH"],
    ["value", { amount: "1000001" }, "VALUE_MISMATCH"],
    ["payTo", { payTo: "0x4444444444444444444444444444444444444444" }, "PAY_TO_MISMATCH"],
  ])("rejects a changed persisted accepted.%s binding", async (_field, change, code) => {
    const result = await verifier().verify(INTENT.requestId!, await makePayload(change));
    expect(result.status).toBe("INVALID");
    expect(result).toMatchObject({ code });
  });

  test("rejects changed EIP-712 domain metadata", async () => {
    const result = await verifier().verify(
      INTENT.requestId!,
      await makePayload({ extra: { name: "Not USD Coin", version: DOMAIN.version } }),
    );

    expect(result).toMatchObject({
      status: "INVALID",
      code: "DOMAIN_MISMATCH",
      field: "domain",
    });
  });

  test.each([
    ["authorizer", { from: otherAccount.address }, "AUTHORIZER_MISMATCH"],
    ["payTo", { to: "0x4444444444444444444444444444444444444444" }, "PAY_TO_MISMATCH"],
    ["value", { value: "1000001" }, "VALUE_MISMATCH"],
    ["nonce", { nonce: "0x" + "cd".repeat(32) }, "NONCE_MISMATCH"],
    ["validAfter", { validAfter: "1700000001" }, "VALID_AFTER_MISMATCH"],
    ["validBefore", { validBefore: "1700003601" }, "VALID_BEFORE_MISMATCH"],
  ])("rejects a changed persisted authorization.%s binding", async (_field, change, code) => {
    const result = await verifier().verify(
      INTENT.requestId!,
      await makePayload({ authorization: change }),
    );
    expect(result.status).toBe("INVALID");
    expect(result).toMatchObject({ code });
  });

  test("uses the persisted nonce and never accepts a newly generated nonce", async () => {
    const payload = await makePayload({
      authorization: { nonce: "0x" + "cd".repeat(32) },
    });
    const result = await verifier().verify(INTENT.requestId!, payload);

    expect(result).toMatchObject({
      status: "INVALID",
      code: "NONCE_MISMATCH",
      field: "nonce",
    });
  });

  test("rejects a cryptographically invalid signature after bindings match", async () => {
    const wrongSignature = await otherAccount.signTypedData({
      domain: DOMAIN,
      types: EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: INTENT.authorizer as Address,
        to: INTENT.payTo as Address,
        value: BigInt(INTENT.value),
        validAfter: BigInt(INTENT.validAfter),
        validBefore: BigInt(INTENT.validBefore),
        nonce: INTENT.nonce as `0x${string}`,
      },
    });
    const result = await verifier().verify(
      INTENT.requestId!,
      await makePayload({ signature: wrongSignature }),
    );

    expect(result).toMatchObject({
      status: "INVALID",
      code: "INVALID_SIGNATURE",
      field: "signature",
    });
  });

  test("does not call signer or facilitator and does not mutate the persisted intent", async () => {
    const signer = { signPayment: jest.fn() };
    const facilitator = { submit: jest.fn() };
    const store = makeStore();
    const before = JSON.stringify(INTENT);

    const result = await new Eip3009PaymentVerifier({ store, domain: DOMAIN })
      .verify(INTENT.requestId!, await makePayload());

    expect(result.status).toBe("VALID");
    expect(signer.signPayment).not.toHaveBeenCalled();
    expect(facilitator.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(INTENT)).toBe(before);
    expect(store.getPaymentIntentByRequestId).toHaveBeenCalledWith(INTENT.requestId);
  });
});