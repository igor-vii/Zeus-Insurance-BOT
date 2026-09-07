import {
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { DurablePaymentIntent } from "./types";
import type { PaymentPayload } from "../adapters/x402-facilitator-client";

/**
 * EIP-3009 TransferWithAuthorization typed-data definition.
 *
 * Keep this definition local to the verifier so the verification primitive
 * cannot accidentally inherit signer or settlement behavior.
 */
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

export interface Eip3009Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number | bigint;
  readonly verifyingContract: Address;
}

export interface PaymentIntentByRequestIdStore {
  getPaymentIntentByRequestId(
    requestId: string,
  ): Promise<DurablePaymentIntent | null>;
}

export type Eip3009DomainResolver = (
  intent: DurablePaymentIntent,
) => Eip3009Domain | Promise<Eip3009Domain>;

export interface Eip3009PaymentVerifierConfig {
  readonly store: PaymentIntentByRequestIdStore;
  /**
   * The domain is selected from persisted intent context, never from an
   * untrusted external payload. A resolver is useful when networks use
   * different token domains.
   */
  readonly domain: Eip3009Domain | Eip3009DomainResolver;
}

export type Eip3009VerificationErrorCode =
  | "PERSISTED_INTENT_LOOKUP_UNAVAILABLE"
  | "REQUEST_NOT_FOUND"
  | "MALFORMED_PAYLOAD"
  | "X402_VERSION_MISMATCH"
  | "NETWORK_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "ASSET_MISMATCH"
  | "PAY_TO_MISMATCH"
  | "VALUE_MISMATCH"
  | "AUTHORIZER_MISMATCH"
  | "NONCE_MISMATCH"
  | "VALID_AFTER_MISMATCH"
  | "VALID_BEFORE_MISMATCH"
  | "INVALID_SIGNATURE";

export interface ValidEip3009Verification {
  readonly status: "VALID";
  readonly code: "VALID";
  readonly requestId: string;
  readonly paymentIntentId: string;
  readonly authorizer: string;
}

export interface InvalidEip3009Verification {
  readonly status: "INVALID";
  readonly code: Eip3009VerificationErrorCode;
  readonly requestId: string;
  readonly message: string;
  readonly field?: string;
}

export type Eip3009VerificationResult =
  | ValidEip3009Verification
  | InvalidEip3009Verification;

type Authorization = PaymentPayload["payload"]["authorization"];

function invalid(
  requestId: string,
  code: Eip3009VerificationErrorCode,
  message: string,
  field?: string,
): InvalidEip3009Verification {
  return { status: "INVALID", code, requestId, message, ...(field ? { field } : {}) };
}

function same(left: unknown, right: unknown): boolean {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function sameOptionalDomainValue(
  payloadValue: unknown,
  domainValue: string | number | bigint,
): boolean {
  return payloadValue === undefined || same(payloadValue, domainValue);
}

function payloadShapeIsValid(payload: unknown): payload is PaymentPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<PaymentPayload>;
  const authorization = candidate.payload?.authorization;
  return (
    candidate.x402Version === 2 &&
    !!candidate.accepted &&
    typeof candidate.accepted.network === "string" &&
    typeof candidate.accepted.amount === "string" &&
    typeof candidate.accepted.asset === "string" &&
    typeof candidate.accepted.payTo === "string" &&
    !!candidate.payload &&
    typeof candidate.payload.signature === "string" &&
    !!authorization &&
    typeof authorization.from === "string" &&
    typeof authorization.to === "string" &&
    typeof authorization.value === "string" &&
    typeof authorization.validAfter === "string" &&
    typeof authorization.validBefore === "string" &&
    typeof authorization.nonce === "string"
  );
}

function getDomainExtra(
  payload: PaymentPayload,
): Record<string, unknown> | undefined {
  const extra = payload.accepted.extra;
  return extra && typeof extra === "object" ? extra : undefined;
}

function checkBinding(
  requestId: string,
  payload: PaymentPayload,
  intent: DurablePaymentIntent,
  domain: Eip3009Domain,
): InvalidEip3009Verification | null {
  const authorization: Authorization = payload.payload.authorization;
  if (!same(payload.accepted.network, intent.network)) {
    return invalid(requestId, "NETWORK_MISMATCH", "accepted.network is not bound to the persisted network", "network");
  }
  if (!same(payload.accepted.asset, intent.asset)) {
    return invalid(requestId, "ASSET_MISMATCH", "accepted.asset is not bound to the persisted token", "asset");
  }
  if (!same(domain.verifyingContract, intent.asset) || !same(domain.verifyingContract, payload.accepted.asset)) {
    return invalid(requestId, "DOMAIN_MISMATCH", "EIP-712 verifyingContract is not bound to the persisted token/domain", "domain.verifyingContract");
  }
  if (!same(payload.accepted.payTo, intent.payTo)) {
    return invalid(requestId, "PAY_TO_MISMATCH", "accepted.payTo is not bound to the persisted payTo", "payTo");
  }
  if (!same(payload.accepted.amount, intent.value)) {
    return invalid(requestId, "VALUE_MISMATCH", "accepted.amount is not bound to the persisted value", "value");
  }
  if (!same(authorization.from, intent.authorizer)) {
    return invalid(requestId, "AUTHORIZER_MISMATCH", "authorization.from is not bound to the persisted authorizer", "authorizer");
  }
  if (!same(authorization.to, intent.payTo)) {
    return invalid(requestId, "PAY_TO_MISMATCH", "authorization.to is not bound to the persisted payTo", "payTo");
  }
  if (!same(authorization.value, intent.value)) {
    return invalid(requestId, "VALUE_MISMATCH", "authorization.value is not bound to the persisted value", "value");
  }
  if (!same(authorization.nonce, intent.nonce)) {
    return invalid(requestId, "NONCE_MISMATCH", "authorization.nonce must equal the persisted nonce", "nonce");
  }
  if (!Number.isSafeInteger(Number(authorization.validAfter)) || Number(authorization.validAfter) !== intent.validAfter) {
    return invalid(requestId, "VALID_AFTER_MISMATCH", "authorization.validAfter is not bound to the persisted validAfter", "validAfter");
  }
  if (!Number.isSafeInteger(Number(authorization.validBefore)) || Number(authorization.validBefore) !== intent.validBefore) {
    return invalid(requestId, "VALID_BEFORE_MISMATCH", "authorization.validBefore is not bound to the persisted validBefore", "validBefore");
  }

  const extra = getDomainExtra(payload);
  if (
    extra &&
    (!sameOptionalDomainValue(extra.name, domain.name) ||
      !sameOptionalDomainValue(extra.version, domain.version) ||
      !sameOptionalDomainValue(extra.chainId, domain.chainId) ||
      !sameOptionalDomainValue(extra.verifyingContract, domain.verifyingContract))
  ) {
    return invalid(requestId, "DOMAIN_MISMATCH", "payload domain metadata does not match the persisted domain", "domain");
  }
  return null;
}

export class Eip3009PaymentVerifier {
  private readonly store: PaymentIntentByRequestIdStore;
  private readonly domain: Eip3009Domain | Eip3009DomainResolver;

  constructor(config: Eip3009PaymentVerifierConfig) {
    this.store = config.store;
    this.domain = config.domain;
  }

  async verify(
    requestId: string,
    payload: unknown,
  ): Promise<Eip3009VerificationResult> {
    if (typeof this.store.getPaymentIntentByRequestId !== "function") {
      return invalid(
        requestId,
        "PERSISTED_INTENT_LOOKUP_UNAVAILABLE",
        "The configured store cannot load a payment intent by requestId",
      );
    }

    const intent = await this.store.getPaymentIntentByRequestId(requestId);
    if (!intent) {
      return invalid(requestId, "REQUEST_NOT_FOUND", "No persisted payment intent exists for requestId");
    }
    if (typeof payload !== "object" || payload === null) {
      return invalid(requestId, "MALFORMED_PAYLOAD", "The signed payment payload is not a canonical x402 V2 payload");
    }
    if ((payload as { x402Version?: unknown }).x402Version !== 2) {
      return invalid(requestId, "X402_VERSION_MISMATCH", "Only x402 V2 payment payloads are supported", "x402Version");
    }
    if (!payloadShapeIsValid(payload)) {
      return invalid(requestId, "MALFORMED_PAYLOAD", "The signed payment payload is not a canonical x402 V2 payload");
    }

    let domain: Eip3009Domain;
    try {
      domain = typeof this.domain === "function"
        ? await this.domain(intent)
        : this.domain;
    } catch {
      return invalid(requestId, "DOMAIN_MISMATCH", "The EIP-712 domain could not be resolved from persisted intent context", "domain");
    }

    const bindingError = checkBinding(requestId, payload, intent, domain);
    if (bindingError) return bindingError;

    if (!isAddress(payload.payload.authorization.from) ||
        !isAddress(payload.payload.authorization.to) ||
        !isAddress(domain.verifyingContract) ||
        !isHex(payload.payload.authorization.nonce) ||
        !isHex(payload.payload.signature)) {
      return invalid(requestId, "MALFORMED_PAYLOAD", "EIP-3009 address, nonce, or signature encoding is invalid");
    }

    try {
      const recovered = await verifyTypedData({
        address: payload.payload.authorization.from,
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: domain.verifyingContract,
        },
        types: EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: payload.payload.authorization.from,
          to: payload.payload.authorization.to,
          value: BigInt(payload.payload.authorization.value),
          validAfter: BigInt(payload.payload.authorization.validAfter),
          validBefore: BigInt(payload.payload.authorization.validBefore),
          nonce: payload.payload.authorization.nonce as `0x${string}`,
        },
        signature: payload.payload.signature as Hex,
      });
      if (!recovered) {
        return invalid(requestId, "INVALID_SIGNATURE", "The EIP-712 signature is not valid", "signature");
      }
    } catch {
      return invalid(requestId, "INVALID_SIGNATURE", "The EIP-712 signature could not be verified", "signature");
    }

    return {
      status: "VALID",
      code: "VALID",
      requestId,
      paymentIntentId: intent.paymentIntentId,
      authorizer: intent.authorizer,
    };
  }
}

export async function verifyEip3009Payment(
  config: Eip3009PaymentVerifierConfig,
  requestId: string,
  payload: unknown,
): Promise<Eip3009VerificationResult> {
  return new Eip3009PaymentVerifier(config).verify(requestId, payload);
}