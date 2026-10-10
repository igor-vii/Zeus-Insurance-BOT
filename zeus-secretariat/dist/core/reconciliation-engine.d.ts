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
import type { DurableEvidenceStore, SettledEvidenceBundle, NotSettledEvidenceBundle, ReconciliationScheduleConfig, FinalityPolicy } from "./types.js";
import type { MultiRpcChecker } from "./multi-rpc-checker.js";
export type ReconciliationOutcome = {
    status: "SETTLED";
    evidence: SettledEvidenceBundle;
} | {
    status: "NOT_SETTLED";
    evidence: NotSettledEvidenceBundle;
} | {
    status: "RECONCILING";
    reason: string;
    nextProbeMs?: number;
} | {
    status: "UNRESOLVED_MANUAL";
    reason: string;
} | {
    status: "INCIDENT";
    reason: string;
};
export declare class ReconciliationEngine {
    private readonly store;
    private readonly rpcChecker;
    private readonly scheduleConfig;
    private readonly finalityPolicy;
    constructor(store: DurableEvidenceStore, rpcChecker: MultiRpcChecker, scheduleConfig?: ReconciliationScheduleConfig, finalityPolicy?: FinalityPolicy);
    /**
     * Main reconciliation entry point.
     * §17: txHash-first priority, then authorizationState fallback.
     */
    reconcile(paymentIntentId: string): Promise<ReconciliationOutcome>;
    /**
     * §7 + §8 + §9 + §24: Reconcile by txHash.
     */
    private reconcileByTxHash;
    /**
     * §10 + §11: Reconcile by authorizationState when txHash is unknown.
     */
    private reconcileByAuthorizationState;
    /**
     * §16: Get next probe delay based on probe count.
     */
    private getNextProbeDelay;
    /**
     * §18: Crash recovery — find all non-terminal intents and reconcile.
     */
    recoverAfterCrash(): Promise<Map<string, ReconciliationOutcome>>;
    /**
     * §3: Economic safety guard — check if new payment is allowed.
     */
    canCreateNewPayment(operationId: string): Promise<boolean>;
    /**
     * P0-6: Real durable lookup by paymentIntentId.
     * Delegates to store.getPaymentIntentById() which queries PostgreSQL directly.
     */
    private getIntentById;
    private persistObservation;
}
//# sourceMappingURL=reconciliation-engine.d.ts.map