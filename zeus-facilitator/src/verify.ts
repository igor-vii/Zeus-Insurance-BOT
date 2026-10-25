/**
 * Zeus facilitator — verification pipeline (canonical x402 v2, EIP-3009).
 *
 * Order matters: cheap structural checks first, then domain binding (F-113
 * rule: v2 EVM payloads MUST carry accepted.extra.name/.version and they
 * MUST equal the network's pinned domain), then the cryptographic recovery,
 * then on-chain state (nonce unused, balance sufficient).
 */
import { parseSignature, recoverTypedDataAddress, toFunctionSelector, type Address, type Hex } from "viem";
import type { FacilitatorNetwork } from "./config.js";
import { RpcUnavailableError } from "./rpc.js";
import type { ChainRpc } from "./rpc.js";
import type {
  CanonicalPaymentPayload,
  CanonicalPaymentRequirements,
  FacilitatorRequest,
} from "./types.js";

export const EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** FiatToken used-nonce view — selector computed, never hardcoded. */
const AUTHORIZATION_STATE_SELECTOR = toFunctionSelector("authorizationState(address,bytes32)");
const BALANCE_OF_SELECTOR = toFunctionSelector("balanceOf(address)");

export type VerifyFailureReason =
  | "malformed_request"
  | "unsupported_scheme"
  | "network_mismatch"
  | "unsupported_network"
  | "asset_mismatch"
  | "pay_to_mismatch"
  | "amount_mismatch"
  | "x402_version_mismatch"
  | "domain_binding_missing"
  | "domain_mismatch"
  | "authorization_mismatch"
  | "authorization_window"
  | "invalid_signature"
  | "authorization_already_used"
  | "insufficient_payer_balance";

export type VerifyOutcome =
  | { readonly ok: true; readonly payer: Address; readonly authorization: VerifiedAuthorization }
  | { readonly ok: false; readonly reason: VerifyFailureReason; readonly detail: string };

export interface VerifiedAuthorization {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}

function fail(reason: VerifyFailureReason, detail: string): VerifyOutcome {
  return { ok: false, reason, detail };
}

function asNonNegativeInt(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Structural + domain + signature verification (no chain access).
 * Kept separate from the on-chain checks so tests can exercise the
 * cryptographic part hermetically.
 */
export async function verifyOffChain(
  request: FacilitatorRequest,
  network: FacilitatorNetwork,
  nowMs: number,
): Promise<VerifyOutcome> {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof (request as Partial<FacilitatorRequest>).x402Version !== "number" ||
    typeof (request as Partial<FacilitatorRequest>).paymentPayload !== "object" ||
    typeof (request as Partial<FacilitatorRequest>).paymentRequirements !== "object"
  ) {
    return fail("malformed_request", "request must be {x402Version, paymentPayload, paymentRequirements}");
  }
  const payload = request.paymentPayload;
  const requirements = request.paymentRequirements;

  if (request.x402Version !== 2 || payload.x402Version !== 2) {
    return fail("x402_version_mismatch", "facilitator serves x402Version=2 only");
  }
  if (requirements.scheme !== "exact" || payload.accepted.scheme !== "exact") {
    return fail("unsupported_scheme", "only the exact scheme is supported (EIP-3009)");
  }
  if (requirements.network !== network.id || payload.accepted.network !== network.id) {
    return fail(
      "network_mismatch",
      `requirements.network=${requirements.network} payload.accepted.network=${payload.accepted.network} facilitator serves ${network.id}`,
    );
  }

  // Asset: requirements must point at the registry token.
  if (!isAddress(requirements.asset) || requirements.asset.toLowerCase() !== network.usdc.toLowerCase()) {
    return fail("asset_mismatch", `asset ${requirements.asset} != network USDC ${network.usdc}`);
  }
  if (!isAddress(payload.accepted.asset) || payload.accepted.asset.toLowerCase() !== network.usdc.toLowerCase()) {
    return fail("asset_mismatch", `payload asset ${payload.accepted.asset} != network USDC ${network.usdc}`);
  }

  // F-113: v2 EVM domain binding is REQUIRED and must equal the pinned domain.
  const reqExtraName = requirements.extra?.["name"];
  const reqExtraVersion = requirements.extra?.["version"];
  if (typeof reqExtraName !== "string" || reqExtraName === "" || typeof reqExtraVersion !== "string" || reqExtraVersion === "") {
    return fail("domain_binding_missing", "paymentRequirements.extra.name/.version are required for v2 EVM");
  }
  if (reqExtraName !== network.domain.name || reqExtraVersion !== network.domain.version) {
    return fail(
      "domain_mismatch",
      `extra domain (${reqExtraName}/${reqExtraVersion}) != pinned (${network.domain.name}/${network.domain.version})`,
    );
  }
  const payloadExtraName = payload.accepted.extra?.name;
  const payloadExtraVersion = payload.accepted.extra?.version;
  if (
    (payloadExtraName !== undefined && payloadExtraName !== network.domain.name) ||
    (payloadExtraVersion !== undefined && payloadExtraVersion !== network.domain.version)
  ) {
    return fail("domain_mismatch", "payload.accepted.extra domain disagrees with the pinned domain");
  }

  // Economic fields: amount == value, payTo == to, both parties consistent.
  const amount = asNonNegativeInt(requirements.amount);
  if (amount === null || amount <= 0n) {
    return fail("amount_mismatch", `amount ${String(requirements.amount)} must be a positive integer string`);
  }
  if (!isAddress(requirements.payTo)) return fail("pay_to_mismatch", "requirements.payTo must be an address");
  if (requirements.payTo.toLowerCase() !== payload.accepted.payTo?.toLowerCase()) {
    return fail("pay_to_mismatch", "requirements.payTo != payload.accepted.payTo");
  }

  const auth = payload.payload?.authorization;
  if (
    !auth ||
    !isAddress(auth.from) ||
    !isAddress(auth.to) ||
    !isBytes32(auth.nonce) ||
    typeof auth.value !== "string" ||
    typeof auth.validAfter !== "string" ||
    typeof auth.validBefore !== "string"
  ) {
    return fail("malformed_request", "payload.payload.authorization is incomplete or malformed");
  }
  const value = asNonNegativeInt(auth.value);
  const validAfter = asNonNegativeInt(auth.validAfter);
  const validBefore = asNonNegativeInt(auth.validBefore);
  if (value === null || validAfter === null || validBefore === null) {
    return fail("malformed_request", "authorization value/validAfter/validBefore must be integer strings");
  }
  if (value !== amount) return fail("amount_mismatch", "authorization.value != requirements.amount");
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return fail("authorization_mismatch", "authorization.to != payTo");
  }

  // Time window: now in [validAfter, validBefore); allow zero validAfter.
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  if (validBefore <= nowSec) return fail("authorization_window", "authorization already expired (validBefore <= now)");
  if (validAfter > nowSec) return fail("authorization_window", "authorization not yet valid (validAfter > now)");

  // Signature: recover the EIP-712 signer and compare with authorization.from.
  const signature = payload.payload?.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return fail("invalid_signature", "signature must be a 65-byte 0x-hex string");
  }
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: network.domain.name,
        version: network.domain.version,
        chainId: network.chainId,
        verifyingContract: network.usdc,
      },
      types: EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: value,
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: auth.nonce,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    return fail("invalid_signature", `recovery failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return fail("invalid_signature", `recovered ${recovered} != authorization.from ${auth.from}`);
  }

  return {
    ok: true,
    payer: recovered,
    authorization: { from: auth.from, to: auth.to, value, validAfter, validBefore, nonce: auth.nonce },
  };
}

function encodeUint(value: bigint): Hex {
  return ("0x" + value.toString(16).padStart(64, "0")) as Hex;
}

function encodeAddress(address: Address): Hex {
  return ("0x" + address.toLowerCase().slice(2).padStart(64, "0")) as Hex;
}

/** authorizationState(authorizer, nonce) — true when the nonce is spent. */
export async function isAuthorizationUsed(
  rpc: ChainRpc,
  usdc: Address,
  authorizer: Address,
  nonce: Hex,
): Promise<boolean> {
  const data = (AUTHORIZATION_STATE_SELECTOR + encodeAddress(authorizer).slice(2) + nonce.slice(2)) as Hex;
  const raw = await rpc.call(usdc, data);
  return BigInt(raw) !== 0n;
}

/** balanceOf(payer) in atomic units. */
export async function getBalance(rpc: ChainRpc, usdc: Address, payer: Address): Promise<bigint> {
  const data = (BALANCE_OF_SELECTOR + encodeAddress(payer).slice(2)) as Hex;
  const raw = await rpc.call(usdc, data);
  return BigInt(raw);
}

/**
 * Full verification incl. on-chain state. Returns the structured failure the
 * server maps onto {isValid:false, invalidReason} / {success:false, errorReason}.
 */
export async function verifyRequest(
  request: FacilitatorRequest,
  network: FacilitatorNetwork,
  rpc: ChainRpc,
  options: { nowMs?: number; checkPayerBalance: boolean },
): Promise<VerifyOutcome> {
  const offChain = await verifyOffChain(request, network, options.nowMs ?? Date.now());
  if (!offChain.ok) return offChain;
  const { authorization } = offChain;

  try {
    if (await isAuthorizationUsed(rpc, network.usdc, authorization.from, authorization.nonce)) {
      return fail("authorization_already_used", `nonce ${authorization.nonce} is spent on-chain`);
    }
    if (options.checkPayerBalance) {
      const balance = await getBalance(rpc, network.usdc, authorization.from);
      if (balance < authorization.value) {
        return fail("insufficient_payer_balance", `balance ${balance} < value ${authorization.value}`);
      }
    }
  } catch (err) {
    // RPC trouble is NOT a verification verdict — surface as infrastructure
    // error so the server answers 503 (ambiguous, client goes RECONCILING).
    throw new RpcUnavailableError(
      `on-chain verification unavailable: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  return offChain;
}

/** Split the 65-byte EIP-3009 signature into v/r/s for transferWithAuthorization. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const parsed = parseSignature(signature);
  if (parsed.r === undefined || parsed.s === undefined || parsed.v === undefined) {
    throw new Error("signature is missing r/s/v components");
  }
  return { v: Number(parsed.v), r: parsed.r, s: parsed.s };
}

export type { CanonicalPaymentPayload, CanonicalPaymentRequirements };
