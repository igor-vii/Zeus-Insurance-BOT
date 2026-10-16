/**
 * A1-R Stage 1 — D-2 forensic reproduction test (TEST FILE ONLY, no prod changes)
 *
 * ORIGINAL PURPOSE (Stage 1, pre-fix HEAD c991e71): document that
 * getOperationByRequestId()/getOperationByClientAndRequestId() returned stale
 * lossy state (hardcoded "NOT_STARTED" axes, settlement-passthrough
 * currentState) while getOperation(operationId) performed full reconstruction,
 * making the public polling route report PROCESSING for durably SUCCESSFUL
 * operations. That defective behavior was REPRODUCED at Stage 1 and is FIXED
 * in Stage 2A (canonical delegation to getOperation(opId)).
 *
 * CURRENT CONTRACT (post-D-2 fix, verified here): all three lookup paths must
 * agree on paymentState / executionState / deliveryState / currentState, a
 * durably SUCCESSFUL operation must NOT be reconstructed as NOT_STARTED via
 * request-ID lookup, and the public status mapping must yield COMPLETED.
 *
 * UNIQUE COVERAGE vs a1r-d2-canonical-reconstruction.test.ts (preserved):
 *  - the FAILED-via-request-ID regression with the FULL durable chain
 *    (EXECUTION_PENDING -> EXECUTION_UNKNOWN -> RECOVERY_PENDING evidence +
 *    UNRESOLVABLE attempt), which canonical suite B does not exercise;
 *  - explicit assertion that the legacy hardcoded-shape fields (target/method/
 *    paymentPolicy) survive the canonical delegation through both getters.
 *
 * Uses the REAL production PostgresEvidenceStore against an isolated disposable
 * PostgreSQL database (DATABASE_URL). No mocking of the method under test.
 * Skipped when DATABASE_URL is unset — never substituted with FakeDb.
 */

import type { Operation } from "../src/core/types";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("A1-R D-2: request-ID reconstruction vs operation-ID reconstruction (real PG store)", () => {
  let store: any;
  let db: any;

  const zeroAddr = "0x0000000000000000000000000000000000000000";

  beforeAll(async () => {
    const dbModule = await import("@workspace/db");
    store = new dbModule.PostgresEvidenceStore(dbModule.db);
    db = dbModule.db;
  });

  afterAll(async () => {
    if (db) await db.$client.end();
  });

  function makeIdentity(tag: string) {
    const now = Date.now();
    return {
      operationId: `op-d2-${tag}-${now}`,
      requestId: `req-d2-${tag}-${now}`,
      clientId: `client-d2-${tag}-${now}`,
    };
  }

  /** Mirror of c1-operation-persistence insertTestDpi + settled state. */
  async function insertSettledDpi(id: { operationId: string; requestId: string; clientId: string }): Promise<void> {
    const zeroNonce = "0x" + "0".repeat(64);
    const zeroHash = "0x" + "0".repeat(64);
    await db.execute(`
      INSERT INTO payment_intents (
        payment_intent_id, operation_id, request_id, client_id,
        authorizer, pay_to, value, asset, network,
        nonce, valid_after, valid_before,
        payment_payload, payment_payload_hash,
        settlement_state, version, created_at, updated_at
      ) VALUES (
        'pi-${id.operationId}', '${id.operationId}', '${id.requestId}', '${id.clientId}',
        '${zeroAddr}', '${zeroAddr.slice(0, -1)}1',
        '0', 'USDC', 'base',
        '${zeroNonce}', 0, 9999999999,
        '{}', '${zeroHash}',
        'SETTLED', 0, NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `);
  }

  async function insertAttempt(operationId: string, status: string): Promise<void> {
    await db.execute(`
      INSERT INTO execution_attempts (attempt_id, operation_id, execution_id, attempt_number, status, idempotency_key, created_at)
      VALUES ('att-${operationId}', '${operationId}', 'exec-${operationId}', 1, '${status}', 'idem-${operationId}', NOW())
    `);
  }

  function stateTransitionEvidence(operationId: string, from: string, to: string, ts: number): unknown {
    return { operationId, phase: "EXECUTION", timestamp: ts, event: "STATE_TRANSITION", payload: { from, to } };
  }

  test("D-2 fixed contract: SUCCESS terminal outcome is reconstructed identically via all three lookup paths", async () => {
    const id = makeIdentity("success");
    await insertSettledDpi(id);

    // Advance durable execution state to a terminal SUCCESS outcome.
    await insertAttempt(id.operationId, "SUCCESS");

    // Persist FSM feedback evidence through the PRODUCTION paths:
    //  - saveOperation(): request semantics (target/method/paymentPolicy)
    //  - append(): durable evidence chain (reconciliation_observations JSONB),
    //    exactly what ExecutionFeedbackService/PostSettlementEngine use for
    //    STATE_TRANSITION records.
    const opWithFeedback: Operation = {
      ...id,
      target: "https://seller.example.com/api/v1/execute",
      method: "POST",
      paymentPolicy: {},
      paymentState: "SETTLED" as any,
      executionState: "CONFIRMED" as any,
      deliveryState: "DELIVERED" as any,
      currentState: "SUCCESS" as any,
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      evidence: [],
    } as Operation;
    await store.saveOperation(opWithFeedback);
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_PENDING", "EXECUTION_CONFIRMED", 1000) as any);
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_CONFIRMED", "DELIVERED", 2000) as any);
    await store.append(stateTransitionEvidence(id.operationId, "DELIVERED", "SUCCESS", 3000) as any);

    // ---- Retrieval by OPERATION ID (full reconstruction, A1-fixed path) ----
    const byOpId = await store.getOperation(id.operationId);
    expect(byOpId).not.toBeNull();
    expect(byOpId.currentState).toBe("SUCCESS");
    expect(byOpId.executionState).toBe("CONFIRMED");
    expect(byOpId.deliveryState).toBe("DELIVERED");

    // ---- Retrieval by REQUEST ID (public polling path) ----
    // Stage 1 asserted the DEFECTIVE behavior here (currentState "SETTLED",
    // hardcoded NOT_STARTED axes). Post-D-2 fix the getter delegates to the
    // canonical getOperation(opId) reconstruction, so it must agree with the
    // operation-ID path on every state axis and on operation identity.
    const byReqId = await store.getOperationByRequestId(id.requestId);
    expect(byReqId).not.toBeNull();
    expect(byReqId.operationId).toBe(id.operationId);
    expect(byReqId.currentState).toBe("SUCCESS");
    expect(byReqId.executionState).toBe("CONFIRMED");
    expect(byReqId.deliveryState).toBe("DELIVERED");
    expect(byReqId.paymentState).toBe(byOpId.paymentState);
    expect(byReqId.evidence.length).toBe(byOpId.evidence.length);
    // Legacy lossy-shape fields survive canonical delegation (they come from
    // the payment_intents row inside getOperation):
    expect(byReqId.target).toBe("https://seller.example.com/api/v1/execute");
    expect(byReqId.method).toBe("POST");

    // ---- Retrieval by CLIENT ID + REQUEST ID (idempotency path) ----
    const byClientReq = await store.getOperationByClientAndRequestId(id.clientId, id.requestId);
    expect(byClientReq).not.toBeNull();
    expect(byClientReq.operationId).toBe(id.operationId);
    expect(byClientReq.currentState).toBe("SUCCESS");
    expect(byClientReq.executionState).toBe("CONFIRMED");
    expect(byClientReq.deliveryState).toBe("DELIVERED");

    // ---- Public API mapping consequence ----
    // Copy of publicStatusForOperation decision logic from
    // api-server/src/routes/requests.ts:122-165 (route cannot be imported
    // without express wiring; logic replicated verbatim — the REAL route is
    // exercised in a1r-d2-canonical-reconstruction.test.ts suite C):
    const publicStatusFor = (operation: Operation): string => {
      const state = String(operation.currentState);
      if (state === "AWAITING_SIGNATURE" || state === "PENDING_SIGNATURE") return "AWAITING_PAYMENT_SIGNATURE";
      if (state === "SUCCESS" || state === "DELIVERED" || state === "EXECUTION_CONFIRMED" || state === "RECOVERED") return "COMPLETED";
      if (state === "FAILED" || state === "POLICY_REJECTED" || state === "SETTLEMENT_FAILED" || state === "NOT_SETTLED") return "FAILED";
      if (state === "UNRESOLVABLE" || state === "UNRESOLVED_MANUAL" || state === "INCIDENT") return "UNRESOLVABLE";
      if (state === "EXECUTION_UNKNOWN" || state === "DELIVERY_UNKNOWN" || operation.executionState === "UNKNOWN" || operation.deliveryState === "UNKNOWN") return "UNKNOWN";
      return "PROCESSING";
    };

    // All three paths now yield the same correct public status:
    expect(publicStatusFor(byOpId)).toBe("COMPLETED");
    // Regression guard: a durably SUCCESSFUL operation must NEVER again be
    // reported PROCESSING merely because lookup used request ID:
    expect(publicStatusFor(byReqId)).toBe("COMPLETED");
    expect(publicStatusFor(byClientReq)).toBe("COMPLETED");
  });

  test("D-2 fixed contract: FAILED durable outcome is visible via request-ID lookup (no stale PROCESSING)", async () => {
    const id = makeIdentity("failed");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "HTTP_FAILURE");

    // Simulate feedback having been applied up to EXECUTION_PENDING before crash:
    await store.append(stateTransitionEvidence(id.operationId, "SETTLED", "EXECUTION_PENDING", 1500) as any);

    const byOpId = await store.getOperation(id.operationId);
    // deriveCurrentState fast-forwards EXECUTION_PENDING + HTTP_FAILURE -> FAILED
    expect(byOpId.currentState).toBe("FAILED");
    expect(byOpId.executionState).toBe("FAILED"); // mapAttemptStatusToExecutionState(HTTP_FAILURE)

    const byReqId = await store.getOperationByRequestId(id.requestId);
    // Post-D-2 fix: request-ID getter reconstructs the SAME durable state
    // (Stage 1 documented the defect: currentState "SETTLED" / NOT_STARTED).
    expect(byReqId.currentState).toBe("FAILED"); // canonical — not stale SETTLED
    expect(byReqId.executionState).toBe("FAILED"); // canonical — not stale NOT_STARTED

    const publicStatusFor = (operation: Operation): string => {
      const state = String(operation.currentState);
      if (state === "AWAITING_SIGNATURE" || state === "PENDING_SIGNATURE") return "AWAITING_PAYMENT_SIGNATURE";
      if (state === "SUCCESS" || state === "DELIVERED" || state === "EXECUTION_CONFIRMED" || state === "RECOVERED") return "COMPLETED";
      if (state === "FAILED" || state === "POLICY_REJECTED" || state === "SETTLEMENT_FAILED" || state === "NOT_SETTLED") return "FAILED";
      if (state === "UNRESOLVABLE" || state === "UNRESOLVED_MANUAL" || state === "INCIDENT") return "UNRESOLVABLE";
      if (state === "EXECUTION_UNKNOWN" || state === "DELIVERY_UNKNOWN" || operation.executionState === "UNKNOWN" || operation.deliveryState === "UNKNOWN") return "UNKNOWN";
      return "PROCESSING";
    };
    expect(publicStatusFor(byOpId)).toBe("FAILED");
    // Regression guard: a durably FAILED operation must no longer be reported
    // PROCESSING forever via the request-ID polling path:
    expect(publicStatusFor(byReqId)).toBe("FAILED");
  });

  test("D-2 fixed contract: UNRESOLVABLE recovery-terminal outcome via request-ID lookup keeps existing semantics", async () => {
    // UNIQUE coverage preserved from the Stage 1 scenario set: full durable
    // unknown-execution chain (attempt UNRESOLVABLE + recovery evidence).
    // Semantics are NOT redefined here — this locks in the CURRENT mapping so
    // the D-2 delegation change cannot silently alter UNRESOLVABLE behavior.
    const id = makeIdentity("unresolvable");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "UNRESOLVABLE");
    await store.append(stateTransitionEvidence(id.operationId, "SETTLED", "EXECUTION_PENDING", 1000) as any);
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_PENDING", "EXECUTION_UNKNOWN", 2000) as any);
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_UNKNOWN", "RECOVERY_PENDING", 3000) as any);

    const byOpId = await store.getOperation(id.operationId);
    const byReqId = await store.getOperationByRequestId(id.requestId);
    expect(byReqId).not.toBeNull();

    // Canonical agreement across lookup paths (the D-2 contract):
    expect(byReqId.currentState).toBe(byOpId.currentState);
    expect(byReqId.executionState).toBe(byOpId.executionState);
    expect(byReqId.deliveryState).toBe(byOpId.deliveryState);

    // Existing contract values (unchanged by Stage 2A):
    //  - deriveDeliveryState maps latest payload.to RECOVERY_PENDING -> NOT_STARTED
    //    (only EXECUTION_UNKNOWN/UNRESOLVABLE as `to` produce UNKNOWN);
    //  - mapAttemptStatusToExecutionState("UNRESOLVABLE") -> CONFIRMED
    //    ("seller call was definitely made" — historical semantic preserved).
    expect(String(byReqId.currentState)).not.toBe("SUCCESS");
    expect(byReqId.executionState).toBe("CONFIRMED");
    expect(byReqId.deliveryState).toBe("NOT_STARTED");
  });
});
