import { verifyTypedData, } from "viem";
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
};
function invalid(requestId, code, message, field) {
    return { status: "INVALID", code, requestId, message, ...(field ? { field } : {}) };
}
function same(left, right) {
    return String(left).toLowerCase() === String(right).toLowerCase();
}
function isAddress(value) {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}
function isHex(value) {
    return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}
function sameOptionalDomainValue(payloadValue, domainValue) {
    return payloadValue === undefined || same(payloadValue, domainValue);
}
function payloadShapeIsValid(payload) {
    if (!payload || typeof payload !== "object")
        return false;
    const candidate = payload;
    const authorization = candidate.payload?.authorization;
    return (candidate.x402Version === 2 &&
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
        typeof authorization.nonce === "string");
}
function getDomainExtra(payload) {
    const extra = payload.accepted.extra;
    return extra && typeof extra === "object" ? extra : undefined;
}
function checkBinding(requestId, payload, intent, domain) {
    const authorization = payload.payload.authorization;
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
    // F-113/C-3 (external audit 2026-10-26, Major): on canonical v2 EVM
    // payloads the domain metadata (accepted.extra.name / .version) is
    // REQUIRED. It is the only way to bind the signature to the EIP-712 domain
    // the on-chain token will actually enforce — without it the verifier's
    // domain check was silently skipped and a signer could unknowingly sign
    // under a different domain than the facilitator settles with. Non-EVM
    // networks and v1 payloads keep the old optional behavior.
    if (payload.x402Version === 2 && isEvmNetwork(payload.accepted.network)) {
        const extraName = extra ? extra.name : undefined;
        const extraVersion = extra ? extra.version : undefined;
        if (typeof extraName !== "string" || extraName === "" || typeof extraVersion !== "string" || extraVersion === "") {
            return invalid(requestId, "DOMAIN_MISMATCH", "v2 EVM payload must carry accepted.extra.name and accepted.extra.version (EIP-712 domain binding)", "domain.extra");
        }
    }
    if (extra &&
        (!sameOptionalDomainValue(extra.name, domain.name) ||
            !sameOptionalDomainValue(extra.version, domain.version) ||
            !sameOptionalDomainValue(extra.chainId, domain.chainId) ||
            !sameOptionalDomainValue(extra.verifyingContract, domain.verifyingContract))) {
        return invalid(requestId, "DOMAIN_MISMATCH", "payload domain metadata does not match the persisted domain", "domain");
    }
    return null;
}
/**
 * CAIP-2 or alias form of an EVM network id (eip155:*; the repo's patched
 * x402 stack also speaks named aliases which all resolve to EVM chains).
 */
function isEvmNetwork(network) {
    if (/^eip155:\d+$/.test(network))
        return true;
    // Named aliases used by this repo / x402 v1 (all EVM).
    return /^(base|base-sepolia|base-mainnet|x-layer|xlayer|bot-chain|ethereum|sepolia|optimism|arbitrum|polygon|avalanche|abstract|peaq|story|educhain)/i.test(network);
}
export class Eip3009PaymentVerifier {
    store;
    domain;
    constructor(config) {
        this.store = config.store;
        this.domain = config.domain;
    }
    /**
     * R6 (observe & record): every verification verdict — VALID or INVALID — is
     * appended to the durable evidence store so the PostgreSQL observation log
     * captures WHAT HAPPENED TO THE PAYMENT, not just what succeeded. Best-effort:
     * recording failures never alter the verification outcome.
     */
    recordObservation(requestId, result, intent) {
        const store = this.store;
        if (typeof store.append !== "function")
            return;
        const record = result.status === "VALID"
            ? {
                operationId: intent?.operationId ?? requestId,
                phase: "PAYMENT",
                timestamp: Date.now(),
                event: "PAYMENT_VERIFIED",
                payload: {
                    requestId,
                    paymentIntentId: result.paymentIntentId,
                    authorizer: result.authorizer,
                    source: "eip3009-verifier",
                },
            }
            : {
                operationId: intent?.operationId ?? requestId,
                phase: "PAYMENT",
                timestamp: Date.now(),
                event: "PAYMENT_VERIFICATION_REJECTED",
                payload: {
                    requestId,
                    code: result.code,
                    field: result.field,
                    message: result.message,
                    source: "eip3009-verifier",
                },
            };
        try {
            void store.append(record).catch(() => {
                /* observation is best-effort — never affect verification */
            });
        }
        catch {
            /* same */
        }
    }
    async verify(requestId, payload) {
        let intent = null;
        // Local rejection helper: threads the loaded intent (if any) into the
        // observation record so the JSONB history lands on the right intent.
        const reject = (code, message, field) => ({ result: invalid(requestId, code, message, field), intent });
        let outcome;
        if (typeof this.store.getPaymentIntentByRequestId !== "function") {
            outcome = reject("PERSISTED_INTENT_LOOKUP_UNAVAILABLE", "The configured store cannot load a payment intent by requestId");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
        }
        const loadedIntent = await this.store.getPaymentIntentByRequestId(requestId);
        if (!loadedIntent) {
            outcome = reject("REQUEST_NOT_FOUND", "No persisted payment intent exists for requestId");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
        }
        intent = loadedIntent;
        if (typeof payload !== "object" || payload === null) {
            outcome = reject("MALFORMED_PAYLOAD", "The signed payment payload is not a canonical x402 V2 payload");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
        }
        if (payload.x402Version !== 2) {
            outcome = reject("X402_VERSION_MISMATCH", "Only x402 V2 payment payloads are supported", "x402Version");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
        }
        if (!payloadShapeIsValid(payload)) {
            outcome = reject("MALFORMED_PAYLOAD", "The signed payment payload is not a canonical x402 V2 payload");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
        }
        let domain;
        try {
            domain = typeof this.domain === "function"
                ? await this.domain(intent)
                : this.domain;
        }
        catch {
            outcome = reject("DOMAIN_MISMATCH", "The EIP-712 domain could not be resolved from persisted intent context", "domain");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
        }
        const bindingError = checkBinding(requestId, payload, intent, domain);
        if (bindingError) {
            this.recordObservation(requestId, bindingError, intent);
            return bindingError;
        }
        if (!isAddress(payload.payload.authorization.from) ||
            !isAddress(payload.payload.authorization.to) ||
            !isAddress(domain.verifyingContract) ||
            !isHex(payload.payload.authorization.nonce) ||
            !isHex(payload.payload.signature)) {
            outcome = reject("MALFORMED_PAYLOAD", "EIP-3009 address, nonce, or signature encoding is invalid");
            this.recordObservation(requestId, outcome.result, outcome.intent);
            return outcome.result;
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
                    nonce: payload.payload.authorization.nonce,
                },
                signature: payload.payload.signature,
            });
            if (!recovered) {
                const r = reject("INVALID_SIGNATURE", "The EIP-712 signature is not valid", "signature");
                this.recordObservation(requestId, r.result, r.intent);
                return r.result;
            }
        }
        catch {
            const r = reject("INVALID_SIGNATURE", "The EIP-712 signature could not be verified", "signature");
            this.recordObservation(requestId, r.result, r.intent);
            return r.result;
        }
        const valid = {
            status: "VALID",
            code: "VALID",
            requestId,
            paymentIntentId: intent.paymentIntentId,
            authorizer: intent.authorizer,
        };
        this.recordObservation(requestId, valid, intent);
        return valid;
    }
}
export async function verifyEip3009Payment(config, requestId, payload) {
    return new Eip3009PaymentVerifier(config).verify(requestId, payload);
}
//# sourceMappingURL=eip3009-verifier.js.map