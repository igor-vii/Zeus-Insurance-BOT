/**
 * Zeus Secretariat V0 — Multi-RPC On-Chain Checker
 *
 * §6: Blockchain is System of Record
 * §14: Minimum 2 independent RPC observations for NOT_SETTLED
 * §15: RPC independence tracking (underlying provider identity)
 * §17: txHash-first priority, then authorizationState fallback
 */
import type { RpcProviderConfig, FinalityPolicy } from "./types.js";
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
    chainId?: number;
}
export interface AuthorizationStateResult {
    state: boolean | null;
    blockNumber: number;
    chainHead: number;
    stalenessBlocks: number;
    error?: string;
}
export interface AuthorizationUsedEventResult {
    transactionHash: string;
    blockNumber: number;
    logIndex: number;
}
export interface MultiRpcResult<T> {
    observations: Array<{
        providerId: string;
        underlyingProvider: string;
        result: T | null;
        error?: string;
        observedAt: number;
    }>;
    agreement: "UNANIMOUS" | "DISAGREEMENT" | "INSUFFICIENT" | "ALL_FAILED";
    unanimousValue?: T;
}
export declare class SingleRpcProvider {
    readonly config: RpcProviderConfig;
    constructor(config: RpcProviderConfig);
    private rpcCall;
    getBlockNumber(): Promise<number>;
    getChainId(): Promise<number>;
    getTransactionReceipt(txHash: string): Promise<TransactionCheckResult | null>;
    /**
     * §6: Check authorizationState(authorizer, nonce)
     * Uses eth_call to the EIP-3009 token contract.
     */
    checkAuthorizationState(tokenContract: string, authorizer: string, nonce: string): Promise<AuthorizationStateResult>;
    /**
     * §6: Scan for AuthorizationUsed(authorizer, nonce) event.
     */
    /**
     * §6: Scan for AuthorizationUsed(address,bytes32) event.
     * P0-4: Real event signature — keccak256("AuthorizationUsed(address,bytes32)")
     * = 0x3f2df0fedd38a4e4e1b3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3
     * Actual value computed below using proper encoding.
     */
    findAuthorizationUsedEvent(tokenContract: string, authorizer: string, nonce: string, fromBlock: number, toBlock: number): Promise<{
        transactionHash: string;
        blockNumber: number;
        logIndex: number;
    } | null>;
}
export declare class MultiRpcChecker {
    private readonly providers;
    private readonly configs;
    private readonly finalityPolicy;
    constructor(configs: RpcProviderConfig[], finalityPolicy?: FinalityPolicy);
    /**
     * §14: Query all providers and determine agreement.
     */
    private aggregateResults;
    /**
     * §17: Check transaction by txHash across all providers.
     */
    checkTransaction(txHash: string): Promise<MultiRpcResult<TransactionCheckResult>>;
    findAuthorizationUsedEvent(tokenContract: string, authorizer: string, nonce: string, fromBlock?: number, toBlock?: number): Promise<MultiRpcResult<AuthorizationUsedEventResult>>;
    /**
     * §6 + §14: Check authorizationState across all providers.
     */
    checkAuthorizationState(tokenContract: string, authorizer: string, nonce: string): Promise<MultiRpcResult<boolean>>;
    /**
     * §11: Determine if NOT_SETTLED can be declared.
     * Requires: validBefore expired + all RPCs agree false + fresh chain heads.
     */
    canDeclareNotSettled(authResult: MultiRpcResult<boolean>, validBefore: number, currentTime: number): {
        allowed: boolean;
        reason: string;
    };
    getFinalityPolicy(): FinalityPolicy;
}
export declare class MockMultiRpcChecker {
    private txResults;
    private authResults;
    private authorizationUsedEvents;
    private providerResults;
    readonly providerConfigs: RpcProviderConfig[];
    constructor(providerConfigs?: RpcProviderConfig[]);
    setTxResult(txHash: string, result: TransactionCheckResult): void;
    setAuthResult(nonce: string, state: boolean): void;
    setAuthorizationUsedEvent(nonce: string, result: AuthorizationUsedEventResult): void;
    /** Set per-provider auth result (for disagreement tests) */
    setProviderAuthResult(providerId: string, nonce: string, state: boolean): void;
    checkTransaction(txHash: string): Promise<MultiRpcResult<TransactionCheckResult>>;
    checkAuthorizationState(_tokenContract: string, _authorizer: string, nonce: string): Promise<MultiRpcResult<boolean>>;
    findAuthorizationUsedEvent(_tokenContract: string, _authorizer: string, nonce: string): Promise<MultiRpcResult<AuthorizationUsedEventResult>>;
    canDeclareNotSettled(authResult: MultiRpcResult<boolean>, validBefore: number, currentTime: number): {
        allowed: boolean;
        reason: string;
    };
    getFinalityPolicy(): FinalityPolicy;
}
//# sourceMappingURL=multi-rpc-checker.d.ts.map