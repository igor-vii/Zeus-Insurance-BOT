/**
 * Zeus Secretariat V0 - Core Domain Types
 *
 * Architectural Principle:
 * Build an independent Zeus Secretariat. Reuse proven x402 implementation patterns where useful,
 * but do not import Syra's architecture, dependencies, retry semantics, or economic assumptions.
 * The Secretariat owns the operation state machine, payment intent lifecycle, settlement observation,
 * execution observation, recovery policy, and durable evidence.
 */
/**
 * §3: Economic safety invariant — the ONLY state that permits a new payment.
 * This is enforced at DB level via allowNewPayment() guard.
 */
export function allowNewPayment(state) {
    return state === "NOT_SETTLED";
}
/** All states that BLOCK new payment creation. */
export const PAYMENT_BLOCKED_STATES = [
    "PENDING_SIGNATURE",
    "AUTHORIZED",
    "SUBMITTING",
    "SUBMITTED",
    "SETTLEMENT_PENDING",
    "RECONCILING",
    "SETTLED",
    "UNRESOLVED_MANUAL",
];
export function toDisplayState(state) {
    const map = {
        PENDING_SIGNATURE: "PAYMENT_PENDING_SIGNATURE",
        AUTHORIZED: "PAYMENT_AUTHORIZED",
        SUBMITTING: "PAYMENT_SUBMITTING",
        SUBMITTED: "PAYMENT_SUBMITTED",
        SETTLEMENT_PENDING: "PAYMENT_SETTLEMENT_PENDING",
        RECONCILING: "PAYMENT_RECONCILING",
        SETTLED: "PAYMENT_SETTLED",
        NOT_SETTLED: "PAYMENT_NOT_SETTLED",
        UNRESOLVED_MANUAL: "PAYMENT_UNRESOLVED_MANUAL",
    };
    return map[state];
}
export const DEFAULT_RECONCILIATION_SCHEDULE = {
    probes: [2_000, 10_000, 30_000, 120_000],
    periodicIntervalMs: 60_000,
    safetyBufferAfterExpiryMs: 120_000,
};
export const DEFAULT_FINALITY_POLICY = {
    requiredConfirmations: 12,
    reorgIncidentThreshold: 6,
};
//# sourceMappingURL=types.js.map