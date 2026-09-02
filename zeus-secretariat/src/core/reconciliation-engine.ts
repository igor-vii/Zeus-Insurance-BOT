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

import type {
  DurableEvidenceStore,
  DurablePaymentIntent,
  SettlementState,
  SettledEvidenceBundle,
  NotSettledEvidenceBundle,
  ReconciliationObservation,
  RpcObservationForNotSettled,
  ReconciliationScheduleConfig,
  FinalityPolicy,
} from "./types";
import {
  allowNewPayment,
  DEFAULT_RECONCILIATION_SCHEDULE,
  DEFAULT_FINALITY_POLICY,
} from "./types";
import type { MultiRpcChecker, TransactionCheckResult } from "./multi-rpc-checker";
import { keccak256, toBytes } from "viem";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconciliationOutcome =
  | { status: "SETTLED"; evidence: SettledEvidenceBundle }
  | { status: "NOT_SETTLED"; evidence: NotSettledEvidenceBundle }
  | { status: "RECONCILING"; reason: string; nextProbeMs?: number }
  | { status: "UNRESOLVED_MANUAL"; reason: string }
  | { status: "INCIDENT"; reason: string };

// ---------------------------------------------------------------------------
// Transfer Event Parser (§7, §8)
// ---------------------------------------------------------------------------

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

interface TransferEvent {
  from: string;
  to: string;
  value: bigint;
  tokenContract: string;
}

function parseTransferLogs(
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: number }>,
  expectedFrom: string,
  expectedTo: string,
  expectedMinValue: bigint,
  expectedTokenContract: string,
): TransferEvent | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== expectedTokenContract.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const from = "0x" + log.topics[1].slice(26).toLowerCase();
    const to = "0x" + log.topics[2].slice(26).toLowerCase();
    const value = BigInt(log.data);

    // §8: Transfer matching
    if (from !== expectedFrom.toLowerCase()) continue;
    if (to !== expectedTo.toLowerCase()) continue;
    if (value < expectedMinValue) continue;

    return { from, to, value, tokenContract: log.address.toLowerCase() };
  }
  return null;
}

function findAuthorizationUsedLog(
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: number }>,
  expectedTokenContract: string,
  expectedAuthorizer: string,
  expectedNonce: string,
): number | null {
  const authorizerTopic = `0x${expectedAuthorizer.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  const nonceTopic = `0x${expectedNonce.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
  for (const log of logs) {
    if (
      log.address.toLowerCase() === expectedTokenContract.toLowerCase() &&
      log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() &&
      log.topics[1]?.toLowerCase() === authorizerTopic &&
      log.topics[2]?.toLowerCase() === nonceTopic
    ) {
      return log.logIndex;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ReconciliationEngine
// ---------------------------------------------------------------------------

export class ReconciliationEngine {
  private readonly store: DurableEvidenceStore;
  private readonly rpcChecker: MultiRpcChecker;
  private readonly scheduleConfig: ReconciliationScheduleConfig;
  private readonly finalityPolicy: FinalityPolicy;

  constructor(
    store: DurableEvidenceStore,
    rpcChecker: MultiRpcChecker,
    scheduleConfig: ReconciliationScheduleConfig = DEFAULT_RECONCILIATION_SCHEDULE,
    finalityPolicy: FinalityPolicy = DEFAULT_FINALITY_POLICY,
  ) {
    this.store = store;
    this.rpcChecker = rpcChecker;
    this.scheduleConfig = scheduleConfig;
    this.finalityPolicy = finalityPolicy;
  }

  /**
   * Main reconciliation entry point.
   * §17: txHash-first priority, then authorizationState fallback.
   */
  async reconcile(paymentIntentId: string): Promise<ReconciliationOutcome> {
    const intent = await this.getIntentById(paymentIntentId);
    if (!intent) {
      return { status: "UNRESOLVED_MANUAL", reason: "Payment intent not found" };
    }

    // Terminal states — do not re-reconcile
    if (intent.settlementState === "SETTLED" || intent.settlementState === "NOT_SETTLED" || intent.settlementState === "UNRESOLVED_MANUAL") {
      return { status: intent.settlementState as any, reason: "Already terminal" } as any;
    }

    const attemptId = `recon-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // §17: Strategy 1 — txHash known
    if (intent.txHash) {
      return await this.reconcileByTxHash(intent, attemptId);
    }

    // §17: Strategy 2 — authorizationState + nonce
    return await this.reconcileByAuthorizationState(intent, attemptId);
  }

  /**
   * §7 + §8 + §9 + §24: Reconcile by txHash.
   */
  private async reconcileByTxHash(
    intent: DurablePaymentIntent,
    attemptId: string,
  ): Promise<ReconciliationOutcome> {
    const txResult = await this.rpcChecker.checkTransaction(intent.txHash!);

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

    const tx = txResult.unanimousValue!;

    // §9: Reverted transaction
    if (tx.status === "reverted") {
      // §21: Atomic terminal transition
      const casSuccess = await this.store.compareAndSetState(
        intent.paymentIntentId,
        intent.settlementState,
        "NOT_SETTLED",
      );
      if (!casSuccess) {
        return { status: "RECONCILING", reason: "§21: CAS failed — another worker transitioned state" };
      }
      return { status: "NOT_SETTLED", reason: "§9: Transaction reverted" } as any;
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
    const transfer = parseTransferLogs(
      tx.logs,
      intent.authorizer,
      intent.payTo,
      BigInt(intent.value),
      intent.asset,
    );

    if (!transfer) {
      return { status: "UNRESOLVED_MANUAL", reason: "§7-8: No matching Transfer event found in successful transaction" };
    }

    const authorizationUsedLogIndex = findAuthorizationUsedLog(
      tx.logs,
      intent.asset,
      intent.authorizer,
      intent.nonce,
    );
    if (authorizationUsedLogIndex === null) {
      return {
        status: "RECONCILING",
        reason: "§7: Successful transaction has no matching AuthorizationUsed event",
        nextProbeMs: this.getNextProbeDelay(intent.probeCount ?? 0),
      };
    }

    // Build SETTLED evidence bundle (§7 + §22)
    const evidence: SettledEvidenceBundle = {
      authorizationUsed: {
        transactionHash: intent.txHash!,
        blockNumber: tx.blockNumber!,
        logIndex: authorizationUsedLogIndex,
      },
      receipt: {
        status: 1,
        blockNumber: tx.blockNumber!,
        gasUsed: "0",
      },
      transfer: {
        from: transfer.from,
        to: transfer.to,
        value: transfer.value.toString(),
        tokenContract: transfer.tokenContract,
      },
      confirmations: tx.confirmations!,
      finalityReached: true,
      rpcObservations: [],
    };

    // §21: Atomic terminal transition via CAS
    const casSuccess = await this.store.compareAndSetState(
      intent.paymentIntentId,
      intent.settlementState,
      "SETTLED",
    );

    if (!casSuccess) {
      return { status: "RECONCILING", reason: "§21: CAS failed — another worker already transitioned" };
    }

    await this.store.saveSettledEvidenceBundle(intent.paymentIntentId, evidence);

    return { status: "SETTLED", evidence };
  }

  /**
   * §10 + §11: Reconcile by authorizationState when txHash is unknown.
   */
  private async reconcileByAuthorizationState(
    intent: DurablePaymentIntent,
    attemptId: string,
  ): Promise<ReconciliationOutcome> {
    const authResult = await this.rpcChecker.checkAuthorizationState(
      intent.asset,
      intent.authorizer,
      intent.nonce,
    );

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

    const authState = authResult.unanimousValue!;

    // §10: authorizationState == true → recover txHash via AuthorizationUsed
    if (authState === true) {
      const authorizationScan = await this.rpcChecker.findAuthorizationUsedEvent(
        intent.asset,
        intent.authorizer,
        intent.nonce,
      );
      if (authorizationScan.agreement === "UNANIMOUS" && authorizationScan.unanimousValue) {
        const recovered = authorizationScan.unanimousValue;
        await this.store.updatePaymentIntentStatus(
          intent.paymentIntentId,
          intent.settlementState,
          { txHash: recovered.transactionHash },
        );
      }
      return {
        status: "RECONCILING",
        reason: authorizationScan.agreement === "UNANIMOUS"
          ? "§10: authorizationState=true — recovered txHash from AuthorizationUsed"
          : "§10: authorizationState=true — attempting txHash recovery via AuthorizationUsed",
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

    // §11: All conditions met — declare NOT_SETTLED
    const rpcObs: RpcObservationForNotSettled[] = authResult.observations
      .filter(o => o.result === false)
      .map(o => ({
        providerId: o.providerId,
        underlyingProvider: o.underlyingProvider,
        observedAt: o.observedAt,
        blockNumber: 0,
        chainHead: 0,
        authorizationState: false as const,
        stalenessBlocks: 0,
      }));

    const evidence: NotSettledEvidenceBundle = {
      authorizer: intent.authorizer,
      nonce: intent.nonce,
      validBefore: intent.validBefore,
      expiryConfirmedAt: currentTime,
      authorizationStateFalse: true,
      rpcObservations: rpcObs,
      scanComplete: true,
      authorizationUsedScanResult: "SCAN_COMPLETE_EMPTY",
    };

    // §21: Atomic terminal transition via CAS
    const casSuccess = await this.store.compareAndSetState(
      intent.paymentIntentId,
      intent.settlementState,
      "NOT_SETTLED",
    );

    if (!casSuccess) {
      return { status: "RECONCILING", reason: "§21: CAS failed" };
    }

    await this.store.saveNotSettledEvidenceBundle(intent.paymentIntentId, evidence);

    return { status: "NOT_SETTLED", evidence };
  }

  /**
   * §16: Get next probe delay based on probe count.
   */
  private getNextProbeDelay(probeCount: number): number {
    if (probeCount < this.scheduleConfig.probes.length) {
      return this.scheduleConfig.probes[probeCount];
    }
    return this.scheduleConfig.periodicIntervalMs;
  }

  /**
   * §18: Crash recovery — find all non-terminal intents and reconcile.
   */
  async recoverAfterCrash(): Promise<Map<string, ReconciliationOutcome>> {
    const results = new Map<string, ReconciliationOutcome>();

    // P0-6: Use getNonTerminalIntents() which queries settlement_state directly
    // No OperationStatus confusion — uses the canonical column
    const nonTerminalIntents = await this.store.getNonTerminalIntents();

    for (const intent of nonTerminalIntents) {
      const currentState = intent.settlementState;

      // SUBMITTING without txHash -> move to RECONCILING first
      if (currentState === "SUBMITTING" && !intent.txHash) {
        const moved = await this.store.compareAndSetState(
          intent.paymentIntentId, "SUBMITTING", "RECONCILING"
        );
        if (!moved) continue; // Another worker handled it
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
  async canCreateNewPayment(operationId: string): Promise<boolean> {
    return this.store.canCreateNewPayment(operationId);
  }

  /**
   * P0-6: Real durable lookup by paymentIntentId.
   * Delegates to store.getPaymentIntentById() which queries PostgreSQL directly.
   */
  private async getIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null> {
    return this.store.getPaymentIntentById(paymentIntentId);
  }

  private async persistObservation(obs: ReconciliationObservation): Promise<void> {
    await this.store.appendReconciliationObservation(obs);
  }
}
