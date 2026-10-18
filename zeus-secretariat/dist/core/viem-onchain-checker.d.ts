/**
 * Zeus Secretariat V0 - Real On-Chain Checker (P0-4)
 *
 * section 6: Blockchain is System of Record
 * section 7: SETTLED proof requires full evidence bundle
 * authorizationState == true alone is NOT sufficient for SETTLED
 */
import type { FinalityPolicy } from "./types.js";
export interface TransactionCheckResult {
    confirmed: boolean;
    blockNumber?: number;
    status: "success" | "reverted" | "pending";
    logs?: Array<{
        address: string;
        topics: string[];
        data: string;
        logIndex: number;
    }>;
    confirmations?: number;
}
export interface AuthorizationUsedResult {
    transactionHash: string;
    blockNumber: number;
    logIndex: number;
}
export interface TransferMatchResult {
    from: string;
    to: string;
    value: bigint;
    tokenContract: string;
}
/**
 * Network configuration for on-chain verification.
 * P1-12: No hardcoded network-specific values inside generic components.
 */
export interface OnChainNetworkConfig {
    /** Chain object from viem/chains or custom chain definition */
    chain: any;
    /** Token contract address for EIP-3009 authorization checks */
    tokenContractAddress: `0x${string}`;
    /** RPC URL */
    rpcUrl: string;
}
export declare class ViemOnChainChecker {
    private readonly client;
    private readonly finalityPolicy;
    private readonly networkConfig;
    constructor(networkConfig: OnChainNetworkConfig, finalityPolicy?: FinalityPolicy);
    getTokenContractAddress(): `0x${string}`;
    private assertExpectedChain;
    getBlockNumber(): Promise<number>;
    /** section 6: Check authorizationState(authorizer, nonce) */
    checkAuthorizationState(tokenContract: `0x${string}`, authorizer: `0x${string}`, nonce: `0x${string}`): Promise<boolean>;
    /** section 6: Find AuthorizationUsed event to recover txHash */
    findAuthorizationUsed(tokenContract: `0x${string}`, authorizer: `0x${string}`, nonce: `0x${string}`, fromBlock: bigint, toBlock: bigint): Promise<AuthorizationUsedResult | null>;
    /** section 7 + 8: Get receipt and verify Transfer matching */
    verifySettledProof(txHash: `0x${string}`, expectedFrom: `0x${string}`, expectedTo: `0x${string}`, expectedMinValue: bigint, expectedTokenContract: `0x${string}`): Promise<{
        receiptStatus: number;
        blockNumber: number;
        confirmations: number;
        transfer: TransferMatchResult | null;
        authorizationUsed: AuthorizationUsedResult | null;
    } | null>;
    getFinalityPolicy(): FinalityPolicy;
}
//# sourceMappingURL=viem-onchain-checker.d.ts.map