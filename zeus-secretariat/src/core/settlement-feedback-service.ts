/**
 * R7-A7 (external audit 2026-10-26, Critical): Settlement feedback for the
 * Operation FSM from the async reconciliation path.
 *
 * GAP: the synchronous path (StateMachine.observeSettlement) maps a
 * ReconciliationOutcome onto the Operation, but when reconciliation completes
 * ASYNCHRONOUSLY (ReconciliationWorker probing a durable job — the common
 * case, because the first probe rarely has `requiredConfirmations`), only the
 * JOB lifecycle was closed: the durable Operation stayed in
 * SETTLEMENT_PENDING forever, the public API kept reporting PROCESSING, and
 * the seller call was reached only through the scanner back-stop.
 *
 * This module mirrors ExecutionFeedbackService (execution results) for
 * SETTLEMENT results. Same store contract (getOperation/saveOperation), same
 * evidence discipline (STATE_TRANSITION records with sequence), same
 * idempotency (already-applied states are skipped, terminal states are never
 * re-entered).
 *
 * Canonical mapping (R7-A7):
 *   SETTLED           → [* → SETTLED]                              (then execution handoff / scanner)
 *   NOT_SETTLED       → [* → SETTLEMENT_FAILED → FAILED]           (definitive: authorization provably unused)
 *   UNRESOLVED_MANUAL → [* → UNRESOLVABLE]                         (honest terminal, R7-A6 edges)
 *   INCIDENT          → [* → UNRESOLVABLE]                         (honest terminal, R7-A6 edges)
 *   RECONCILING       → no feedback (non-terminal; job rescheduled)
 */

import type { Operation, OperationStatus, DurablePaymentIntent } from "./types.js";
import type { ReconciliationOutcome } from "./reconciliation-engine.js";
import { isValidTransition as canTransition } from "./operation-fsm.js";
import { isStandardPaidCallRecord, STANDARD_PAID_CALL_MARKER } from "./standard-x402-transport.js";

// ---------------------------------------------------------------------------
// Minimal store contract — satisfied by every DurableEvidenceStore
// (PostgresEvidenceStore, InMemoryStore, test fakes).
// ---------------------------------------------------------------------------

export interface OperationPersistence {
  getOperation(operationId: string): Promise<Operation | null>;
  saveOperation(operation: Operation): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure transition plan (single source of truth for the mapping table)
// ---------------------------------------------------------------------------

/**
 * Returns the ordered FSM transitions to apply for a given reconciliation
 * outcome, or null when NO feedback must be applied (RECONCILING keeps the
 * operation in its current non-terminal state; the job reschedule is the
 * only effect).
 */
export function planSettlementTransitions(
  outcome: Pick<ReconciliationOutcome, "status">,
): OperationStatus[] | null {
  switch (outcome.status) {
    case "SETTLED":
      return ["SETTLED"];
    case "NOT_SETTLED":
      // Definitive negative: the authorization provably expired unused
      // (§11 five conditions / §9 revert after window close). The operation
      // cannot silently stay "pending" — and it must not lie FAILED either:
      // SETTLEMENT_FAILED is the honest intermediate, FAILED the honest
      // terminal. Both edges exist in the FSM.
      return ["SETTLEMENT_FAILED", "FAILED"];
    case "UNRESOLVED_MANUAL":
    case "INCIDENT":
      // R7-A6: honest terminal for "money may have moved, outcome unknown".
      // Reachable since the FSM gained PAYMENT_SUBMITTED/SETTLEMENT_PENDING/
      // SETTLEMENT_UNKNOWN → UNRESOLVABLE edges.
      return ["UNRESOLVABLE"];
    case "RECONCILING":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SettlementFeedbackService
// ---------------------------------------------------------------------------

export class SettlementFeedbackService {
  constructor(
    private readonly ops: OperationPersistence,
    /**
     * R9-A1: optional durable intent reader. When present, SETTLED outcomes
     * for STANDARD_PAID_CALL intents are completed inline (the paid call
     * discharged execution atomically — see docs/standard-x402-transport.md).
     */
    private readonly durable?: {
      getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null>;
    },
  ) {}

  /**
   * Apply a reconciliation outcome to the Operation FSM.
   * Reads durable state via getOperation(), transitions via the authoritative
   * FSM (operation-fsm.ts), records STATE_TRANSITION evidence, persists via
   * saveOperation().
   *
   * Idempotent: if the operation already sits at (or beyond) the target state,
   * no duplicate transitions/evidence are produced and nothing is saved.
   */
  async applyOutcome(
    operationId: string,
    outcome: ReconciliationOutcome,
    extra?: { paymentIntentId?: string },
  ): Promise<{ applied: boolean; currentState: OperationStatus | null }> {
    const plan = planSettlementTransitions(outcome);
    if (!plan) return { applied: false, currentState: null };

    const operation = await this.ops.getOperation(operationId);
    if (!operation) return { applied: false, currentState: null };

    // Idempotency guard: already at a terminal state — do not re-apply.
    const TERMINAL: OperationStatus[] = [
      "SUCCESS", "FAILED", "UNRESOLVABLE", "POLICY_REJECTED", "RECOVERED",
    ];
    if (TERMINAL.includes(operation.currentState)) {
      return { applied: false, currentState: operation.currentState };
    }

    let appliedAny = false;
    let planSteps = plan;

    // R9-A1: standard-transport completion. The paid x402 call discharged
    // execution atomically — when reconciliation lands SETTLED there is NO
    // post-settlement seller leg to run. Complete the FSM inline:
    //   receipt body captured   → EXECUTION_PENDING → EXECUTION_CONFIRMED
    //                             → DELIVERED → SUCCESS (result = seller body)
    //   no body (e.g. paid call  → EXECUTION_UNKNOWN → RECOVERY_PENDING
    //   timed out post-settle)     → UNRESOLVABLE (money moved, result unknown)
    if (planSteps.includes("SETTLED") && this.durable && extra?.paymentIntentId) {
      const marker = await this.readStandardMarker(extra.paymentIntentId);
      if (marker) {
        const hasResult =
          (marker.sellerBody !== null && marker.sellerBody !== undefined) ||
          operation.executionEvidence?.source === "STANDARD_TRANSPORT";
        planSteps = [
          ...planSteps,
          ...(hasResult
            ? (["EXECUTION_PENDING", "EXECUTION_CONFIRMED", "DELIVERED", "SUCCESS"] as OperationStatus[])
            : (["EXECUTION_UNKNOWN", "RECOVERY_PENDING", "UNRESOLVABLE"] as OperationStatus[])),
        ];
        if (marker.sellerBody !== null && marker.sellerBody !== undefined) {
          operation.resultData = marker.sellerBody;
        }
        if (!operation.executionEvidence || operation.executionEvidence.source !== "STANDARD_TRANSPORT") {
          operation.executionEvidence = {
            statusCode: marker.sellerHttpStatus,
            body: marker.sellerBody ?? undefined,
            timestamp: marker.capturedAt,
            source: "STANDARD_TRANSPORT",
          };
        }
        operation.evidence.push({
          operationId: operation.operationId,
          phase: "EXECUTION",
          timestamp: Date.now(),
          event: "STANDARD_EXECUTION_DISCHARGED",
          payload: {
            note: hasResult
              ? "paid call delivered the result — completing inline from the STANDARD_PAID_CALL marker"
              : "settlement confirmed on-chain but the paid-call result was never received — honest UNRESOLVABLE",
            kind: STANDARD_PAID_CALL_MARKER,
            sellerHttpStatus: marker.sellerHttpStatus,
          },
          sequence: operation.evidence.length,
        } as unknown as import("./types.js").EvidenceRecord);
      }
    }

    for (const next of planSteps) {
      if (operation.currentState === next) continue; // already there (sync path won the race)
      if (!canTransition(operation.currentState, next)) {
        // Edge not present — stop applying further steps, record why.
        // Honest behavior: keep current durable state, record the skip.
        this.pushEvidence(operation, "SETTLEMENT_FEEDBACK_SKIPPED", {
          attemptedFrom: operation.currentState,
          attemptedTo: next,
          reason: "transition not present in VALID_TRANSITIONS",
          outcomeStatus: outcome.status,
        });
        break;
      }

      const from = operation.currentState;
      operation.currentState = next;
      operation.timestamps.updatedAt = Date.now();
      this.applySideEffects(operation, next, outcome);
      this.pushEvidence(operation, "STATE_TRANSITION", {
        from,
        to: next,
        outcomeStatus: outcome.status,
        ...(outcome.status === "SETTLED" || outcome.status === "NOT_SETTLED"
          ? {}
          : { reason: (outcome as { reason?: string }).reason }),
        ...extra,
      });
      appliedAny = true;
    }

    // Save ONLY when something actually changed — a no-op must never
    // re-append the last evidence record on duplicate polling iterations
    // (same discipline as ExecutionFeedbackService).
    if (appliedAny) {
      await this.ops.saveOperation(operation);
    }
    return { applied: appliedAny, currentState: operation.currentState };
  }

  private applySideEffects(
    operation: Operation,
    state: OperationStatus,
    outcome: ReconciliationOutcome,
  ): void {
    switch (state) {
      case "SETTLED":
        operation.paymentState = "SETTLED";
        operation.timestamps.settledAt = operation.timestamps.settledAt ?? Date.now();
        break;
      case "SETTLEMENT_FAILED":
        operation.paymentState = "FAILED";
        break;
      case "FAILED":
        operation.paymentState = "FAILED";
        operation.executionState = operation.executionState === "CONFIRMED" ? operation.executionState : "FAILED";
        operation.deliveryState = operation.deliveryState === "DELIVERED" ? operation.deliveryState : "FAILED";
        operation.timestamps.failedAt = operation.timestamps.failedAt ?? Date.now();
        break;
      case "UNRESOLVABLE":
        // Same convention as StateMachine.observeSettlement UNRESOLVED_MANUAL
        // / INCIDENT branches: payment is NOT declared failed (it may have
        // settled) — only the operation terminates as unresolvable.
        operation.paymentState = "FAILED";
        break;
      case "EXECUTION_PENDING":
        operation.executionState = operation.executionState === "CONFIRMED" ? operation.executionState : "PENDING";
        break;
      case "EXECUTION_CONFIRMED":
        operation.executionState = "CONFIRMED";
        operation.timestamps.executionConfirmedAt =
          operation.timestamps.executionConfirmedAt ?? Date.now();
        break;
      case "EXECUTION_UNKNOWN":
        operation.executionState = operation.executionState === "CONFIRMED" ? operation.executionState : "UNKNOWN";
        break;
      case "DELIVERED":
        operation.deliveryState = "DELIVERED";
        operation.timestamps.deliveredAt = operation.timestamps.deliveredAt ?? Date.now();
        break;
      case "SUCCESS":
        operation.deliveryState = operation.deliveryState === "DELIVERED" ? operation.deliveryState : "DELIVERED";
        operation.timestamps.completedAt = operation.timestamps.completedAt ?? Date.now();
        break;
      default:
        // SETTLED evidence bundle, when present in the outcome, is owned by
        // the ReconciliationEngine (saveSettledEvidenceBundle) — the FSM
        // feedback only records orchestration.
        void outcome;
        break;
    }
  }

  /**
   * R9-A1: read the durable STANDARD_PAID_CALL marker from the intent
   * (persisted by the standard transport right after the paid call).
   */
  private async readStandardMarker(
    paymentIntentId: string,
  ): Promise<import("./standard-x402-transport.js").StandardPaidCallRecord | null> {
    if (!this.durable) return null;
    try {
      const intent = await this.durable.getPaymentIntentById(paymentIntentId);
      if (!intent) return null;
      return isStandardPaidCallRecord(intent.facilitatorResponseBody) ? intent.facilitatorResponseBody : null;
    } catch {
      return null;
    }
  }

  private pushEvidence(operation: Operation, event: string, payload: unknown): void {
    // EvidenceRecord shape mirrors ExecutionFeedbackService.pushEvidence —
    // phase SETTLEMENT, monotonic per-operation sequence.
    const record = {
      operationId: operation.operationId,
      phase: "SETTLEMENT",
      timestamp: Date.now(),
      event,
      payload,
      sequence: operation.evidence.length,
    } as unknown as import("./types.js").EvidenceRecord;
    operation.evidence.push(record);
  }
}
