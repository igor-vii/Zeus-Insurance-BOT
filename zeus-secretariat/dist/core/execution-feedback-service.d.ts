/**
 * A1-B: Production FSM feedback for post-settlement execution results.
 *
 * Closes the proven audit gap (A1 Finding #2): PostSettlementEngine.processJob()
 * updated durable job/attempt/evidence state but never fed the result back into
 * the Operation FSM, so the durable Operation stayed at SETTLED forever.
 *
 * Chain: EXECUTION job → processJob() → Execution result → FSM feedback →
 *        Operation durable state (via Secretariat.getOperation/saveOperation).
 *
 * Canonical mapping table (A1 spec §3) — MUST NOT be changed elsewhere:
 *   SUCCESS           → EXECUTION_PENDING → EXECUTION_CONFIRMED → DELIVERED → SUCCESS
 *   HTTP_FAILURE      → EXECUTION_PENDING → FAILED
 *   DELIVERY_UNKNOWN  → EXECUTION_PENDING → EXECUTION_UNKNOWN   (NOT FAILED!)
 *   UNRESOLVABLE      → EXECUTION_PENDING → EXECUTION_UNKNOWN (honest stop;
 *                      the real FSM has NO EXECUTION_UNKNOWN→UNRESOLVABLE edge —
 *                      see ALLOWED_EDGES note below. Authoritative UNRESOLVABLE
 *                      lives in durable job/attempt state and is fast-forwarded
 *                      into currentState on restart by postgres-store
 *                      deriveCurrentState.)
 *   RUNNING / FAILED(job-level) / COMPLETED → no feedback (transient/job lifecycle)
 *
 * CRITICAL INVARIANT: DELIVERY_UNKNOWN ≠ FAILED under any conditions.
 * This is the same semantic boundary as B6-B (payment accepted + no delivery ≠ FAILURE).
 *
 * No new FSM. Only existing VALID_TRANSITIONS edges are used
 * (state-machine.ts: SETTLED→EXECUTION_PENDING; EXECUTION_PENDING→{EXECUTION_CONFIRMED,
 * EXECUTION_UNKNOWN, FAILED}; EXECUTION_CONFIRMED→DELIVERED; DELIVERED→SUCCESS;
 * EXECUTION_UNKNOWN→UNRESOLVABLE is NOT in VALID_TRANSITIONS, so EXECUTION_UNKNOWN
 * is the honest terminal observation state for UNRESOLVABLE unless the operation
 * already sits at EXECUTION_UNKNOWN, in which case we record evidence only).
 */
import type { Operation, OperationStatus } from "./types.js";
import type { ExecutionObligationStatus, RecoveryJobStatus } from "./post-settlement-engine.js";
export interface OperationPersistence {
    getOperation(operationId: string): Promise<Operation | null>;
    saveOperation(operation: Operation): Promise<void>;
}
/**
 * Returns the ordered FSM transitions to apply for a given processJob()
 * finalStatus, or null when NO feedback must be applied (RUNNING = fence
 * rejected / job still in flight; job-lifecycle statuses are not attempt
 * outcomes).
 */
export declare function planExecutionTransitions(finalStatus: ExecutionObligationStatus | RecoveryJobStatus): OperationStatus[] | null;
export declare class ExecutionFeedbackService {
    private readonly ops;
    constructor(ops: OperationPersistence);
    /**
     * Apply the execution result of a processed EXECUTION job to the Operation FSM.
     * Reads durable state via getOperation(), transitions via existing FSM semantics,
     * records STATE_TRANSITION evidence, and persists via saveOperation().
     *
     * Idempotent: if the operation is already at (or beyond) the target terminal
     * state, no duplicate transitions/evidence are produced.
     */
    applyResult(operationId: string, finalStatus: ExecutionObligationStatus | RecoveryJobStatus, extra?: {
        jobId?: string;
        statusCode?: number;
        reason?: string;
    }): Promise<{
        applied: boolean;
        currentState: OperationStatus | null;
    }>;
    private applySideEffects;
    private pushEvidence;
}
//# sourceMappingURL=execution-feedback-service.d.ts.map