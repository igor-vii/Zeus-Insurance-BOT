/**
 * Shared test helpers — hermetic (no network, no DB).
 * TEST-ONLY keys, clearly named; never use in production.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { ChainRpc } from "../src/rpc.js";
import type { FacilitatorRequest } from "../src/types.js";
import { FACILITATOR_NETWORKS } from "../src/config.js";

export const TEST_PAYER_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // TEST-ONLY
export const TEST_OTHER_KEY: Hex =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // TEST-ONLY
export const TEST_GAS_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // TEST-ONLY (unit, offline)

export const NETWORK = FACILITATOR_NETWORKS["eip155:196"];

export function fakeRpc(overrides: Partial<ChainRpc> = {}): ChainRpc & { calls: { to: Address; data: string }[]; sentTxs: string[] } {
  const self: ChainRpc & { calls: { to: Address; data: string }[]; sentTxs: string[] } = {
    calls: [],
    sentTxs: [],
    async call(to, data) {
      self.calls.push({ to, data });
      // default: authorizationState=false (0x00…0), balance=1e9 (1000 USDC)
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    },
    async getTransactionCount() {
      return 7;
    },
    async estimateGas() {
      return 120_000n;
    },
    async suggestFees() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
    },
    async sendRawTransaction(signedTx) {
      self.sentTxs.push(signedTx);
      return ("0xtx" + String(self.sentTxs.length).padStart(62, "0")) as Hex;
    },
    async waitForReceipt(hash) {
      void hash;
      return { status: "success" as const };
    },
  };
  return Object.assign(self, overrides);
}

export interface SignedRequestOptions {
  /** Sign with a different key (payer != signer). */
  signWith?: Hex;
  validAfter?: bigint;
  validBefore?: bigint;
  amount?: string;
  payTo?: Address;
  extraName?: string;
  extraVersion?: string;
  omitExtra?: boolean;
  network?: string;
  asset?: Address;
  x402Version?: number;
  nonce?: Hex;
  valueOverride?: string;
  tamperSignature?: boolean;
  scheme?: string;
}

export const SELLER: Address = ("0x" + "ab".repeat(20)) as Address; // deterministic test sink

export async function buildSignedRequest(opts: SignedRequestOptions = {}): Promise<{
  request: FacilitatorRequest;
  payer: Address;
}> {
  // The authorization identity (from) is ALWAYS the TEST_PAYER_KEY address;
  // `signWith` lets tests bind it to a DIFFERENT signing key (payer != signer).
  const payer = privateKeyToAccount(TEST_PAYER_KEY).address;
  const signingAccount = privateKeyToAccount(opts.signWith ?? TEST_PAYER_KEY);
  const network = opts.network ?? NETWORK.id;
  const asset = opts.asset ?? NETWORK.usdc;
  const amount = opts.amount ?? "1000000";
  const payTo = opts.payTo ?? SELLER;
  const validAfter = opts.validAfter ?? 0n;
  const validBefore = opts.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = (opts.nonce ?? ("0x" + "11".repeat(32))) as Hex;
  const value = opts.valueOverride ?? amount;

  const message = {
    from: payer,
    to: payTo,
    value: BigInt(value),
    validAfter,
    validBefore,
    nonce,
  };
  const signature = await signingAccount.signTypedData({
    domain: {
      name: NETWORK.domain.name,
      version: NETWORK.domain.version,
      chainId: NETWORK.chainId,
      verifyingContract: NETWORK.usdc,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message,
  });

  const request: FacilitatorRequest = {
    x402Version: opts.x402Version ?? 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://api.zeus.example/v1/prepare-buy" },
      accepted: {
        scheme: opts.scheme ?? "exact",
        network,
        amount,
        asset,
        payTo,
        maxTimeoutSeconds: 60,
        extra: opts.omitExtra
          ? undefined
          : { assetTransferMethod: "eip3009", name: opts.extraName ?? NETWORK.domain.name, version: opts.extraVersion ?? NETWORK.domain.version },
      },
      payload: {
        signature: opts.tamperSignature
          ? ((signature.slice(0, -4) + "dead") as Hex)
          : signature,
        authorization: {
          from: payer,
          to: payTo,
          value,
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    },
    paymentRequirements: {
      scheme: opts.scheme ?? "exact",
      network,
      asset,
      amount,
      payTo,
      maxTimeoutSeconds: 60,
      resource: { url: "https://api.zeus.example/v1/prepare-buy" },
      extra: opts.omitExtra
        ? undefined
        : { name: opts.extraName ?? NETWORK.domain.name, version: opts.extraVersion ?? NETWORK.domain.version },
    },
  };
  return { request, payer };
}
