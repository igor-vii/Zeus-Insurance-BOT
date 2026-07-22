import { z } from "zod";
export declare const NetworkSchema: z.ZodEnum<["mainnet", "base-mainnet", "base-sepolia", "sepolia", "localhost", "x-layer"]>;
export type Network = z.infer<typeof NetworkSchema>;
export interface NetworkConfig {
    name: string;
    chainId: number;
    /** ZeusEscrowBOT contract address */
    escrowAddress: string;
    /** ZeusInsuranceV2 contract address */
    insuranceAddress: string;
    /** ZeusReserveV2 contract address */
    reserveAddress: string;
    /** ERC-20 token used by the escrow (USDC) */
    usdcAddress: string;
    rpcUrl: string;
}
export declare const NETWORKS: Record<Network, NetworkConfig>;
/**
 * Proof is flexible: an IPFS CID, tx hash, URL, or any arbitrary bytes.
 * Pass as a hex string (0x-prefixed) or plain UTF-8 string.
 * The SDK converts plain strings to hex automatically.
 */
export declare const DepositAndCreateAgreementSchema: z.ZodObject<{
    executor: z.ZodString;
    amount: z.ZodBigInt;
    timeout: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    executor: string;
    amount: bigint;
    timeout: number;
}, {
    executor: string;
    amount: bigint;
    timeout: number;
}>;
export declare const ConfirmExecutionSchema: z.ZodObject<{
    agreementId: z.ZodNumber;
    /** Arbitrary proof string (IPFS CID, tx hash, URL, etc.). Empty string is allowed. */
    proof: z.ZodString;
}, "strip", z.ZodTypeAny, {
    agreementId: number;
    proof: string;
}, {
    agreementId: number;
    proof: string;
}>;
export declare const RequestRefundSchema: z.ZodObject<{
    agreementId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    agreementId: number;
}, {
    agreementId: number;
}>;
export declare const CreatePolicySchema: z.ZodObject<{
    seller: z.ZodString;
    amount: z.ZodBigInt;
    timeout: z.ZodNumber;
    retries: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    amount: bigint;
    timeout: number;
    seller: string;
    retries: number;
}, {
    amount: bigint;
    timeout: number;
    seller: string;
    retries: number;
}>;
export declare const ClaimPayoutSchema: z.ZodObject<{
    policyId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    policyId: number;
}, {
    policyId: number;
}>;
export declare const GetPolicySchema: z.ZodObject<{
    policyId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    policyId: number;
}, {
    policyId: number;
}>;
export declare const SubmitObservationSchema: z.ZodObject<{
    policyId: z.ZodNumber;
    observation: z.ZodObject<{
        /** keccak256(buyer, seller, timestamp) — unique per health-check round. */
        requestId: z.ZodString;
        /** Unix timestamp of the observation (±120 s tolerance on-chain). */
        timestamp: z.ZodNumber;
        /**
         * Service health code:
         *   0 = OK
         *   1 = TIMEOUT  (counts toward payout quorum)
         *   2 = ERROR_500
         *   3 = LATE
         */
        status: z.ZodNumber;
        /** Arbitrary metadata digest (e.g. IPFS CID of raw logs). */
        metadataHash: z.ZodString;
        /** Per-watcher anti-replay nonce. */
        nonce: z.ZodNumber;
        /** EIP-191 personal_sign over (requestId, timestamp, status, metadataHash, nonce). */
        signature: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        status: number;
        requestId: string;
        timestamp: number;
        metadataHash: string;
        nonce: number;
        signature: string;
    }, {
        status: number;
        requestId: string;
        timestamp: number;
        metadataHash: string;
        nonce: number;
        signature: string;
    }>;
}, "strip", z.ZodTypeAny, {
    policyId: number;
    observation: {
        status: number;
        requestId: string;
        timestamp: number;
        metadataHash: string;
        nonce: number;
        signature: string;
    };
}, {
    policyId: number;
    observation: {
        status: number;
        requestId: string;
        timestamp: number;
        metadataHash: string;
        nonce: number;
        signature: string;
    };
}>;
/**
 * Mirrors ZeusEscrowBOT.AgreementStatus on-chain enum.
 */
export declare enum AgreementStatus {
    Active = 0,
    Completed = 1,
    Refunded = 2
}
/**
 * On-chain Agreement struct from ZeusEscrowBOT.
 * Note: the contract uses `initiator` (not `buyer`) and stores `proof` as bytes.
 */
export interface Agreement {
    id: number;
    initiator: string;
    executor: string;
    amount: bigint;
    timeout: number;
    createdAt: number;
    status: AgreementStatus;
    /** Hex-encoded proof bytes, or null if not yet submitted */
    proof: string | null;
}
/**
 * On-chain PolicyStatus enum (ZeusInsuranceV2).
 * Mirrors `enum PolicyStatus { Active, Claimed, Rejected, Expired }`.
 */
export declare enum PolicyStatus {
    Active = 0,
    Claimed = 1,
    Rejected = 2,
    Expired = 3
}
/**
 * Off-chain observation submitted by a watcher node.
 * Mirrors the `Observation` struct in ZeusInsuranceV2.
 */
export interface Observation {
    /** keccak256(buyer, seller, timestamp) */
    requestId: string;
    /** Unix timestamp of the check (±120 s tolerance on-chain). */
    timestamp: number;
    /** 0=OK 1=TIMEOUT 2=ERROR_500 3=LATE */
    status: 0 | 1 | 2 | 3;
    /** Arbitrary metadata digest. */
    metadataHash: string;
    /** Per-watcher anti-replay nonce. */
    nonce: number;
    /** EIP-191 personal_sign over (requestId, timestamp, status, metadataHash, nonce). */
    signature: string;
}
export interface Policy {
    /** Policy ID (mapping key in the contract). */
    id: number;
    buyer: string;
    seller: string;
    /** Coverage amount in USDC (6-decimal units). */
    amount: bigint;
    /** Premium paid in USDC (6-decimal units). */
    premium: bigint;
    /** Unix timestamp after which the buyer may claim a payout. */
    retryDeadline: number;
    maxRetries: number;
    /** On-chain status enum value. */
    status: PolicyStatus;
    /** Derived: status === PolicyStatus.Active */
    isActive: boolean;
    /** Derived: status === PolicyStatus.Claimed */
    isPaidOut: boolean;
    /** Derived: status === PolicyStatus.Expired */
    isExpired: boolean;
}
export interface TransactionResult {
    hash: string;
    status: number;
    blockNumber: number;
    gasUsed: bigint;
}
export declare class ZeusError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    constructor(message: string, code: string, details?: unknown | undefined);
}
export declare class ZeusNotConnectedError extends ZeusError {
    constructor(message?: string);
}
export declare class ZeusValidationError extends ZeusError {
    constructor(message: string, details?: unknown);
}
export declare class ZeusTransactionError extends ZeusError {
    readonly txHash?: string | undefined;
    constructor(message: string, txHash?: string | undefined, details?: unknown);
}
export declare class ZeusContractError extends ZeusError {
    constructor(message: string, details?: unknown);
}
//# sourceMappingURL=index.d.ts.map