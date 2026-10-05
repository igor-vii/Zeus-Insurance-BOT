import { type Address } from "viem";
import type { DurablePaymentIntent } from "./types.js";
/**
 * EIP-3009 TransferWithAuthorization typed-data definition.
 *
 * Keep this definition local to the verifier so the verification primitive
 * cannot accidentally inherit signer or settlement behavior.
 */
export declare const EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES: {
    readonly TransferWithAuthorization: readonly [{
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "value";
        readonly type: "uint256";
    }, {
        readonly name: "validAfter";
        readonly type: "uint256";
    }, {
        readonly name: "validBefore";
        readonly type: "uint256";
    }, {
        readonly name: "nonce";
        readonly type: "bytes32";
    }];
};
export interface Eip3009Domain {
    readonly name: string;
    readonly version: string;
    readonly chainId: number | bigint;
    readonly verifyingContract: Address;
}
export interface PaymentIntentByRequestIdStore {
    getPaymentIntentByRequestId(requestId: string): Promise<DurablePaymentIntent | null>;
}
export type Eip3009DomainResolver = (intent: DurablePaymentIntent) => Eip3009Domain | Promise<Eip3009Domain>;
export interface Eip3009PaymentVerifierConfig {
    readonly store: PaymentIntentByRequestIdStore;
    /**
     * The domain is selected from persisted intent context, never from an
     * untrusted external payload. A resolver is useful when networks use
     * different token domains.
     */
    readonly domain: Eip3009Domain | Eip3009DomainResolver;
}
export type Eip3009VerificationErrorCode = "PERSISTED_INTENT_LOOKUP_UNAVAILABLE" | "REQUEST_NOT_FOUND" | "MALFORMED_PAYLOAD" | "X402_VERSION_MISMATCH" | "NETWORK_MISMATCH" | "DOMAIN_MISMATCH" | "ASSET_MISMATCH" | "PAY_TO_MISMATCH" | "VALUE_MISMATCH" | "AUTHORIZER_MISMATCH" | "NONCE_MISMATCH" | "VALID_AFTER_MISMATCH" | "VALID_BEFORE_MISMATCH" | "INVALID_SIGNATURE";
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
export type Eip3009VerificationResult = ValidEip3009Verification | InvalidEip3009Verification;
export declare class Eip3009PaymentVerifier {
    private readonly store;
    private readonly domain;
    constructor(config: Eip3009PaymentVerifierConfig);
    verify(requestId: string, payload: unknown): Promise<Eip3009VerificationResult>;
}
export declare function verifyEip3009Payment(config: Eip3009PaymentVerifierConfig, requestId: string, payload: unknown): Promise<Eip3009VerificationResult>;
//# sourceMappingURL=eip3009-verifier.d.ts.map