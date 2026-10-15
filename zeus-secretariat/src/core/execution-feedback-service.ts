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

import type { Operation, OperationStatus, EvidenceRecord } from "./types.js";
import type { ExecutionObligationStatus, RecoveryJobStatus } from "./post-settlement-engine.js";

// ---------------------------------------------------------------------------
// Minimal store contract — satisfied by Secretariat (getOperation/saveOperation)
// and by InMemoryStore. We do NOT introduce a new persistence mechanism.
// ---------------------------------------------------------------------------

export interface OperationPersistence {
  getOperation(operationId: string): Promise<Operation | null>;
  saveOperation(operation: Operation): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure transition plan (single source of truth for the mapping table)
// ---------------------------------------------------------------------------

/**
 * Returns the ordered FSM transitions to apply for a given processJob()
 * finalStatus, or null when NO feedback must be applied (RUNNING = fence
 * rejected / job still in flight; job-lifecycle statuses are not attempt
 * outcomes).
 */
export function planExecutionTransitions(
  finalStatus: ExecutionObligationStatus | RecoveryJobStatus,
): OperationStatus[] | null {
  switch (finalStatus) {
    case "SUCCESS":
      return ["EXECUTION_PENDING", "EXECUTION_CONFIRMED", "DELIVERED", "SUCCESS"];
    case "HTTP_FAILURE":
      return ["EXECUTION_PENDING", "FAILED"];
    case "DELIVERY_UNKNOWN":
      // CRITICAL: DELIVERY_UNKNOWN ≠ FAILED. Never map to FAILED.
      return ["EXECUTION_PENDING", "EXECUTION_UNKNOWN"];
    case "UNRESOLVABLE":
      // Same observable chain as DELIVERY_UNKNOWN: stop at EXECUTION_UNKNOWN.
      // We do NOT fabricate an EXECUTION_UNKNOWN→UNRESOLVABLE FSM edge (audit #7 /
      // §4 decision): UNRESOLVABLE stays authoritative in durable job/attempt
      // state and is reflected into currentState by postgres-store
      // deriveCurrentState on restart reconstruction.
      return ["EXECUTION_PENDING", "EXECUTION_UNKNOWN"];
    case "RUNNING":
    case "PENDING":
    case "ATTEMPTED":
    case "COMPLETED":
    case "FAILED":
      // RUNNING: fence rejected or job still processing — worker will retry.
      // FAILED/COMPLETED: job-lifecycle statuses, not attempt outcomes.
      // PENDING/ATTEMPTED: non-terminal obligation statuses.
      return null;
    default:
      return null;
  }
}

// Existing FSM edges (mirrors VALID_TRANSITIONS in state-machine.ts).
const ALLOWED_EDGES: Record<string, OperationStatus[]> = {
  SETTLED: ["EXECUTION_PENDING", "EXECUTION_UNKNOWN"],
  EXECUTION_PENDING: ["EXECUTION_CONFIRMED", "EXECUTION_UNKNOWN", "FAILED"],
  EXECUTION_CONFIRMED: ["DELIVERED", "FAILED"],
  DELIVERED: ["SUCCESS"],
  // NOTE (audit finding #4): the real FSM has NO EXECUTION_UNKNOWN→UNRESOLVABLE
  // edge (state-machine.ts:115 — EXECUTION_UNKNOWN → RECOVERY_PENDING | FAILED;
  // UNRESOLVABLE is reachable only from RECOVERY_PENDING). We do NOT add new
  // edges to the authoritative FSM. The feedback path stops at EXECUTION_UNKNOWN
  // for UNRESOLVABLE results and records that honestly via
  // EXECUTION_FEEDBACK_SKIPPED evidence. UNRESOLVABLE remains authoritative in
  // durable job/attempt state (recovery_jobs / execution_attempts) and in
  // currentState when reconstructed after restart (see postgres-store
  // deriveCurrentState fallback).
  EXECUTION_UNKNOWN: ["RECOVERY_PENDING", "FAILED"],
};

function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return ALLOWED_EDGES[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// ExecutionFeedbackService
// ---------------------------------------------------------------------------

export class ExecutionFeedbackService {
  constructor(private readonly ops: OperationPersistence) {}

  /**
   * Apply the execution result of a processed EXECUTION job to the Operation FSM.
   * Reads durable state via getOperation(), transitions via existing FSM semantics,
   * records STATE_TRANSITION evidence, and persists via saveOperation().
   *
   * Idempotent: if the operation is already at (or beyond) the target terminal
   * state, no duplicate transitions/evidence are produced.
   */
  async applyResult(
    operationId: string,
    finalStatus: ExecutionObligationStatus | RecoveryJobStatus,
    extra?: { jobId?: string; statusCode?: number; reason?: string },
  ): Promise<{ applied: boolean; currentState: OperationStatus | null }> {
    const plan = planExecutionTransitions(finalStatus);
    if (!plan) return { applied: false, currentState: null };

    const operation = await this.ops.getOperation(operationId);
    if (!operation) return { applied: false, currentState: null };

    // Idempotency guard: if already at a terminal state, do not re-apply.
    const TERMINAL: OperationStatus[] = ["SUCCESS", "FAILED", "UNRESOLVABLE", "POLICY_REJECTED", "SETTLEMENT_FAILED", "RECOVERED"];
    if (TERMINAL.includes(operation.currentState)) {
      return { applied: false, currentState: operation.currentState };
    }

    let appliedAny = false;
    for (const next of plan) {
      if (operation.currentState === next) continue; // already there (restart mid-chain)
      if (!canTransition(operation.currentState, next)) {
        // Edge not present in the existing FSM — stop applying further steps.
        // Honest behavior: keep current durable state, record why.
        this.pushEvidence(operation, "EXECUTION_FEEDBACK_SKIPPED", {
          attemptedFrom: operation.currentState,
          attemptedTo: next,
          reason: "transition not present in existing VALID_TRANSITIONS",
          finalStatus,
        });
        break;
      }

      const from = operation.currentState;
      operation.currentState = next;
      operation.timestamps.updatedAt = Date.now();
      this.applySideEffects(operation, next, extra);
      this.pushEvidence(operation, "STATE_TRANSITION", { from, to: next, finalStatus, ...extra });
      appliedAny = true;
    }

    // Audit finding #2: save ONLY when something actually changed. A no-op
    // (no transitions applied and no skip recorded) must never re-append the
    // last evidence record on duplicate polling iterations.
    if (appliedAny) {
      await this.ops.saveOperation(operation);
    }
    return { applied: appliedAny, currentState: operation.currentState };
  }

  private applySideEffects(
    operation: Operation,
    state: OperationStatus,
    extra?: { jobId?: string; statusCode?: number; reason?: string },
  ): void {
    switch (state) {
      case "EXECUTION_PENDING":
        operation.executionState = "PENDING";
        operation.deliveryState = "PENDING";
        break;
      case "EXECUTION_CONFIRMED":
        operation.executionState = "CONFIRMED";
        operation.timestamps.executionConfirmedAt = Date.now();
        break;
      case "DELIVERED":
        operation.deliveryState = "DELIVERED";
        operation.timestamps.deliveredAt = Date.now();
        break;
      case "SUCCESS":
        operation.paymentState = "SETTLED";
        operation.executionState = "CONFIRMED";
        operation.deliveryState = "DELIVERED";
        operation.timestamps.completedAt = Date.now();
        break;
      case "FAILED":
        operation.executionState = "FAILED";
        operation.deliveryState = "FAILED";
        operation.timestamps.failedAt = Date.now();
        break;
      case "EXECUTION_UNKNOWN":
        // Payment succeeded, delivery unknown — NOT a failure (B6-B boundary).
        operation.executionState = "UNKNOWN";
        operation.deliveryState = "UNKNOWN";
        break;
      case "UNRESOLVABLE":
        operation.executionState = "UNKNOWN";
        operation.deliveryState = "UNKNOWN";
        break;
      default:
        break;
    }
  }

  private pushEvidence(operation: Operation, event: string, payload: unknown): void {
    const record: EvidenceRecord = {
      operationId: operation.operationId,
      phase: "EXECUTION",
      timestamp: Date.now(),
      event,
      payload,
    };
    operation.evidence.push(record);
  }
}
