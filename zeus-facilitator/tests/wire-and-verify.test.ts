/**
 * Wire + verification contract tests for the Zeus facilitator.
 * Hermetic: signatures are produced locally with viem; chain reads are fakes.
 */
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  verifyOffChain,
  verifyRequest,
  isAuthorizationUsed,
  getBalance,
} from "../src/verify.js";
import { RpcUnavailableError } from "../src/rpc.js";
import { FACILITATOR_NETWORKS } from "../src/config.js";
import type { CanonicalPaymentPayload, CanonicalPaymentRequirements, FacilitatorRequest } from "../src/types.js";
import {
  buildSignedRequest,
  fakeRpc,
  NETWORK,
  SELLER,
  TEST_OTHER_KEY,
  TEST_PAYER_KEY,
} from "./helpers.js";

describe("verifyOffChain (structural + domain + EIP-712 recovery)", () => {
  it("accepts a canonically signed v2 request and reports the payer", async () => {
    const { request, payer } = await buildSignedRequest();
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.payer.toLowerCase()).toBe(payer.toLowerCase());
      expect(outcome.authorization.value).toBe(1_000_000n);
    }
  });

  it("rejects x402Version other than 1/2", async () => {
    const { request } = await buildSignedRequest({ x402Version: 3 });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "x402_version_mismatch" });
  });

  it("rejects non-exact schemes", async () => {
    const { request } = await buildSignedRequest({ scheme: "uptoken" });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "unsupported_scheme" });
  });

  it("rejects a network the facilitator does not serve", async () => {
    const { request } = await buildSignedRequest({ network: "eip155:8453" });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "network_mismatch" });
  });

  it("rejects a foreign asset (F-113: token is pinned per network)", async () => {
    const foreign = ("0x" + "cd".repeat(20)) as `0x${string}`;
    const { request } = await buildSignedRequest({ asset: foreign });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "asset_mismatch" });
  });

  it("requires the F-113 domain binding (extra.name/.version) on requirements", async () => {
    const { request } = await buildSignedRequest({ omitExtra: true });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "domain_binding_missing" });
  });

  it("rejects a wrong extra domain", async () => {
    const { request } = await buildSignedRequest({ extraName: "Bridged USDC" });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "domain_mismatch" });
  });

  it("rejects when authorization.value != requirements.amount", async () => {
    const { request } = await buildSignedRequest({ valueOverride: "999" });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "amount_mismatch" });
  });

  it("rejects a payTo mismatch between requirements and authorization", async () => {
    const other = ("0x" + "ef".repeat(20)) as `0x${string}`;
    const { request } = await buildSignedRequest({ payTo: other });
    // authorization.to == requirements.payTo both = other, signature consistent →
    // still valid structurally; flip requirements payTo only:
    request.paymentRequirements.payTo = NETWORK.usdc;
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "pay_to_mismatch" });
  });

  it("rejects expired and not-yet-valid authorizations", async () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expired = await buildSignedRequest({ validBefore: nowSec - 10n });
    expect(await verifyOffChain(expired.request, NETWORK, Date.now())).toMatchObject({
      ok: false,
      reason: "authorization_window",
    });
    const future = await buildSignedRequest({ validAfter: nowSec + 600n });
    expect(await verifyOffChain(future.request, NETWORK, Date.now())).toMatchObject({
      ok: false,
      reason: "authorization_window",
    });
  });

  it("rejects a signature made by a different key (payer != signer)", async () => {
    const { request } = await buildSignedRequest({ signWith: TEST_OTHER_KEY });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a tampered signature", async () => {
    const { request } = await buildSignedRequest({ tamperSignature: true });
    const outcome = await verifyOffChain(request, NETWORK, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("serves the registry networks only (eip155:84532 staging exists)", () => {
    expect(Object.keys(FACILITATOR_NETWORKS).sort()).toEqual(["eip155:196", "eip155:84532"]);
    expect(FACILITATOR_NETWORKS["eip155:84532"].testnet).toBe(true);
    expect(FACILITATOR_NETWORKS["eip155:196"].usdc.toLowerCase()).toBe(
      "0x74b7f16337b8972027f6196a17a631ac6de26d22",
    );
  });

  it("pins per-network USDC EIP-712 domains exactly as verified on-chain", () => {
    // eip155:196 (X Layer, D1): live DOMAIN_SEPARATOR matches "USD Coin"/"2".
    expect(FACILITATOR_NETWORKS["eip155:196"].domain).toEqual({ name: "USD Coin", version: "2" });
    // eip155:84532 (Base Sepolia): live DOMAIN_SEPARATOR() of
    // 0x036CbD…CF7e == keccak("USDC")/"2"/84532/contract — Circle initialized
    // this instance with name "USDC", NOT "USD Coin" (which is the X Layer /
    // Base-mainnet value); official x402 SDK chain config agrees. A previous
    // version pinned "USD Coin" here, which would break every verification.
    expect(FACILITATOR_NETWORKS["eip155:84532"].domain).toEqual({ name: "USDC", version: "2" });
  });
});

describe("official x402 v1 envelope (the wire x402-express@1.x actually speaks)", () => {
  const net = FACILITATOR_NETWORKS["eip155:84532"];
  const V1_TYPES = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  /** Mirrors exactly what x402-express@1.2.0 + x402@1.2.0 emit on the wire. */
  async function buildV1Request(opts: { network?: string; payloadVersion?: number } = {}) {
    const payer = privateKeyToAccount(TEST_PAYER_KEY).address;
    const message = {
      from: payer,
      to: SELLER,
      value: 1000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: ("0x" + "22".repeat(32)) as Hex,
    };
    const signature = await privateKeyToAccount(TEST_PAYER_KEY).signTypedData({
      domain: { name: net.domain.name, version: net.domain.version, chainId: net.chainId, verifyingContract: net.usdc },
      types: V1_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    const request = {
      x402Version: 1,
      paymentPayload: {
        x402Version: opts.payloadVersion ?? 1,
        scheme: "exact",
        network: opts.network ?? "base-sepolia",
        payload: {
          signature,
          authorization: {
            from: message.from,
            to: message.to,
            value: message.value.toString(),
            validAfter: message.validAfter.toString(),
            validBefore: message.validBefore.toString(),
            nonce: message.nonce,
          },
        },
      } as unknown as CanonicalPaymentPayload,
      paymentRequirements: {
        scheme: "exact",
        network: opts.network ?? "base-sepolia",
        maxAmountRequired: "1000",
        resource: "http://127.0.0.1:4021/data",
        description: "Zeus testnet probe resource",
        mimeType: "",
        payTo: SELLER,
        maxTimeoutSeconds: 60,
        asset: net.usdc,
        extra: { name: net.domain.name, version: net.domain.version },
      } as unknown as CanonicalPaymentRequirements,
    };
    return { request: request as FacilitatorRequest, payer };
  }

  it("accepts the official v1 envelope and aliases base-sepolia -> eip155:84532", async () => {
    const { request, payer } = await buildV1Request();
    const outcome = await verifyOffChain(request, net, Date.now());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.payer.toLowerCase()).toBe(payer.toLowerCase());
  });

  it("rejects a v1 envelope whose payload version disagrees", async () => {
    const { request } = await buildV1Request({ payloadVersion: 2 });
    const outcome = await verifyOffChain(request, net, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "x402_version_mismatch" });
  });

  it("rejects a v1 envelope naming an unknown network", async () => {
    const { request } = await buildV1Request({ network: "polygon" });
    const outcome = await verifyOffChain(request, net, Date.now());
    expect(outcome).toMatchObject({ ok: false, reason: "x402_version_mismatch" });
  });
});

describe("verifyRequest (adds on-chain state via injected RPC)", () => {
  it("rejects an authorization whose nonce is already spent on-chain", async () => {
    const { request } = await buildSignedRequest();
    const rpc = fakeRpc({
      async call() {
        return "0x" + "00".repeat(31) + "01"; // authorizationState -> true
      },
    });
    const outcome = await verifyRequest(request, NETWORK, rpc, { checkPayerBalance: false });
    expect(outcome).toMatchObject({ ok: false, reason: "authorization_already_used" });
  });

  it("rejects when payer balance is below the value", async () => {
    const { request } = await buildSignedRequest();
    const rpc = fakeRpc({
      async call(_to, data) {
        // balanceOf -> 1 atomic unit; authorizationState stays false
        if (data.startsWith(toFunctionSelector("balanceOf(address)"))) {
          return "0x" + "00".repeat(31) + "01";
        }
        return "0x" + "00".repeat(64);
      },
    });
    const outcome = await verifyRequest(request, NETWORK, rpc, { checkPayerBalance: true });
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient_payer_balance" });
  });

  it("maps RPC failure to RpcUnavailableError (503 upstream, never a verdict)", async () => {
    const { request } = await buildSignedRequest();
    const rpc = fakeRpc({
      async call() {
        throw new Error("connection refused");
      },
    });
    await expect(
      verifyRequest(request, NETWORK, rpc, { checkPayerBalance: true }),
    ).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it("encodes authorizationState with the correct selector and arguments", async () => {
    const { request, payer } = await buildSignedRequest();
    const rpc = fakeRpc();
    await isAuthorizationUsed(rpc, NETWORK.usdc, payer, ("0x" + "11".repeat(32)) as `0x${string}`);
    const call = rpc.calls[0];
    expect(call.to.toLowerCase()).toBe(NETWORK.usdc.toLowerCase());
    // keccak("authorizationState(address,bytes32)") = 0xe94a0102 (pinned regression)
    expect(toFunctionSelector("authorizationState(address,bytes32)")).toBe("0xe94a0102");
    expect(call.data.startsWith("0xe94a0102")).toBe(true);
    expect(call.data).toHaveLength(138);
    expect(call.data.endsWith("11".repeat(32))).toBe(true); // nonce word last
  });

  it("reads balanceOf(payer)", async () => {
    const { payer } = await buildSignedRequest();
    const rpc = fakeRpc({
      async call(_to, data) {
        if (data.startsWith(toFunctionSelector("balanceOf(address)"))) {
          return "0x" + "00".repeat(30) + "0f4240"; // 1e6
        }
        return "0x" + "00".repeat(64);
      },
    });
    const balance = await getBalance(rpc, NETWORK.usdc, payer);
    expect(balance).toBe(1_000_000n);
  });
});
