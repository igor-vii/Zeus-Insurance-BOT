import { z } from "zod";
/* ──────────────────────────── Networks ──────────────────────────── */
export const NetworkSchema = z.enum([
    "mainnet",
    "base-mainnet",
    "base-sepolia",
    "sepolia",
    "localhost",
    "x-layer",
]);
export const NETWORKS = {
    mainnet: {
        name: "mainnet",
        chainId: 1,
        escrowAddress: "", // not yet deployed on Ethereum mainnet
        insuranceAddress: "", // not yet deployed on Ethereum mainnet
        reserveAddress: "", // not yet deployed on Ethereum mainnet
        usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        rpcUrl: "https://eth.llamarpc.com",
    },
    "base-mainnet": {
        name: "base-mainnet",
        chainId: 8453,
        escrowAddress: "0x8D10C2c6C92b613C1938fe532f0e391044e76188",
        insuranceAddress: "", // not yet deployed on Base mainnet
        reserveAddress: "", // not yet deployed on Base mainnet
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Native USDC on Base
        rpcUrl: "https://mainnet.base.org",
    },
    "base-sepolia": {
        name: "base-sepolia",
        chainId: 84532,
        // Deployed 2026-07-18 — see contracts/scripts/deploy-escrow-bot.ts
        escrowAddress: "0x87365462353bCBAB2CF0DF57c7Cb15519C5B7c76",
        insuranceAddress: "0x58038Df01A824C94F3D2fEd6d4e1bEf2211Ad8F4", // Deployed 2026-07-20 (v2 + oracle)
        reserveAddress: "0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47",
        usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        rpcUrl: "https://sepolia.base.org",
    },
    sepolia: {
        name: "sepolia",
        chainId: 11155111,
        escrowAddress: "",
        insuranceAddress: "",
        reserveAddress: "",
        usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        rpcUrl: "https://rpc.sepolia.org",
    },
    localhost: {
        name: "localhost",
        chainId: 31337,
        escrowAddress: "", // set after local `deploy:escrow-local`
        insuranceAddress: "",
        reserveAddress: "",
        usdcAddress: "",
        rpcUrl: "http://127.0.0.1:8545",
    },
    "x-layer": {
        name: "x-layer",
        chainId: 196,
        escrowAddress: "0x0d4AD4C6b60F445d0e478E0AF48075340AC51Cf5",
        insuranceAddress: "0x8D10C2c6C92b613C1938fe532f0e391044e76188",
        reserveAddress: "0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c",
        usdcAddress: "0x74b7f16337b8972027f6196a17a631ac6de26d22",
        rpcUrl: "https://rpc.xlayer.tech",
    },
};
/* ──────────────────────────── Validation Schemas ──────────────────────────── */
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
/**
 * Proof is flexible: an IPFS CID, tx hash, URL, or any arbitrary bytes.
 * Pass as a hex string (0x-prefixed) or plain UTF-8 string.
 * The SDK converts plain strings to hex automatically.
 */
export const DepositAndCreateAgreementSchema = z.object({
    executor: z.string().regex(ADDRESS_REGEX, "Invalid Ethereum address for executor"),
    amount: z.bigint().positive("Amount must be a positive bigint (in token base units)"),
    timeout: z
        .number()
        .int("Timeout must be an integer")
        .positive("Timeout must be positive (seconds)"),
});
export const ConfirmExecutionSchema = z.object({
    agreementId: z
        .number()
        .int("Agreement ID must be an integer")
        .nonnegative("Agreement ID must be non-negative"),
    /** Arbitrary proof string (IPFS CID, tx hash, URL, etc.). Empty string is allowed. */
    proof: z.string(),
});
export const RequestRefundSchema = z.object({
    agreementId: z
        .number()
        .int("Agreement ID must be an integer")
        .nonnegative("Agreement ID must be non-negative"),
});
export const CreatePolicySchema = z.object({
    seller: z.string().regex(ADDRESS_REGEX, "Invalid Ethereum address for seller"),
    amount: z.bigint().positive("Amount must be a positive bigint (in token base units)"),
    timeout: z
        .number()
        .int("Timeout must be an integer")
        .positive("Timeout must be positive (seconds)"),
    retries: z
        .number()
        .int("Retries must be an integer")
        .nonnegative("Retries must be non-negative"),
});
export const ClaimPayoutSchema = z.object({
    policyId: z
        .number()
        .int("Policy ID must be an integer")
        .nonnegative("Policy ID must be non-negative"),
});
export const GetPolicySchema = z.object({
    policyId: z
        .number()
        .int("Policy ID must be an integer")
        .nonnegative("Policy ID must be non-negative"),
});
const BYTES32_REGEX = /^0x[a-fA-F0-9]{64}$/;
const BYTES_HEX_REGEX = /^0x[a-fA-F0-9]*$/;
export const SubmitObservationSchema = z.object({
    policyId: z
        .number()
        .int("Policy ID must be an integer")
        .nonnegative("Policy ID must be non-negative"),
    observation: z.object({
        /** keccak256(buyer, seller, timestamp) — unique per health-check round. */
        requestId: z.string().regex(BYTES32_REGEX, "requestId must be a 0x-prefixed 32-byte hex string"),
        /** Unix timestamp of the observation (±120 s tolerance on-chain). */
        timestamp: z.number().int().nonnegative(),
        /**
         * Service health code:
         *   0 = OK
         *   1 = TIMEOUT  (counts toward payout quorum)
         *   2 = ERROR_500
         *   3 = LATE
         */
        status: z.number().int().min(0).max(3),
        /** Arbitrary metadata digest (e.g. IPFS CID of raw logs). */
        metadataHash: z.string().regex(BYTES32_REGEX, "metadataHash must be a 0x-prefixed 32-byte hex string"),
        /** Per-watcher anti-replay nonce. */
        nonce: z.number().int().nonnegative(),
        /** EIP-191 personal_sign over (requestId, timestamp, status, metadataHash, nonce). */
        signature: z.string().regex(BYTES_HEX_REGEX, "signature must be a 0x-prefixed hex string"),
    }),
});
/* ──────────────────────────── Domain Types ──────────────────────────── */
/**
 * Mirrors ZeusEscrowBOT.AgreementStatus on-chain enum.
 */
export var AgreementStatus;
(function (AgreementStatus) {
    AgreementStatus[AgreementStatus["Active"] = 0] = "Active";
    AgreementStatus[AgreementStatus["Completed"] = 1] = "Completed";
    AgreementStatus[AgreementStatus["Refunded"] = 2] = "Refunded";
})(AgreementStatus || (AgreementStatus = {}));
/**
 * On-chain PolicyStatus enum (ZeusInsuranceV2).
 * Mirrors `enum PolicyStatus { Active, Claimed, Rejected, Expired }`.
 */
export var PolicyStatus;
(function (PolicyStatus) {
    PolicyStatus[PolicyStatus["Active"] = 0] = "Active";
    PolicyStatus[PolicyStatus["Claimed"] = 1] = "Claimed";
    PolicyStatus[PolicyStatus["Rejected"] = 2] = "Rejected";
    PolicyStatus[PolicyStatus["Expired"] = 3] = "Expired";
})(PolicyStatus || (PolicyStatus = {}));
/* ──────────────────────────── Error Classes ──────────────────────────── */
export class ZeusError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "ZeusError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class ZeusNotConnectedError extends ZeusError {
    constructor(message = "SDK is not connected. Call client.connect(network, signer) first.") {
        super(message, "NOT_CONNECTED");
        this.name = "ZeusNotConnectedError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class ZeusValidationError extends ZeusError {
    constructor(message, details) {
        super(message, "VALIDATION_ERROR", details);
        this.name = "ZeusValidationError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class ZeusTransactionError extends ZeusError {
    txHash;
    constructor(message, txHash, details) {
        super(message, "TRANSACTION_ERROR", details);
        this.txHash = txHash;
        this.name = "ZeusTransactionError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class ZeusContractError extends ZeusError {
    constructor(message, details) {
        super(message, "CONTRACT_ERROR", details);
        this.name = "ZeusContractError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
//# sourceMappingURL=index.js.map