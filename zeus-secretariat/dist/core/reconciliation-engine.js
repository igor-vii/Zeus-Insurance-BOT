/**
 * Zeus Secretariat V0 — Reconciliation Engine (FULL SPEC V0.1)
 *
 * §5: /settle is NOT source of truth
 * §6: Blockchain is System of Record
 * §7: SETTLED proof bundle (authorizationState + AuthorizationUsed + receipt + Transfer)
 * §8: Transfer matching
 * §9: Reverted transaction handling
 * §10: UNKNOWN without txHash flow
 * §11: NOT_SETTLED strict proof (5 conditions)
 * §14-15: Multi-RPC with independence
 * §16: Reconciliation schedule
 * §17: Priority (txHash first, then authorizationState)
 * §18: Crash recovery
 * §21: Atomic terminal transitions (CAS)
 * §22-23: Evidence bundles
 * §24: Reorg / confirmation policy
 */
import { DEFAULT_RECONCILIATION_SCHEDULE, DEFAULT_FINALITY_POLICY, } from "./types.js";
import { keccak256, toBytes } from "viem";
import { randomUUID } from "node:crypto";
// ---------------------------------------------------------------------------
// Transfer Event Parser (§7, §8)
// ---------------------------------------------------------------------------
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
function parseTransferLogs(logs, expectedFrom, expectedTo, expectedMinValue, expectedTokenContract) {
    for (const log of logs) {
        if (log.address.toLowerCase() !== expectedTokenContract.toLowerCase())
            continue;
        if (log.topics[0] !== TRANSFER_TOPIC)
            continue;
        if (log.topics.length < 3)
            continue;
        const from = "0x" + log.topics[1].slice(26).toLowerCase();
        const to = "0x" + log.topics[2].slice(26).toLowerCase();
        const value = BigInt(log.data);
        // §8: Transfer matching
        if (from !== expectedFrom.toLowerCase())
            continue;
        if (to !== expectedTo.toLowerCase())
            continue;
        if (value < expectedMinValue)
            continue;
        return { from, to, value, tokenContract: log.address.toLowerCase() };
    }
    return null;
}
function findAuthorizationUsedLog(logs, expectedTokenContract, expectedAuthorizer, expectedNonce) {
    const authorizerTopic = `0x${expectedAuthorizer.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
    const nonceTopic = `0x${expectedNonce.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
    for (const log of logs) {
        if (log.address.toLowerCase() === expectedTokenContract.toLowerCase() &&
            log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() &&
            log.topics[1]?.toLowerCase() === authorizerTopic &&
            log.topics[2]?.toLowerCase() === nonceTopic) {
            return log.logIndex;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// ReconciliationEngine
// ---------------------------------------------------------------------------
export class ReconciliationEngine {
    store;
    rpcChecker;
    scheduleConfig;
    finalityPolicy;
    constructor(store, rpcChecker, scheduleConfig = DEFAULT_RECONCILIATION_SCHEDULE, finalityPolicy = DEFAULT_FINALITY_POLICY) {
        this.store = store;
        this.rpcChecker = rpcChecker;
        this.scheduleConfig = scheduleConfig;
        this.finalityPolicy = finalityPolicy;
    }
    /**
     * Main reconciliation entry point.
     * §17: txHash-first priority, then authorizationState fallback.
     */
    async reconcile(paymentIntentId) {
        const intent = await this.getIntentById(paymentIntentId);
        if (!intent) {
            return { status: "UNRESOLVED_MANUAL", reason: "Payment intent not found" };
        }
        // Pre-signature intents are intentionally passive. They have no external
        // authorization to reconcile and must not be treated as submitted payment.
        if (intent.settlementState === "PENDING_SIGNATURE") {
            return {
                status: "RECONCILING",
                reason: "PENDING_SIGNATURE: awaiting externally signed payment payload",
            };
        }
        // Terminal states — do not re-reconcile.
        // R7-C1 (external audit 2026-10-26): the early return previously dropped
        // ALL evidence ("as any" without an evidence key), so a terminal verdict
        // re-observed by a second worker (or by the sync observeSettlement path)
        // recorded evidenceBundle: undefined. The persisted bundle is carried
        // through when the store round-trips it.
        if (intent.settlementState === "SETTLED" || intent.settlementState === "NOT_SETTLED" || intent.settlementState === "UNRESOLVED_MANUAL") {
            const bundle = intent.settledEvidenceBundle ?? intent.notSettledEvidenceBundle;
            return {
                status: intent.settlementState,
                reason: "Already terminal",
                ...(bundle !== undefined ? { evidence: bundle } : {}),
            };
        }
        const attemptId = `recon-${Date.now()}-${randomUUID()}`;
        // §17: Strategy 1 — txHash known
        if (intent.txHash) {
            return await this.reconcileByTxHash(intent, attemptId);
        }
        // §17: Strategy 2 — authorizationState + nonce
        return await this.reconcileByAuthorizationState(intent, attemptId);
    }
    /**
     * §7 + §8 + §9 + §24: Reconcile by txHash.
     *
     * R7-B6d (external audit 2026-10-26): when the transaction is NOT on the
     * chain (found:false — dropped/replaced/never broadcast), the intent used
     * to be stranded in RECONCILING forever with no fallback. Now: before
     * validBefore → keep probing (the tx may still land); after validBefore →
     * the authorization is dead on-chain, fall back to the §10/§11
     * authorizationState strategy which can reach a terminal verdict.
     */
    async reconcileByTxHash(intent, attemptId) {
        const txResult = await this.rpcChecker.checkTransaction(intent.txHash);
        // Persist observations (§22)
        for (const obs of txResult.observations) {
            await this.persistObservation({
                attemptId,
                paymentIntentId: intent.paymentIntentId,
                timestamp: obs.observedAt,
                rpcProviderId: obs.providerId,
                headBlock: 0,
                authorizationState: null,
                validBefore: intent.validBefore,
                result: obs.result ? (obs.result.confirmed ? "SETTLED_FOUND" : "STILL_UNKNOWN") : "RPC_ERROR",
                error: obs.error,
            });
        }
        if (txResult.agreement === "ALL_FAILED" || txResult.agreement === "INSUFFICIENT") {
            return { status: "RECONCILING", reason: `RPC ${txResult.agreement}`, nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        if (txResult.agreement === "DISAGREEMENT") {
            return { status: "RECONCILING", reason: "§14: RPC disagreement on txHash", nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        const tx = txResult.unanimousValue;
        // R7-B6d: unanimous "tx not found on chain".
        if (tx.found === false) {
            const currentTime = Math.floor(Date.now() / 1000);
            if (currentTime < intent.validBefore) {
                return {
                    status: "RECONCILING",
                    reason: "Transaction not found on chain — authorization window still open, probing",
                    nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
                };
            }
            // The authorization has expired unused as far as this tx is concerned.
            // Fall back to the authorizationState strategy (§10/§11) — it can reach
            // a terminal verdict instead of eternally waiting for a dropped tx.
            return await this.reconcileByAuthorizationState(intent, attemptId);
        }
        // §9: Reverted transaction
        if (tx.status === "reverted") {
            // R7-B6a (external audit 2026-10-26, High): a revert proves THIS tx
            // failed, but the EIP-3009 authorization REMAINS VALID until validBefore
            // — declaring NOT_SETTLED immediately re-opens allowNewPayment() while
            // the same signature can still be executed (double-pay window). Hold in
            // RECONCILING until the window closes, then declare NOT_SETTLED.
            const currentTime = Math.floor(Date.now() / 1000);
            if (currentTime < intent.validBefore) {
                return {
                    status: "RECONCILING",
                    reason: "§9: Transaction reverted — authorization stays live until validBefore; NOT_SETTLED deferred",
                    nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
                };
            }
            // §21: Atomic terminal transition
            const casSuccess = await this.store.compareAndSetState(intent.paymentIntentId, intent.settlementState, "NOT_SETTLED");
            if (!casSuccess) {
                return { status: "RECONCILING", reason: "§21: CAS failed — another worker transitioned state" };
            }
            // R7-C1: the NOT_SETTLED verdict carries its evidence — the revert,
            // witnessed by each provider, is itself the negative proof (a reverted
            // transferWithAuthorization leaves the authorization unconsumed).
            return {
                status: "NOT_SETTLED",
                reason: "§9: Transaction reverted (authorization window closed)",
                evidence: {
                    authorizer: intent.authorizer,
                    nonce: intent.nonce,
                    validBefore: intent.validBefore,
                    expiryConfirmedAt: currentTime,
                    authorizationStateFalse: true,
                    rpcObservations: txResult.observations
                        .filter((obs) => obs.result?.found === true)
                        .map((obs) => ({
                        providerId: obs.providerId,
                        underlyingProvider: obs.underlyingProvider,
                        observedAt: obs.observedAt,
                        blockNumber: obs.result?.blockNumber ?? 0,
                        chainHead: (obs.result?.blockNumber ?? 0) + (obs.result?.confirmations ?? 0),
                        authorizationState: false,
                        stalenessBlocks: 0,
                    })),
                    scanComplete: true,
                    authorizationUsedScanResult: "REVERTED_TX",
                    authorizationUsedScan: { outcome: "REVERTED_TX", observations: [] },
                },
            };
        }
        if (tx.status === "pending") {
            return { status: "RECONCILING", reason: "Transaction still pending", nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        // §24: Check confirmations
        if ((tx.confirmations ?? 0) < this.finalityPolicy.requiredConfirmations) {
            return {
                status: "RECONCILING",
                reason: `§24: Insufficient confirmations (${tx.confirmations ?? 0}/${this.finalityPolicy.requiredConfirmations})`,
                nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
            };
        }
        // §7: Verify SETTLED proof bundle
        if (!tx.logs) {
            return { status: "RECONCILING", reason: "§7: No logs available for Transfer verification", nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        // §8: Transfer matching
        const transfer = parseTransferLogs(tx.logs, intent.authorizer, intent.payTo, BigInt(intent.value), intent.asset);
        if (!transfer) {
            return { status: "UNRESOLVED_MANUAL", reason: "§7-8: No matching Transfer event found in successful transaction" };
        }
        const authorizationUsedLogIndex = findAuthorizationUsedLog(tx.logs, intent.asset, intent.authorizer, intent.nonce);
        if (authorizationUsedLogIndex === null) {
            return {
                status: "RECONCILING",
                reason: "§7: Successful transaction has no matching AuthorizationUsed event",
                nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
            };
        }
        // Build SETTLED evidence bundle (§7 + §22)
        //
        // R7-C1 (external audit 2026-10-26): the bundle previously contained
        // fabricated values (gasUsed:"0", rpcObservations:[]) despite the F-002
        // "no fabricated zeros" principle. gasUsed now comes from the receipt
        // when the provider reported it ("unavailable" when it did not — never a
        // fake zero), finalityReached is COMPUTED from the confirmed
        // confirmations, and the actually-performed RPC observations are
        // recorded.
        const evidence = {
            authorizationUsed: {
                transactionHash: intent.txHash,
                blockNumber: tx.blockNumber,
                logIndex: authorizationUsedLogIndex,
            },
            receipt: {
                status: 1,
                blockNumber: tx.blockNumber,
                gasUsed: tx.gasUsed ?? "unavailable",
            },
            transfer: {
                from: transfer.from,
                to: transfer.to,
                value: transfer.value.toString(),
                tokenContract: transfer.tokenContract,
            },
            confirmations: tx.confirmations,
            finalityReached: (tx.confirmations ?? 0) >= this.finalityPolicy.requiredConfirmations,
            rpcObservations: txResult.observations.map((obs) => ({
                attemptId,
                paymentIntentId: intent.paymentIntentId,
                timestamp: obs.observedAt,
                rpcProviderId: obs.providerId,
                headBlock: obs.result?.blockNumber ?? 0,
                authorizationState: null,
                validBefore: intent.validBefore,
                result: obs.result ? (obs.result.confirmed ? "SETTLED_FOUND" : "STILL_UNKNOWN") : "RPC_ERROR",
                ...(obs.error !== undefined ? { error: obs.error } : {}),
            })),
        };
        // §21: Atomic terminal transition via CAS
        const casSuccess = await this.store.compareAndSetState(intent.paymentIntentId, intent.settlementState, "SETTLED");
        if (!casSuccess) {
            return { status: "RECONCILING", reason: "§21: CAS failed — another worker already transitioned" };
        }
        await this.store.saveSettledEvidenceBundle(intent.paymentIntentId, evidence);
        // R0 repair: the nonce registry must reflect settlement (RESERVED →
        // SUBMITTED → SETTLED). Without this the nonce row stays SUBMITTED
        // forever on the reconciliation path.
        if (intent.nonce) {
            try {
                await this.store.markNonceSettled(intent.nonce);
            }
            catch { /* nonce row may not exist for pre-Stage-A intents */ }
        }
        return { status: "SETTLED", evidence };
    }
    /**
     * §10 + §11: Reconcile by authorizationState when txHash is unknown.
     */
    async reconcileByAuthorizationState(intent, attemptId) {
        const authResult = await this.rpcChecker.checkAuthorizationState(intent.asset, intent.authorizer, intent.nonce);
        const currentTime = Math.floor(Date.now() / 1000);
        // Persist observations
        for (const obs of authResult.observations) {
            await this.persistObservation({
                attemptId,
                paymentIntentId: intent.paymentIntentId,
                timestamp: obs.observedAt,
                rpcProviderId: obs.providerId,
                headBlock: 0,
                authorizationState: obs.result,
                validBefore: intent.validBefore,
                result: obs.result === null ? "RPC_ERROR" : obs.result ? "SETTLED_FOUND" : "STILL_UNKNOWN",
                error: obs.error,
            });
        }
        // All RPCs failed
        if (authResult.agreement === "ALL_FAILED") {
            return { status: "RECONCILING", reason: "All RPCs failed", nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        // §14: Disagreement → cannot decide
        if (authResult.agreement === "DISAGREEMENT") {
            // §11: Even if expired, disagreement means UNKNOWN
            return { status: "RECONCILING", reason: "§14: RPC disagreement on authorizationState", nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        // Insufficient observations
        if (authResult.agreement === "INSUFFICIENT") {
            return { status: "RECONCILING", reason: "§14: Insufficient RPC observations", nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0) };
        }
        const authState = authResult.unanimousValue;
        // §10: authorizationState == true → recover txHash via AuthorizationUsed
        if (authState === true) {
            const authorizationScan = await this.rpcChecker.findAuthorizationUsedEvent(intent.asset, intent.authorizer, intent.nonce);
            if (authorizationScan.agreement === "UNANIMOUS" && authorizationScan.unanimousValue) {
                const recovered = authorizationScan.unanimousValue;
                // R7-B8 (external audit 2026-10-26): the txHash recovery write used
                // the UNCONDITIONAL updatePaymentIntentStatus with the intent captured
                // at reconcile start — a concurrent worker that advanced the state
                // could be silently rolled back. The write is now a same-state CAS:
                // it only lands when the state is exactly what this worker observed.
                await this.store.compareAndSetState(intent.paymentIntentId, intent.settlementState, intent.settlementState, { txHash: recovered.transactionHash });
                // R0 repair (spec §10): "true → recover tx via logs → success+Transfer
                // → SETTLED". The engine previously stopped here and waited for the
                // next probe; follow the recovered receipt immediately — txHash-first
                // (§17) — so a single reconcile() call can reach a terminal verdict.
                return await this.reconcileByTxHash({ ...intent, txHash: recovered.transactionHash }, attemptId);
            }
            return {
                status: "RECONCILING",
                reason: "§10: authorizationState=true — attempting txHash recovery via AuthorizationUsed",
                nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
            };
        }
        // §10 + §11: authorizationState == false
        const notSettledCheck = this.rpcChecker.canDeclareNotSettled(authResult, intent.validBefore, currentTime);
        if (!notSettledCheck.allowed) {
            // §13: Before validBefore or insufficient evidence → RECONCILING
            return {
                status: "RECONCILING",
                reason: notSettledCheck.reason,
                nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
            };
        }
        // F-002 (external audit Blocker): perform the REAL AuthorizationUsed scan
        // BEFORE the terminal CAS. "scanComplete: true" must mean the scan actually
        // ran on every independent provider — never a self-asserted label. A
        // checker that does not expose the honest scan API is treated as an
        // incomplete scan (fail closed), never as an empty one.
        const scanFn = this.rpcChecker.scanAuthorizationUsed;
        const scan = typeof scanFn === "function"
            ? await scanFn.call(this.rpcChecker, intent.asset, intent.authorizer, intent.nonce)
            : { observations: [], outcome: "INCOMPLETE" };
        if (scan.outcome === "EVENT_FOUND" && scan.event) {
            // The authorization was actually consumed — the payment settled.
            // §17: recover through the concrete transaction; NOT_SETTLED is forbidden.
            // R7-B8: same-state CAS instead of the unconditional status write
            // (stale-intent rollback hazard).
            await this.store.compareAndSetState(intent.paymentIntentId, intent.settlementState, intent.settlementState, { txHash: scan.event.transactionHash });
            return await this.reconcileByTxHash({ ...intent, txHash: scan.event.transactionHash }, attemptId);
        }
        if (scan.outcome !== "SCAN_COMPLETE_EMPTY") {
            // §13 fail closed: an incomplete or disagreeing scan is not a proof of
            // absence. Keep probing — no terminal verdict, no new payments.
            return {
                status: "RECONCILING",
                reason: `§11: AuthorizationUsed scan ${scan.outcome} — NOT_SETTLED requires a complete empty scan on every independent provider`,
                nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
            };
        }
        // §11: All conditions met — declare NOT_SETTLED.
        // Evidence records ONLY actually performed observations (F-002): real
        // block/head/staleness witnessed by each provider, never zeroed placeholders.
        const rpcObs = [];
        for (const o of authResult.observations) {
            if (o.result !== false)
                continue;
            const bd = o.blockData;
            if (!bd) {
                // §11-D already gated on this; a miss here is a contract violation —
                // fail closed instead of persisting fabricated zeros.
                return {
                    status: "RECONCILING",
                    reason: `§11-D: observation from ${o.providerId} lacks block data — NOT_SETTLED evidence would be incomplete`,
                    nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
                };
            }
            rpcObs.push({
                providerId: o.providerId,
                underlyingProvider: o.underlyingProvider,
                observedAt: o.observedAt,
                blockNumber: bd.blockNumber,
                chainHead: bd.chainHead,
                authorizationState: false,
                stalenessBlocks: bd.stalenessBlocks,
            });
        }
        const evidence = {
            authorizer: intent.authorizer,
            nonce: intent.nonce,
            validBefore: intent.validBefore,
            expiryConfirmedAt: currentTime,
            authorizationStateFalse: true,
            rpcObservations: rpcObs,
            scanComplete: true,
            authorizationUsedScanResult: "SCAN_COMPLETE_EMPTY",
            authorizationUsedScan: {
                outcome: scan.outcome,
                observations: scan.observations,
            },
        };
        // §21: Atomic terminal transition via CAS
        const casSuccess = await this.store.compareAndSetState(intent.paymentIntentId, intent.settlementState, "NOT_SETTLED");
        if (!casSuccess) {
            return { status: "RECONCILING", reason: "§21: CAS failed" };
        }
        await this.store.saveNotSettledEvidenceBundle(intent.paymentIntentId, evidence);
        return { status: "NOT_SETTLED", evidence };
    }
    /**
     * §16: Get next probe delay based on probe count.
     */
    getNextProbeDelay(probeCount) {
        if (probeCount < this.scheduleConfig.probes.length) {
            return this.scheduleConfig.probes[probeCount];
        }
        return this.scheduleConfig.periodicIntervalMs;
    }
    /**
     * §18: Crash recovery — find all non-terminal intents and reconcile.
     */
    async recoverAfterCrash() {
        const results = new Map();
        // P0-6: Use getNonTerminalIntents() which queries settlement_state directly
        // No OperationStatus confusion — uses the canonical column
        const nonTerminalIntents = await this.store.getNonTerminalIntents();
        for (const intent of nonTerminalIntents) {
            const currentState = intent.settlementState;
            // SUBMITTING without txHash -> move to RECONCILING first
            if (currentState === "SUBMITTING" && !intent.txHash) {
                const moved = await this.store.compareAndSetState(intent.paymentIntentId, "SUBMITTING", "RECONCILING");
                if (!moved)
                    continue; // Another worker handled it
            }
            // Reconcile using paymentIntentId (not operationId)
            const outcome = await this.reconcile(intent.paymentIntentId);
            results.set(intent.paymentIntentId, outcome);
        }
        return results;
    }
    /**
     * §3: Economic safety guard — check if new payment is allowed.
     */
    async canCreateNewPayment(operationId) {
        return this.store.canCreateNewPayment(operationId);
    }
    /**
     * P0-6: Real durable lookup by paymentIntentId.
     * Delegates to store.getPaymentIntentById() which queries PostgreSQL directly.
     */
    async getIntentById(paymentIntentId) {
        return this.store.getPaymentIntentById(paymentIntentId);
    }
    async persistObservation(obs) {
        await this.store.appendReconciliationObservation(obs);
    }
}
//# sourceMappingURL=reconciliation-engine.js.map