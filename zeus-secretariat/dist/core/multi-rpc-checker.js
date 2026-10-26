/**
 * Zeus Secretariat V0 — Multi-RPC On-Chain Checker
 *
 * §6: Blockchain is System of Record
 * §14: Minimum 2 independent RPC observations for NOT_SETTLED
 * §15: RPC independence tracking (underlying provider identity)
 * §17: txHash-first priority, then authorizationState fallback
 */
import { DEFAULT_FINALITY_POLICY } from "./types.js";
import { keccak256, toBytes } from "viem";
// ---------------------------------------------------------------------------
// Single RPC Provider Adapter
// ---------------------------------------------------------------------------
/**
 * R7-B7c (external audit 2026-10-26): a provider answering on the WRONG
 * chain is a configuration error, not a transient RPC hiccup. Swallowing it
 * into "no receipt" let a misconfigured provider silently participate in
 * consensus. This error is rethrown past the per-provider catch so the
 * observation records the real failure.
 */
export class ChainMismatchError extends Error {
    constructor(message) {
        super(message);
        this.name = "ChainMismatchError";
    }
}
/** Default per-RPC-call timeout (R7-B7b): a hung provider must not hang the
 *  reconciliation worker forever (stop() waits for the current batch). */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
/** R7-B7d (external audit 2026-10-26): eth_getLogs range chunk size. Many
 *  providers cap the scanned range (10k blocks is common) — a full-range
 *  scan from block 0 fails on them and the §11 fail-closed gate then
 *  blocks NOT_SETTLED forever. Scanning in bounded chunks is compatible
 *  with both unlimited and range-capped endpoints. */
const LOG_SCAN_CHUNK = 10_000;
export class SingleRpcProvider {
    config;
    rpcTimeoutMs;
    constructor(config, rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
        this.config = config;
        this.rpcTimeoutMs = rpcTimeoutMs;
    }
    async rpcCall(method, params) {
        // R7-B7b (external audit 2026-10-26): the previous rpcCall had NO
        // timeout and NO response.ok check — a hung provider froze the worker
        // (stop() waits for the current job) and an HTTP 500 with a JSON-RPC
        // error body was parsed as if it were a result.
        const response = await fetch(this.config.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
            signal: AbortSignal.timeout(this.rpcTimeoutMs),
        });
        if (!response.ok) {
            throw new Error(`RPC HTTP ${response.status} from ${this.config.providerId} (${method})`);
        }
        const data = (await response.json());
        if (data.error)
            throw new Error(`RPC error: ${data.error.message}`);
        return data.result;
    }
    async getBlockNumber() {
        const hex = await this.rpcCall("eth_blockNumber", []);
        return parseInt(hex, 16);
    }
    async getChainId() {
        const hex = await this.rpcCall("eth_chainId", []);
        return parseInt(hex, 16);
    }
    async getTransactionReceipt(txHash) {
        try {
            const receipt = await this.rpcCall("eth_getTransactionReceipt", [txHash]);
            // R7-B6d: a successful query with no receipt = the tx is NOT on this
            // chain. Report it honestly as found:false instead of conflating with
            // an RPC failure (null).
            if (!receipt) {
                return { found: false, confirmed: false, status: "pending" };
            }
            const blockNum = parseInt(receipt.blockNumber, 16);
            const chainHead = await this.getBlockNumber();
            const chainId = await this.getChainId();
            if (this.config.chainId !== undefined && chainId !== this.config.chainId) {
                // R7-B7c: rethrow past the catch — this provider is misconfigured.
                throw new ChainMismatchError(`RPC provider ${this.config.providerId} returned chain ${chainId}; expected ${this.config.chainId}`);
            }
            const status = receipt.status === "0x1" ? "success" : "reverted";
            return {
                found: true,
                confirmed: status === "success",
                blockNumber: blockNum,
                status,
                logs: (receipt.logs ?? []).map((l) => ({
                    address: l.address,
                    topics: l.topics,
                    data: l.data,
                    logIndex: parseInt(l.logIndex, 16),
                })),
                confirmations: chainHead - blockNum,
                chainId,
                gasUsed: receipt.gasUsed !== undefined ? String(BigInt(receipt.gasUsed)) : undefined,
            };
        }
        catch (err) {
            // R7-B7c: chain mismatch is a configuration error — surface it.
            if (err instanceof ChainMismatchError)
                throw err;
            return null;
        }
    }
    /**
     * §6: Check authorizationState(authorizer, nonce)
     * Uses eth_call to the EIP-3009 token contract.
     */
    async checkAuthorizationState(tokenContract, authorizer, nonce) {
        try {
            const chainHead = await this.getBlockNumber();
            const chainId = await this.getChainId();
            if (this.config.chainId !== undefined && chainId !== this.config.chainId) {
                throw new Error(`RPC provider ${this.config.providerId} returned chain ${chainId}; expected ${this.config.chainId}`);
            }
            const selector = keccak256(toBytes("authorizationState(address,bytes32)")).slice(0, 10);
            const paddedAuthorizer = authorizer.toLowerCase().replace("0x", "").padStart(64, "0");
            const paddedNonce = nonce.replace("0x", "").padStart(64, "0");
            const callData = selector + paddedAuthorizer + paddedNonce;
            const result = await this.rpcCall("eth_call", [
                { to: tokenContract, data: callData },
                "latest",
            ]);
            // R7-B7e (external audit 2026-10-26): a malformed answer ("0x", wrong
            // length) is NOT authorizationState=false. Treating it as false lets a
            // unanimous-malformed panel declare NOT_SETTLED and re-open a payment
            // whose authorization may be consumed. Fail the provider instead —
            // the §11 fail-closed gates then keep the intent in RECONCILING.
            const hex = (value) => {
                if (typeof value !== "string" || !value.startsWith("0x"))
                    return null;
                return value;
            };
            const raw = hex(result);
            if (raw === null || (raw !== "0x" && raw.length !== 66)) {
                throw new Error(`Malformed authorizationState eth_call result from ${this.config.providerId}: ${String(result).slice(0, 66)}`);
            }
            const state = BigInt(raw) !== 0n;
            const staleness = 0; // "latest" block
            return {
                state,
                blockNumber: chainHead,
                chainHead,
                stalenessBlocks: staleness,
            };
        }
        catch (err) {
            return {
                state: null,
                blockNumber: -1,
                chainHead: -1,
                stalenessBlocks: -1,
                error: err instanceof Error ? err.message : "Unknown RPC error",
            };
        }
    }
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
    async findAuthorizationUsedEventStrict(tokenContract, authorizer, nonce, fromBlock, toBlock) {
        const topic0 = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
        const paddedAuthorizer = "0x" + authorizer.toLowerCase().replace("0x", "").padStart(64, "0");
        const paddedNonce = "0x" + nonce.replace("0x", "").padStart(64, "0");
        for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += LOG_SCAN_CHUNK) {
            const chunkEnd = Math.min(chunkStart + LOG_SCAN_CHUNK - 1, toBlock);
            const logs = await this.rpcCall("eth_getLogs", [{
                    address: tokenContract,
                    topics: [topic0, paddedAuthorizer, paddedNonce],
                    fromBlock: "0x" + chunkStart.toString(16),
                    toBlock: "0x" + chunkEnd.toString(16),
                }]);
            if (logs && logs.length > 0) {
                const log = logs[0];
                return {
                    transactionHash: log.transactionHash,
                    blockNumber: parseInt(log.blockNumber, 16),
                    logIndex: parseInt(log.logIndex, 16),
                };
            }
        }
        return null;
    }
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
    async findAuthorizationUsedEvent(tokenContract, authorizer, nonce, fromBlock, toBlock) {
        try {
            // P0-4: Real AuthorizationUsed event signature
            // keccak256("AuthorizationUsed(address,bytes32)")
            // = 0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5
            // Computed from the ABI below — never trust hand-copied constants.
            const topic0 = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
            const paddedAuthorizer = "0x" + authorizer.toLowerCase().replace("0x", "").padStart(64, "0");
            const paddedNonce = "0x" + nonce.replace("0x", "").padStart(64, "0");
            // R7-B7d: chunked scan (see findAuthorizationUsedEventStrict).
            for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += LOG_SCAN_CHUNK) {
                const chunkEnd = Math.min(chunkStart + LOG_SCAN_CHUNK - 1, toBlock);
                const logs = await this.rpcCall("eth_getLogs", [{
                        address: tokenContract,
                        topics: [topic0, paddedAuthorizer, paddedNonce],
                        fromBlock: "0x" + chunkStart.toString(16),
                        toBlock: "0x" + chunkEnd.toString(16),
                    }]);
                if (logs && logs.length > 0) {
                    const log = logs[0];
                    return {
                        transactionHash: log.transactionHash,
                        blockNumber: parseInt(log.blockNumber, 16),
                        logIndex: parseInt(log.logIndex, 16),
                    };
                }
            }
            return null;
        }
        catch {
            return null;
        }
    }
}
// ---------------------------------------------------------------------------
// Multi-RPC Checker (§14, §15)
// ---------------------------------------------------------------------------
/**
 * R7-B7a: canonical consensus projection. Compares ONLY the fields that must
 * agree for a settlement verdict; volatile per-provider observations
 * (confirmations derived from each provider's own head, chainId when unset)
 * are excluded. Everything else (status, blockNumber, logs content, auth
 * state, found-flag) still must match byte-for-byte.
 */
function canonicalConsensusJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value ?? null);
    const record = value;
    const canonical = {};
    for (const key of Object.keys(record).sort()) {
        if (key === "confirmations" || key === "chainId")
            continue; // provider-head-derived / config-echo
        canonical[key] = record[key];
    }
    return JSON.stringify(canonical);
}
export class MultiRpcChecker {
    providers;
    configs;
    finalityPolicy;
    constructor(configs, finalityPolicy = DEFAULT_FINALITY_POLICY) {
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
    aggregateResults(results) {
        const successful = results.filter(r => r.result !== null);
        const failed = results.filter(r => r.result === null);
        if (successful.length === 0) {
            return { observations: results, agreement: "ALL_FAILED" };
        }
        if (successful.length < 2) {
            return { observations: results, agreement: "INSUFFICIENT" };
        }
        // Check unanimity over the canonical settlement-relevant projection.
        const first = canonicalConsensusJson(successful[0].result);
        const allAgree = successful.every(r => canonicalConsensusJson(r.result) === first);
        if (allAgree) {
            const consensus = successful[0].result;
            // Conservative confirmations: min across providers (their heads differ).
            const confirmationsList = successful
                .map(r => r.result?.confirmations)
                .filter((c) => typeof c === "number");
            if (confirmationsList.length === successful.length && confirmationsList.length > 0 && typeof consensus === "object" && consensus !== null && "confirmations" in consensus) {
                consensus.confirmations = Math.min(...confirmationsList);
            }
            return { observations: results, agreement: "UNANIMOUS", unanimousValue: consensus };
        }
        return { observations: results, agreement: "DISAGREEMENT" };
    }
    /**
     * §17: Check transaction by txHash across all providers.
     */
    async checkTransaction(txHash) {
        const results = await Promise.all(this.providers.map(async (provider, i) => {
            const config = this.configs[i];
            try {
                const result = await provider.getTransactionReceipt(txHash);
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    result,
                    observedAt: Date.now(),
                };
            }
            catch (err) {
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    result: null,
                    error: err instanceof Error ? err.message : "Unknown error",
                    observedAt: Date.now(),
                };
            }
        }));
        return this.aggregateResults(results);
    }
    async findAuthorizationUsedEvent(tokenContract, authorizer, nonce, fromBlock = 0, toBlock) {
        const results = await Promise.all(this.providers.map(async (provider, i) => {
            const config = this.configs[i];
            try {
                const endBlock = toBlock ?? await provider.getBlockNumber();
                const result = await provider.findAuthorizationUsedEvent(tokenContract, authorizer, nonce, fromBlock, endBlock);
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    result,
                    observedAt: Date.now(),
                };
            }
            catch (err) {
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    result: null,
                    error: err instanceof Error ? err.message : "Unknown error",
                    observedAt: Date.now(),
                };
            }
        }));
        return this.aggregateResults(results);
    }
    /**
     * §6 + §14: Check authorizationState across all providers.
     */
    async checkAuthorizationState(tokenContract, authorizer, nonce) {
        const results = await Promise.all(this.providers.map(async (provider, i) => {
            const config = this.configs[i];
            try {
                const authResult = await provider.checkAuthorizationState(tokenContract, authorizer, nonce);
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    result: authResult.state,
                    error: authResult.error,
                    // F-002: carry the real block context so §11-D can gate on it and
                    // the NOT_SETTLED evidence records actual provider observations
                    // instead of zeroed placeholders.
                    ...(authResult.state === null ? {} : {
                        blockData: {
                            blockNumber: authResult.blockNumber,
                            chainHead: authResult.chainHead,
                            stalenessBlocks: authResult.stalenessBlocks,
                        },
                    }),
                    observedAt: Date.now(),
                };
            }
            catch (err) {
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    result: null,
                    error: err instanceof Error ? err.message : "Unknown error",
                    observedAt: Date.now(),
                };
            }
        }));
        return this.aggregateResults(results);
    }
    /**
     * F-002 (external audit Blocker): HONEST multi-provider AuthorizationUsed
     * scan. Distinguishes the three cases the legacy aggregate-based API could
     * not: (a) every provider executed the scan and found nothing,
     * (b) at least one provider failed to scan, (c) providers disagree.
     * Only (a) — SCAN_COMPLETE_EMPTY — may ever back a terminal NOT_SETTLED.
     */
    async scanAuthorizationUsed(tokenContract, authorizer, nonce, fromBlock = 0) {
        const observations = await Promise.all(this.providers.map(async (provider, i) => {
            const config = this.configs[i];
            try {
                // Freshness witness: the head MUST be observed from the same
                // provider immediately before its scan; an empty result is only
                // meaningful against the head it actually covered.
                const chainHead = await provider.getBlockNumber();
                const event = await provider.findAuthorizationUsedEventStrict(tokenContract, authorizer, nonce, fromBlock, chainHead);
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    scanned: true,
                    event,
                    fromBlock,
                    toBlock: chainHead,
                    chainHead,
                    observedAt: Date.now(),
                };
            }
            catch (err) {
                return {
                    providerId: config.providerId,
                    underlyingProvider: config.underlyingProvider,
                    scanned: false,
                    event: null,
                    fromBlock,
                    toBlock: 0,
                    chainHead: 0,
                    error: err instanceof Error ? err.message : "Unknown error",
                    observedAt: Date.now(),
                };
            }
        }));
        const allScanned = observations.every(o => o.scanned);
        const found = observations.filter(o => o.scanned && o.event !== null);
        if (!allScanned) {
            return { observations, outcome: "INCOMPLETE" };
        }
        if (found.length === observations.length) {
            return { observations, outcome: "EVENT_FOUND", event: found[0].event };
        }
        if (found.length === 0) {
            return { observations, outcome: "SCAN_COMPLETE_EMPTY" };
        }
        return { observations, outcome: "DISAGREEMENT" };
    }
    /**
     * §11: Determine if NOT_SETTLED can be declared.
     * Requires: validBefore expired + all RPCs agree false + fresh chain heads.
     */
    canDeclareNotSettled(authResult, validBefore, currentTime) {
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
        // §11-D: Check chain freshness — REAL check (F-002). Every successful
        // observation must carry block context witnessed by its own provider and
        // be inside that provider's staleness budget. A missing or negative
        // blockData means we cannot prove WHEN the authorization was read, so a
        // terminal NOT_SETTLED (which re-enables new payments) must not issue.
        for (const obs of authResult.observations) {
            if (obs.result === null)
                continue; // failed providers already rejected by unanimity
            const bd = obs.blockData;
            if (!bd || bd.blockNumber < 0 || bd.chainHead < 0 || bd.stalenessBlocks < 0) {
                return {
                    allowed: false,
                    reason: `§11-D: provider ${obs.providerId} produced no fresh block data — cannot declare NOT_SETTLED`,
                };
            }
            const budget = this.configs.find(c => c.providerId === obs.providerId)?.maxStalenessBlocks;
            if (budget === undefined) {
                return {
                    allowed: false,
                    reason: `§11-D: unknown provider ${obs.providerId} — no staleness budget configured`,
                };
            }
            if (bd.stalenessBlocks > budget) {
                return {
                    allowed: false,
                    reason: `§11-D: provider ${obs.providerId} stale — ${bd.stalenessBlocks} blocks behind head (budget ${budget})`,
                };
            }
        }
        return { allowed: true, reason: "All §11 conditions met" };
    }
    getFinalityPolicy() {
        return this.finalityPolicy;
    }
}
// ---------------------------------------------------------------------------
// Mock implementations for testing
// ---------------------------------------------------------------------------
export class MockMultiRpcChecker {
    txResults = new Map();
    authResults = new Map();
    authorizationUsedEvents = new Map();
    providerResults = new Map(); // providerId -> nonce -> state
    providerConfigs;
    constructor(providerConfigs) {
        this.providerConfigs = providerConfigs ?? [
            { providerId: "mock-alchemy", underlyingProvider: "alchemy", rpcUrl: "mock://alchemy", maxStalenessBlocks: 5 },
            { providerId: "mock-infura", underlyingProvider: "infura", rpcUrl: "mock://infura", maxStalenessBlocks: 5 },
        ];
    }
    setTxResult(txHash, result) {
        this.txResults.set(txHash.toLowerCase(), result);
    }
    setAuthResult(nonce, state) {
        this.authResults.set(nonce.toLowerCase(), state);
    }
    setAuthorizationUsedEvent(nonce, result) {
        this.authorizationUsedEvents.set(nonce.toLowerCase(), result);
    }
    /** Set per-provider auth result (for disagreement tests) */
    setProviderAuthResult(providerId, nonce, state) {
        if (!this.providerResults.has(providerId)) {
            this.providerResults.set(providerId, new Map());
        }
        this.providerResults.get(providerId).set(nonce.toLowerCase(), state);
    }
    async checkTransaction(txHash) {
        const result = this.txResults.get(txHash.toLowerCase()) ?? null;
        const observations = this.providerConfigs.map(c => ({
            providerId: c.providerId,
            underlyingProvider: c.underlyingProvider,
            result,
            observedAt: Date.now(),
        }));
        if (result === null)
            return { observations, agreement: "ALL_FAILED" };
        return { observations, agreement: "UNANIMOUS", unanimousValue: result };
    }
    async checkAuthorizationState(_tokenContract, _authorizer, nonce) {
        const observations = this.providerConfigs.map(c => {
            // Per-provider override takes precedence
            const providerOverride = this.providerResults.get(c.providerId)?.get(nonce.toLowerCase());
            const globalResult = this.authResults.get(nonce.toLowerCase());
            const result = providerOverride !== undefined ? providerOverride : (globalResult ?? null);
            return {
                providerId: c.providerId,
                underlyingProvider: c.underlyingProvider,
                result,
                // F-002: mock parity — observations carry the same real block context
                // the production checker produces, so §11-D gating is exercised.
                ...(result === null ? {} : {
                    blockData: { blockNumber: 100, chainHead: 100, stalenessBlocks: 0 },
                }),
                observedAt: Date.now(),
            };
        });
        const successful = observations.filter(o => o.result !== null);
        if (successful.length < 2)
            return { observations, agreement: successful.length === 0 ? "ALL_FAILED" : "INSUFFICIENT" };
        const first = successful[0].result;
        const allAgree = successful.every(o => o.result === first);
        if (allAgree)
            return { observations, agreement: "UNANIMOUS", unanimousValue: first };
        return { observations, agreement: "DISAGREEMENT" };
    }
    /**
     * F-002: Mock parity for the honest AuthorizationUsed scan.
     * Default: every provider scanned [0, 1000] and found nothing
     * (SCAN_COMPLETE_EMPTY). Tests override via setScanOutcome().
     */
    scanOutcomes = new Map();
    scanAuthorizationUsedCallCount = 0;
    setScanOutcome(nonce, outcome, event) {
        this.scanOutcomes.set(nonce.toLowerCase(), { outcome, event: event ?? null });
    }
    async scanAuthorizationUsed(_tokenContract, _authorizer, nonce) {
        this.scanAuthorizationUsedCallCount += 1;
        const programmed = this.scanOutcomes.get(nonce.toLowerCase());
        const outcome = programmed?.outcome ?? "SCAN_COMPLETE_EMPTY";
        const foundEvent = outcome === "EVENT_FOUND"
            ? (programmed?.event ?? { transactionHash: "0xscanfound", blockNumber: 90, logIndex: 0 })
            : null;
        const observations = this.providerConfigs.map(c => ({
            providerId: c.providerId,
            underlyingProvider: c.underlyingProvider,
            // INCOMPLETE simulates a provider whose scan never executed.
            scanned: outcome !== "INCOMPLETE",
            event: outcome === "EVENT_FOUND" ? foundEvent : null,
            fromBlock: 0,
            toBlock: 1000,
            chainHead: 1000,
            observedAt: Date.now(),
        }));
        return {
            observations,
            outcome,
            ...(foundEvent ? { event: foundEvent } : {}),
        };
    }
    async findAuthorizationUsedEvent(_tokenContract, _authorizer, nonce) {
        const result = this.authorizationUsedEvents.get(nonce.toLowerCase()) ?? null;
        const observations = this.providerConfigs.map(c => ({
            providerId: c.providerId,
            underlyingProvider: c.underlyingProvider,
            result,
            observedAt: Date.now(),
        }));
        if (!result)
            return { observations, agreement: "ALL_FAILED" };
        return { observations, agreement: "UNANIMOUS", unanimousValue: result };
    }
    canDeclareNotSettled(authResult, validBefore, currentTime) {
        if (currentTime < validBefore)
            return { allowed: false, reason: "validBefore not expired" };
        if (authResult.agreement !== "UNANIMOUS")
            return { allowed: false, reason: `agreement: ${authResult.agreement}` };
        if (authResult.unanimousValue !== false)
            return { allowed: false, reason: "state not false" };
        return { allowed: true, reason: "All conditions met" };
    }
    getFinalityPolicy() {
        return DEFAULT_FINALITY_POLICY;
    }
}
//# sourceMappingURL=multi-rpc-checker.js.map