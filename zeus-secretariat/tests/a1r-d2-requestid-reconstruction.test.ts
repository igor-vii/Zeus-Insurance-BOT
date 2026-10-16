/**
 * A1-R Stage 1 — D-2 forensic reproduction test (TEST FILE ONLY, no prod changes)
 *
 * Hypothesis under test: PostgresEvidenceStore.getOperationByRequestId() and
 * getOperationByClientAndRequestId() return stale lossy state
 * (executionState/deliveryState hardcoded "NOT_STARTED", currentState mapped
 * straight from settlement_state), while getOperation(operationId) performs
 * full durable reconstruction. Consequently the public polling route
 * (api-server GET /requests/:requestId → secretariat.getOperationByRequestId →
 * publicStatusForOperation) reports PROCESSING for an operation whose durable
 * execution actually succeeded.
 *
 * Uses the REAL production PostgresEvidenceStore against an isolated disposable
 * PostgreSQL database (DATABASE_URL). No mocking of the method under test.
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

  test("D-2 reproduction: SUCCESS terminal outcome is visible via getOperation but STALE via both request-ID getters", async () => {
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
    const byReqId = await store.getOperationByRequestId(id.requestId);
    expect(byReqId).not.toBeNull();
    // Suspected defect assertions — these document ACTUAL behavior:
    expect(byReqId.currentState).toBe("SETTLED"); // stale: settlement passthrough, not "SUCCESS"
    expect(byReqId.executionState).toBe("NOT_STARTED"); // stale: hardcoded, not "CONFIRMED"
    expect(byReqId.deliveryState).toBe("NOT_STARTED"); // stale: hardcoded, not "DELIVERED"

    // ---- Retrieval by CLIENT ID + REQUEST ID (idempotency path) ----
    const byClientReq = await store.getOperationByClientAndRequestId(id.clientId, id.requestId);
    expect(byClientReq).not.toBeNull();
    expect(byClientReq.currentState).toBe("SETTLED");
    expect(byClientReq.executionState).toBe("NOT_STARTED");
    expect(byClientReq.deliveryState).toBe("NOT_STARTED");

    // ---- Public API mapping consequence ----
    // Copy of publicStatusForOperation decision logic from
    // api-server/src/routes/requests.ts:122-165 (route cannot be imported
    // without express wiring; logic replicated verbatim):
    const publicStatusFor = (operation: Operation): string => {
      const state = String(operation.currentState);
      if (state === "AWAITING_SIGNATURE" || state === "PENDING_SIGNATURE") return "AWAITING_PAYMENT_SIGNATURE";
      if (state === "SUCCESS" || state === "DELIVERED" || state === "EXECUTION_CONFIRMED" || state === "RECOVERED") return "COMPLETED";
      if (state === "FAILED" || state === "POLICY_REJECTED" || state === "SETTLEMENT_FAILED" || state === "NOT_SETTLED") return "FAILED";
      if (state === "UNRESOLVABLE" || state === "UNRESOLVED_MANUAL" || state === "INCIDENT") return "UNRESOLVABLE";
      if (state === "EXECUTION_UNKNOWN" || state === "DELIVERY_UNKNOWN" || operation.executionState === "UNKNOWN" || operation.deliveryState === "UNKNOWN") return "UNKNOWN";
      return "PROCESSING";
    };

    // Correct path yields COMPLETED:
    expect(publicStatusFor(byOpId)).toBe("COMPLETED");
    // Defective path yields stale PROCESSING for a durably SUCCESSFUL operation:
    expect(publicStatusFor(byReqId)).toBe("PROCESSING");
    expect(publicStatusFor(byClientReq)).toBe("PROCESSING");
  });

  test("D-2 variant: FAILED durable outcome also misreported via request-ID lookup", async () => {
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
    // Request-ID getter ignores attempts AND evidence for state axes:
    expect(byReqId.currentState).toBe("SETTLED"); // stale — not FAILED
    expect(byReqId.executionState).toBe("NOT_STARTED"); // stale — not FAILED

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
    // Defective path: durably FAILED operation reported as PROCESSING forever:
    expect(publicStatusFor(byReqId)).toBe("PROCESSING");
  });
});
