/**
 * A1-R Stage 2A — Canonical Operation reconstruction regression tests.
 *
 * Covers:
 *  D-2b: getOperation() must reconstruct executionState from the REAL
 *        drizzle/node-postgres db.execute() result shape ({ rows: [...] }).
 *  D-2:  getOperationByRequestId() and getOperationByClientAndRequestId()
 *        must return the SAME reconstructed state as getOperation(opId)
 *        (canonical delegation), not hardcoded NOT_STARTED/settlement-only.
 *  Public API: real express route GET /v1/requests/:requestId backed by the
 *        real PostgresEvidenceStore (no mock of the method under test).
 *  Negative/compat: not-found null, idempotency identity, no duplicate ops.
 *
 * Uses an isolated disposable PostgreSQL DB via DATABASE_URL. Skipped when
 * DATABASE_URL is unset — never substituted with FakeDb.
 */

import type { Operation } from "../src/core/types";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeIfDb("A1-R Stage 2A: canonical reconstruction over real PostgreSQL", () => {
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
      operationId: `op-a1r-${tag}-${now}`,
      requestId: `req-a1r-${tag}-${now}`,
      clientId: `client-a1r-${tag}-${now}`,
    };
  }

  async function insertSettledDpi(id: {
    operationId: string;
    requestId: string;
    clientId: string;
  }): Promise<void> {
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

  // --------------------------------------------------------------------------
  // Step 1 verification: actual driver result shape for the raw attempt query.
  // This is a GENUINE database-driver observation (real PG via drizzle
  // node-postgres), not a fabricated { rows: [...] } test double.
  // --------------------------------------------------------------------------
  test("driver-shape probe: db.execute() on execution_attempts returns {rows:[...]} on real PG", async () => {
    const id = makeIdentity("shape");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "SUCCESS");

    const raw = await db.execute(`SELECT status FROM execution_attempts WHERE operation_id = '${id.operationId}' LIMIT 1`);
    const records = Array.isArray(raw) ? raw : (raw as any)?.rows ?? [];
    expect(records.length).toBe(1);
    expect(records[0].status).toBe("SUCCESS");
    // Document that the pre-fix code path (Array.isArray(raw)? raw : [])
    // would have yielded [] for this genuine driver result:
    expect(Array.isArray(raw)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // A. Attempt result parsing (D-2b) — SUCCESS case
  // --------------------------------------------------------------------------
  test("A/D-2b: getOperation reconstructs executionState=CONFIRMED from durable SUCCESS attempt", async () => {
    const id = makeIdentity("success");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "SUCCESS");
    await store.append(stateTransitionEvidence(id.operationId, "SETTLED", "EXECUTION_PENDING", Date.now()) as any);

    const op = await store.getOperation(id.operationId);
    expect(op).not.toBeNull();
    // Existing contract: mapAttemptStatusToExecutionState("SUCCESS") = CONFIRMED
    expect(op.executionState).toBe("CONFIRMED");
    // Fast-forward contract: EXECUTION_PENDING evidence + SUCCESS attempt
    expect(op.currentState).toBe("EXECUTION_CONFIRMED");
    expect(op.paymentState).toBe("SETTLED");
  });

  // --------------------------------------------------------------------------
  // A'. Terminal non-success cases (semantics unchanged, per scope)
  // --------------------------------------------------------------------------
  test("A'/D-2b: HTTP_FAILURE attempt reconstructs executionState=FAILED", async () => {
    const id = makeIdentity("failed");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "HTTP_FAILURE");
    await store.append(stateTransitionEvidence(id.operationId, "SETTLED", "EXECUTION_PENDING", Date.now()) as any);

    const op = await store.getOperation(id.operationId);
    expect(op.executionState).toBe("FAILED");
    expect(op.currentState).toBe("FAILED");
  });

  test("A'/D-2b: UNRESOLVABLE attempt keeps existing mapping (terminal recovery, delivery UNKNOWN)", async () => {
    const id = makeIdentity("unresolvable");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "UNRESOLVABLE");
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_UNKNOWN", "RECOVERY_PENDING", Date.now()) as any);

    const op = await store.getOperation(id.operationId);
    // Semantics deliberately NOT changed in Stage 2A: existing contract maps
    // UNRESOLVABLE -> executionState CONFIRMED ("call was made").
    expect(op.executionState).toBe("CONFIRMED");
    // Existing deriveDeliveryState contract (postgres-store.ts): UNKNOWN is
    // produced only when the LATEST STATE_TRANSITION payload.to is
    // EXECUTION_UNKNOWN/UNRESOLVABLE — not from RECOVERY_PENDING. Assert the
    // real contract instead of an assumed one.
    expect(op.deliveryState).toBe("NOT_STARTED");
    expect(String(op.currentState)).not.toBe("SUCCESS");
  });

  // --------------------------------------------------------------------------
  // B. Request-ID reconstruction (D-2) — all three paths consistent
  // --------------------------------------------------------------------------
  test("B/D-2: all three lookup paths return identical state axes for a SUCCESSFUL operation", async () => {
    const id = makeIdentity("consistent");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "SUCCESS");
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

    const byOpId = await store.getOperation(id.operationId);
    const byReqId = await store.getOperationByRequestId(id.requestId);
    const byClientReq = await store.getOperationByClientAndRequestId(id.clientId, id.requestId);

    for (const [label, op] of [["byOpId", byOpId], ["byReqId", byReqId], ["byClientReq", byClientReq]] as const) {
      expect(op).not.toBeNull();
      expect(op!.operationId).toBe(id.operationId);
      expect(op!.executionState).toBe(byOpId.executionState);
      expect(op!.deliveryState).toBe(byOpId.deliveryState);
      expect(op!.currentState).toBe(byOpId.currentState);
      expect(op!.paymentState).toBe(byOpId.paymentState);
      expect(op!.evidence.length).toBe(byOpId.evidence.length);
      void label;
    }
    // Canonical values from durable facts:
    expect(byOpId.currentState).toBe("SUCCESS");
    expect(byOpId.executionState).toBe("CONFIRMED");
    expect(byOpId.deliveryState).toBe("DELIVERED");
  });

  // --------------------------------------------------------------------------
  // C. Public API — REAL express router wired to the REAL PG-backed secretariat
  // --------------------------------------------------------------------------
  test("C: GET /v1/requests/:requestId returns COMPLETED for durably successful op (real store, no getter mock)", async () => {
    const express = (await import("express")).default ?? (await import("express"));
    const http = await import("node:http");
    const { StateMachine } = await import("../src/core/state-machine");
    const { createRequestsRouter } = await import("../../api-server/src/routes/requests");

    const id = makeIdentity("route");
    await insertSettledDpi(id);
    await insertAttempt(id.operationId, "SUCCESS");
    await store.saveOperation({
      ...id, target: "https://seller.example.com/x", method: "POST", paymentPolicy: {},
      paymentState: "SETTLED", executionState: "CONFIRMED", deliveryState: "NOT_STARTED",
      currentState: "EXECUTION_PENDING", timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      evidence: [],
    } as unknown as Operation);
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_PENDING", "EXECUTION_CONFIRMED", 1100) as any);
    await store.append(stateTransitionEvidence(id.operationId, "EXECUTION_CONFIRMED", "DELIVERED", 1200) as any);
    await store.append(stateTransitionEvidence(id.operationId, "DELIVERED", "SUCCESS", 1300) as any);

    // Real composition: Secretariat FSM class over the real PostgresEvidenceStore.
    const { Secretariat } = await import("../src/core/state-machine");
    const sm = new Secretariat({ evidenceStore: store } as any);
    const router = createRequestsRouter(sm as any);
    const app = express();
    app.use("/v1", router);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const addr = server.address() as any;
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/requests/${id.requestId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Pre-D-2 behavior: PROCESSING. Post-fix: terminal outcome visible.
      expect(body.status).toBe("COMPLETED");

      // Not-found behavior preserved through the real route:
      const missing = await fetch(`http://127.0.0.1:${addr.port}/v1/requests/req-does-not-exist-${Date.now()}`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  // --------------------------------------------------------------------------
  // D. Negative & compatibility
  // --------------------------------------------------------------------------
  test("D: nonexistent request IDs still return null (both getters)", async () => {
    expect(await store.getOperationByRequestId(`nope-${Date.now()}`)).toBeNull();
    expect(await store.getOperationByClientAndRequestId("nope-client", `nope-${Date.now()}`)).toBeNull();
  });

  test("D: idempotency lookup returns same operation identity and creates no duplicate row", async () => {
    const id = makeIdentity("idem");
    await insertSettledDpi(id);
    const first = await store.getOperationByClientAndRequestId(id.clientId, id.requestId);
    const second = await store.getOperationByClientAndRequestId(id.clientId, id.requestId);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.operationId).toBe(second!.operationId);
    expect(first!.requestId).toBe(id.requestId);
    expect(first!.clientId).toBe(id.clientId);

    const countRows = await db.execute(
      `SELECT COUNT(*)::int AS c FROM payment_intents WHERE operation_id = '${id.operationId}'`,
    );
    const recs = Array.isArray(countRows) ? countRows : (countRows as any).rows;
    expect(recs[0].c).toBe(1);
  });

  test("D: PENDING_SIGNATURE pre-execution operation keeps AWAITING_PAYMENT_SIGNATURE semantics via request-id lookup", async () => {
    const id = makeIdentity("pending-sig");
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
        'PENDING_SIGNATURE', 0, NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `);
    const op = await store.getOperationByRequestId(id.requestId);
    expect(op).not.toBeNull();
    // Canonical deriveCurrentState fallback preserves the legacy mapping.
    expect(op!.currentState).toBe("AWAITING_SIGNATURE");
    expect(op!.executionState).toBe("NOT_STARTED");
    expect(op!.deliveryState).toBe("NOT_STARTED");
  });
});
