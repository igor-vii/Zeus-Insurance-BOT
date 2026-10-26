/**
 * F-110 (external audit 2026-10-26, Minor): SINGLE SOURCE OF TRUTH for the
 * Operation FSM transition table.
 *
 * The table previously lived in state-machine.ts AND was hand-mirrored as
 * `ALLOWED_EDGES` in execution-feedback-service.ts ("mirrors VALID_TRANSITIONS
 * in state-machine.ts"). Hand-mirrors drift silently: any edge added or
 * removed in the authoritative FSM left the execution-feedback copy stale,
 * and the two modules then disagreed about which transitions are legal.
 * Both callers now import from this leaf module — no heavy transitive
 * imports (types only), no import cycles.
 */
export const VALID_TRANSITIONS = {
    CREATED: ['DISCOVERING', 'FAILED'],
    DISCOVERING: ['PAYMENT_REQUIRED', 'SUCCESS', 'FAILED'],
    PAYMENT_REQUIRED: ['AWAITING_SIGNATURE', 'AUTHORIZED', 'POLICY_REJECTED', 'FAILED'],
    AWAITING_SIGNATURE: ['AUTHORIZED', 'FAILED'],
    AUTHORIZED: ['PAYMENT_SUBMITTED', 'FAILED'],
    // R7-A6 (external audit 2026-10-26, Critical): UNRESOLVABLE must be
    // reachable from every post-submission settlement state. The previous
    // table made UNRESOLVED_MANUAL / INCIDENT reconciliation outcomes THROW
    // ("Invalid state transition") inside observeSettlement, which the
    // execute() catch-all then collapsed to terminal FAILED — representing
    // "money MAY have moved, outcome unknown" as a definitive failure.
    // From the moment a payment is submitted the honest terminal for an
    // unresolvable settlement is UNRESOLVABLE, never FAILED.
    PAYMENT_SUBMITTED: ['SETTLEMENT_PENDING', 'SETTLEMENT_UNKNOWN', 'SETTLED', 'SETTLEMENT_FAILED', 'UNRESOLVABLE'],
    SETTLEMENT_PENDING: ['SETTLED', 'SETTLEMENT_UNKNOWN', 'SETTLEMENT_FAILED', 'UNRESOLVABLE'],
    SETTLEMENT_UNKNOWN: ['SETTLED', 'SETTLEMENT_FAILED', 'UNRESOLVABLE'],
    SETTLED: ['EXECUTION_PENDING', 'EXECUTION_UNKNOWN'],
    EXECUTION_PENDING: ['EXECUTION_CONFIRMED', 'EXECUTION_UNKNOWN', 'FAILED'],
    EXECUTION_CONFIRMED: ['DELIVERED', 'FAILED'],
    DELIVERED: ['SUCCESS'],
    SUCCESS: [], // Terminal state
    FAILED: [], // Terminal state
    POLICY_REJECTED: [], // Terminal state
    SETTLEMENT_FAILED: ['FAILED'],
    EXECUTION_UNKNOWN: ['RECOVERY_PENDING', 'FAILED'],
    RECOVERY_PENDING: ['RECOVERED', 'SUCCESS', 'UNRESOLVABLE', 'FAILED'],
    RECOVERED: [], // Terminal state
    UNRESOLVABLE: [], // Terminal state,
};
export function isValidTransition(from, to) {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
//# sourceMappingURL=operation-fsm.js.map