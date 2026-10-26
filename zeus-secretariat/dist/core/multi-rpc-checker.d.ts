/**
 * Zeus Secretariat V0 — Multi-RPC On-Chain Checker
 *
 * §6: Blockchain is System of Record
 * §14: Minimum 2 independent RPC observations for NOT_SETTLED
 * §15: RPC independence tracking (underlying provider identity)
 * §17: txHash-first priority, then authorizationState fallback
 */
import type { RpcProviderConfig, FinalityPolicy, AuthorizationUsedScanObservation, AuthorizationUsedScanOutcome } from "./types.js";
export interface TransactionCheckResult {
    /**
     * R7-B6d (external audit 2026-10-26): false = the provider answered the
     * receipt query successfully but the transaction is NOT on the chain
     * (dropped/replaced/never broadcast). Previously this case returned null —
     * indistinguishable from an RPC failure — which stranded intents carrying
     * a txHash in eternal RECONCILING with no authorizationState fallback.
     */
    found: boolean;
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
    /** Real gas from the receipt when present (R7-C1: no fabricated "0"). */
    gasUsed?: string;
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
        /**
         * F-002: Real block context witnessed by this provider at observation
         * time. Present ONLY for successful observations; §11-D freshness
         * gating refuses a terminal NOT_SETTLED without it.
         */
        blockData?: {
            blockNumber: number;
            chainHead: number;
            stalenessBlocks: number;
        };
    }>;
    agreement: "UNANIMOUS" | "DISAGREEMENT" | "INSUFFICIENT" | "ALL_FAILED";
    unanimousValue?: T;
}
export interface AuthorizationUsedScanResult {
    observations: AuthorizationUsedScanObservation[];
    outcome: AuthorizationUsedScanOutcome;
    /** present only when outcome === "EVENT_FOUND" */
    event?: AuthorizationUsedEventResult;
}
/**
 * R7-B7c (external audit 2026-10-26): a provider answering on the WRONG
 * chain is a configuration error, not a transient RPC hiccup. Swallowing it
 * into "no receipt" let a misconfigured provider silently participate in
 * consensus. This error is rethrown past the per-provider catch so the
 * observation records the real failure.
 */
export declare class ChainMismatchError extends Error {
    constructor(message: string);
}
export declare class SingleRpcProvider {
    readonly config: RpcProviderConfig;
    private readonly rpcTimeoutMs;
    constructor(config: RpcProviderConfig, rpcTimeoutMs?: number);
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
     * F-002: STRICT scan — throws on RPC failure instead of swallowing it.
     * A swallowed error is indistinguishable from an empty log range and would
     * let callers record a false "scan complete, nothing found".
     *
     * R7-B7d: the range [fromBlock, toBlock] is scanned in bounded chunks
     * (LOG_SCAN_CHUNK). Providers that cap eth_getLogs ranges (10k blocks is
     * a common cap) rejected full-range scans from block 0, which the §11
     * fail-closed gate then turned into eternal RECONCILING.
     */
    findAuthorizationUsedEventStrict(tokenContract: string, authorizer: string, nonce: string, fromBlock: number, toBlock: number): Promise<{
        transactionHash: string;
        blockNumber: number;
        logIndex: number;
    } | null>;
    /**
     * §6: Scan for AuthorizationUsed(authorizer, nonce) event.
     */
    /**
     * §6: Scan for AuthorizationUsed(address,bytes32) event.
     * P0-4: Real event signature — keccak256("AuthorizationUsed(address,bytes32)")
     * = 0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5
     * (F-112 hygiene: the previously quoted placeholder was not a real keccak;
     * the value above now matches the topic computed below from the ABI.)
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
     *
     * R7-B7a (external audit 2026-10-26): the consensus previously compared
     * JSON.stringify of the WHOLE result — including `confirmations =
     * chainHead − blockNum` (and chainId), which differ between providers
     * whenever their heads drift (i.e. almost always on real infrastructure).
     * The consequence: honest providers were flagged DISAGREEMENT on every
     * txHash check (masks stayed green only because mocks return identical
     * numbers). Consensus is now computed over the settlement-relevant fields
     * only; confirmations for the consensus value are taken CONSERVATIVELY as
     * the minimum across the agreeing providers.
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
     * F-002 (external audit Blocker): HONEST multi-provider AuthorizationUsed
     * scan. Distinguishes the three cases the legacy aggregate-based API could
     * not: (a) every provider executed the scan and found nothing,
     * (b) at least one provider failed to scan, (c) providers disagree.
     * Only (a) — SCAN_COMPLETE_EMPTY — may ever back a terminal NOT_SETTLED.
     */
    scanAuthorizationUsed(tokenContract: string, authorizer: string, nonce: string, fromBlock?: number): Promise<AuthorizationUsedScanResult>;
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
    /**
     * F-002: Mock parity for the honest AuthorizationUsed scan.
     * Default: every provider scanned [0, 1000] and found nothing
     * (SCAN_COMPLETE_EMPTY). Tests override via setScanOutcome().
     */
    private scanOutcomes;
    scanAuthorizationUsedCallCount: number;
    setScanOutcome(nonce: string, outcome: "SCAN_COMPLETE_EMPTY" | "EVENT_FOUND" | "DISAGREEMENT" | "INCOMPLETE", event?: AuthorizationUsedEventResult): void;
    scanAuthorizationUsed(_tokenContract: string, _authorizer: string, nonce: string): Promise<AuthorizationUsedScanResult>;
    findAuthorizationUsedEvent(_tokenContract: string, _authorizer: string, nonce: string): Promise<MultiRpcResult<AuthorizationUsedEventResult>>;
    canDeclareNotSettled(authResult: MultiRpcResult<boolean>, validBefore: number, currentTime: number): {
        allowed: boolean;
        reason: string;
    };
    getFinalityPolicy(): FinalityPolicy;
}
//# sourceMappingURL=multi-rpc-checker.d.ts.map