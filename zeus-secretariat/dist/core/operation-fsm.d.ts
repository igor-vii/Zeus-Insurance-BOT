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
import type { OperationStatus } from "./types.js";
export declare const VALID_TRANSITIONS: Record<OperationStatus, OperationStatus[]>;
export declare function isValidTransition(from: OperationStatus, to: OperationStatus): boolean;
//# sourceMappingURL=operation-fsm.d.ts.map