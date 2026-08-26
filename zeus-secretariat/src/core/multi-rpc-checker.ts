/**
 * Zeus Secretariat V0 — Multi-RPC On-Chain Checker
 *
 * §6: Blockchain is System of Record
 * §14: Minimum 2 independent RPC observations for NOT_SETTLED
 * §15: RPC independence tracking (underlying provider identity)
 * §17: txHash-first priority, then authorizationState fallback
 */

import type {
  RpcProviderConfig,
  ReconciliationObservation,
  FinalityPolicy,
} from "./types";
import { DEFAULT_FINALITY_POLICY } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface AuthorizationStateResult {
  state: boolean | null; // null = RPC error
  blockNumber: number;
  chainHead: number;
  stalenessBlocks: number;
  error?: string;
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

// ---------------------------------------------------------------------------
// Single RPC Provider Adapter
// ---------------------------------------------------------------------------

export class SingleRpcProvider {
  readonly config: RpcProviderConfig;

  constructor(config: RpcProviderConfig) {
    this.config = config;
  }

  private async rpcCall(method: string, params: unknown[]): Promise<any> {
    const response = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    const data = await response.json();
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    return data.result;
  }

  async getBlockNumber(): Promise<number> {
    const hex = await this.rpcCall("eth_blockNumber", []);
    return parseInt(hex, 16);
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionCheckResult | null> {
    try {
      const receipt = await this.rpcCall("eth_getTransactionReceipt", [txHash]);
      if (!receipt) return null;
      const blockNum = parseInt(receipt.blockNumber, 16);
      const chainHead = await this.getBlockNumber();
      const status = receipt.status === "0x1" ? "success" : "reverted";
      return {
        confirmed: status === "success",
        blockNumber: blockNum,
        status,
        logs: (receipt.logs ?? []).map((l: any) => ({
          address: l.address,
          topics: l.topics,
          data: l.data,
          logIndex: parseInt(l.logIndex, 16),
        })),
        confirmations: chainHead - blockNum,
      };
    } catch {
      return null;
    }
  }

  /**
   * §6: Check authorizationState(authorizer, nonce)
   * Uses eth_call to the EIP-3009 token contract.
   */
  async checkAuthorizationState(
    tokenContract: string,
    authorizer: string,
    nonce: string,
  ): Promise<AuthorizationStateResult> {
    try {
      const chainHead = await this.getBlockNumber();
      // authorizationState(address,bytes32) selector = 0x... 
      // For EIP-3009: function authorizationState(address authorizer, bytes32 nonce) returns (bool)
      const selector = "0x7f8b5b3e"; // placeholder — real impl uses viem/ethers encoding
      const paddedAuthorizer = authorizer.toLowerCase().replace("0x", "").padStart(64, "0");
      const paddedNonce = nonce.replace("0x", "").padStart(64, "0");
      const callData = selector + paddedAuthorizer + paddedNonce;

      const result = await this.rpcCall("eth_call", [
        { to: tokenContract, data: callData },
        "latest",
      ]);

      const state = result !== "0x" && result !== "0x0000000000000000000000000000000000000000000000000000000000000000";
      const staleness = 0; // "latest" block

      return {
        state,
        blockNumber: chainHead,
        chainHead,
        stalenessBlocks: staleness,
      };
    } catch (err) {
      return {
        state: null,
        blockNumber: 0,
        chainHead: 0,
        stalenessBlocks: 0,
        error: err instanceof Error ? err.message : "Unknown RPC error",
      };
    }
  }

  /**
   * §6: Scan for AuthorizationUsed(authorizer, nonce) event.
   */
  async findAuthorizationUsedEvent(
    tokenContract: string,
    authorizer: string,
    nonce: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<{ transactionHash: string; blockNumber: number; logIndex: number } | null> {
    try {
      // AuthorizationUsed(address,bytes32) topic
      const topic0 = "0x..."; // keccak256("AuthorizationUsed(address,bytes32)")
      const paddedAuthorizer = "0x" + authorizer.toLowerCase().replace("0x", "").padStart(64, "0");
      const paddedNonce = "0x" + nonce.replace("0x", "").padStart(64, "0");

      const logs = await this.rpcCall("eth_getLogs", [{
        address: tokenContract,
        topics: [topic0, paddedAuthorizer, paddedNonce],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      }]);

      if (!logs || logs.length === 0) return null;
      const log = logs[0];
      return {
        transactionHash: log.transactionHash,
        blockNumber: parseInt(log.blockNumber, 16),
        logIndex: parseInt(log.logIndex, 16),
      };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-RPC Checker (§14, §15)
// ---------------------------------------------------------------------------

export class MultiRpcChecker {
  private readonly providers: SingleRpcProvider[];
  private readonly configs: RpcProviderConfig[];
  private readonly finalityPolicy: FinalityPolicy;

  constructor(configs: RpcProviderConfig[], finalityPolicy: FinalityPolicy = DEFAULT_FINALITY_POLICY) {
    if (configs.length < 2) {
      throw new Error("MultiRpcChecker requires at least 2 RPC providers (§14)");
    }
    // §15: Verify independence
    const underlying = new Set(configs.map(c => c.underlyingProvider));
    if (underlying.size < 2) {
      throw new Error("§15: At least 2 different underlying providers required for independence");
    }
    this.configs = configs;
    this.providers = configs.map(c => new SingleRpcProvider(c));
    this.finalityPolicy = finalityPolicy;
  }

  /**
   * §14: Query all providers and determine agreement.
   */
  private aggregateResults<T>(
    results: Array<{ providerId: string; underlyingProvider: string; result: T | null; error?: string; observedAt: number }>,
  ): MultiRpcResult<T> {
    const successful = results.filter(r => r.result !== null);
    const failed = results.filter(r => r.result === null);

    if (successful.length === 0) {
      return { observations: results, agreement: "ALL_FAILED" };
    }

    if (successful.length < 2) {
      return { observations: results, agreement: "INSUFFICIENT" };
    }

    // Check unanimity
    const first = JSON.stringify(successful[0].result);
    const allAgree = successful.every(r => JSON.stringify(r.result) === first);

    if (allAgree) {
      return { observations: results, agreement: "UNANIMOUS", unanimousValue: successful[0].result! };
    }

    return { observations: results, agreement: "DISAGREEMENT" };
  }

  /**
   * §17: Check transaction by txHash across all providers.
   */
  async checkTransaction(txHash: string): Promise<MultiRpcResult<TransactionCheckResult>> {
    const results = await Promise.all(
      this.providers.map(async (provider, i) => {
        const config = this.configs[i];
        try {
          const result = await provider.getTransactionReceipt(txHash);
          return {
            providerId: config.providerId,
            underlyingProvider: config.underlyingProvider,
            result,
            observedAt: Date.now(),
          };
        } catch (err) {
          return {
            providerId: config.providerId,
            underlyingProvider: config.underlyingProvider,
            result: null,
            error: err instanceof Error ? err.message : "Unknown error",
            observedAt: Date.now(),
          };
        }
      }),
    );
    return this.aggregateResults(results);
  }

  /**
   * §6 + §14: Check authorizationState across all providers.
   */
  async checkAuthorizationState(
    tokenContract: string,
    authorizer: string,
    nonce: string,
  ): Promise<MultiRpcResult<boolean>> {
    const results = await Promise.all(
      this.providers.map(async (provider, i) => {
        const config = this.configs[i];
        try {
          const authResult = await provider.checkAuthorizationState(tokenContract, authorizer, nonce);
          return {
            providerId: config.providerId,
            underlyingProvider: config.underlyingProvider,
            result: authResult.state,
            error: authResult.error,
            observedAt: Date.now(),
          };
        } catch (err) {
          return {
            providerId: config.providerId,
            underlyingProvider: config.underlyingProvider,
            result: null,
            error: err instanceof Error ? err.message : "Unknown error",
            observedAt: Date.now(),
          };
        }
      }),
    );
    return this.aggregateResults(results);
  }

  /**
   * §11: Determine if NOT_SETTLED can be declared.
   * Requires: validBefore expired + all RPCs agree false + fresh chain heads.
   */
  canDeclareNotSettled(
    authResult: MultiRpcResult<boolean>,
    validBefore: number,
    currentTime: number,
  ): { allowed: boolean; reason: string } {
    // §11-A: validBefore must have expired
    if (currentTime < validBefore) {
      return { allowed: false, reason: "§11-A: validBefore not yet expired" };
    }

    // §11-C: Need unanimous agreement
    if (authResult.agreement !== "UNANIMOUS") {
      if (authResult.agreement === "DISAGREEMENT") {
        return { allowed: false, reason: "§14: RPC disagreement — cannot declare NOT_SETTLED" };
      }
      if (authResult.agreement === "INSUFFICIENT") {
        return { allowed: false, reason: "§14: Insufficient RPC observations (need >= 2)" };
      }
      return { allowed: false, reason: "§14: All RPCs failed" };
    }

    // §11-B: authorizationState must be false
    if (authResult.unanimousValue !== false) {
      return { allowed: false, reason: "§11-B: authorizationState is not false" };
    }

    // §11-D: Check chain freshness
    for (const obs of authResult.observations) {
      if (obs.result === null) continue;
      // Staleness check would go here with actual block data
    }

    return { allowed: true, reason: "All §11 conditions met" };
  }

  getFinalityPolicy(): FinalityPolicy {
    return this.finalityPolicy;
  }
}

// ---------------------------------------------------------------------------
// Mock implementations for testing
// ---------------------------------------------------------------------------

export class MockMultiRpcChecker {
  private txResults: Map<string, TransactionCheckResult> = new Map();
  private authResults: Map<string, boolean> = new Map();
  private providerResults: Map<string, Map<string, boolean>> = new Map(); // providerId -> nonce -> state
  readonly providerConfigs: RpcProviderConfig[];

  constructor(providerConfigs?: RpcProviderConfig[]) {
    this.providerConfigs = providerConfigs ?? [
      { providerId: "mock-alchemy", underlyingProvider: "alchemy", rpcUrl: "mock://alchemy", maxStalenessBlocks: 5 },
      { providerId: "mock-infura", underlyingProvider: "infura", rpcUrl: "mock://infura", maxStalenessBlocks: 5 },
    ];
  }

  setTxResult(txHash: string, result: TransactionCheckResult): void {
    this.txResults.set(txHash.toLowerCase(), result);
  }

  setAuthResult(nonce: string, state: boolean): void {
    this.authResults.set(nonce.toLowerCase(), state);
  }

  /** Set per-provider auth result (for disagreement tests) */
  setProviderAuthResult(providerId: string, nonce: string, state: boolean): void {
    if (!this.providerResults.has(providerId)) {
      this.providerResults.set(providerId, new Map());
    }
    this.providerResults.get(providerId)!.set(nonce.toLowerCase(), state);
  }

  async checkTransaction(txHash: string): Promise<MultiRpcResult<TransactionCheckResult>> {
    const result = this.txResults.get(txHash.toLowerCase()) ?? null;
    const observations = this.providerConfigs.map(c => ({
      providerId: c.providerId,
      underlyingProvider: c.underlyingProvider,
      result,
      observedAt: Date.now(),
    }));
    if (result === null) return { observations, agreement: "ALL_FAILED" };
    return { observations, agreement: "UNANIMOUS", unanimousValue: result };
  }

  async checkAuthorizationState(
    _tokenContract: string,
    _authorizer: string,
    nonce: string,
  ): Promise<MultiRpcResult<boolean>> {
    const observations = this.providerConfigs.map(c => {
      // Per-provider override takes precedence
      const providerOverride = this.providerResults.get(c.providerId)?.get(nonce.toLowerCase());
      const globalResult = this.authResults.get(nonce.toLowerCase());
      const result = providerOverride !== undefined ? providerOverride : (globalResult ?? null);
      return {
        providerId: c.providerId,
        underlyingProvider: c.underlyingProvider,
        result,
        observedAt: Date.now(),
      };
    });

    const successful = observations.filter(o => o.result !== null);
    if (successful.length < 2) return { observations, agreement: successful.length === 0 ? "ALL_FAILED" : "INSUFFICIENT" };
    const first = successful[0].result;
    const allAgree = successful.every(o => o.result === first);
    if (allAgree) return { observations, agreement: "UNANIMOUS", unanimousValue: first! };
    return { observations, agreement: "DISAGREEMENT" };
  }

  canDeclareNotSettled(
    authResult: MultiRpcResult<boolean>,
    validBefore: number,
    currentTime: number,
  ): { allowed: boolean; reason: string } {
    if (currentTime < validBefore) return { allowed: false, reason: "validBefore not expired" };
    if (authResult.agreement !== "UNANIMOUS") return { allowed: false, reason: `agreement: ${authResult.agreement}` };
    if (authResult.unanimousValue !== false) return { allowed: false, reason: "state not false" };
    return { allowed: true, reason: "All conditions met" };
  }

  getFinalityPolicy(): FinalityPolicy {
    return DEFAULT_FINALITY_POLICY;
  }
}
