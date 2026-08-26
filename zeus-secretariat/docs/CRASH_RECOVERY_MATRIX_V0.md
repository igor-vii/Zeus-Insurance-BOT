# CRASH RECOVERY MATRIX V0

**Date:** 27.08.2026 | **Status:** FROZEN

For each state: what is in PostgreSQL, can worker re-submit payment, can worker reconcile,
what happens after restart, can a second economic payment appear.

| State | In PostgreSQL | Re-submit payment? | Can reconcile? | After restart | Second payment? |
|-------|--------------|-------------------|---------------|--------------|----------------|
| AUTHORIZED | payment_intent row, state=AUTHORIZED | No (CAS AUTHORIZED->SUBMITTING required first) | No (not yet submitted) | Stays AUTHORIZED. Safe to retry submission. | No (UNIQUE operation_id) |
| SUBMITTING | payment_intent row, state=SUBMITTING, no txHash | No (state != NOT_SETTLED) | Yes (move to RECONCILING) | Found by getNonTerminalIntents(). CAS to RECONCILING. | No |
| SUBMITTING + txHash | payment_intent row, state=SUBMITTING, txHash set | No | Yes (reconcile by txHash) | Found by recovery. Reconcile by txHash. | No |
| SUBMITTED | payment_intent row, state=SUBMITTED | No | Yes | Found by recovery. Reconcile. | No |
| SETTLEMENT_PENDING | payment_intent row, state=SETTLEMENT_PENDING, txHash set | No | Yes (reconcile by txHash) | Found by recovery. Reconcile by txHash. | No |
| RECONCILING | payment_intent row, state=RECONCILING | No | Yes (continue reconciliation) | Found by recovery. Continue probes. | No |
| SETTLED | payment_intent row, state=SETTLED, settledEvidenceBundle set | No (terminal) | No (terminal) | Stays SETTLED. Evidence survives. Seller execution may resume. | No |
| NOT_SETTLED | payment_intent row, state=NOT_SETTLED, notSettledEvidenceBundle set | YES (only state that allows) | No (terminal) | Stays NOT_SETTLED. New payment with NEW nonce allowed. | Only via new intent with new operationId suffix |
| UNRESOLVED_MANUAL | payment_intent row, state=UNRESOLVED_MANUAL | No | No (requires human) | Stays UNRESOLVED_MANUAL. Awaits manual review. | No |

## Key Rules

1. After AUTHORIZED->SUBMITTING CAS: re-submission FORBIDDEN until NOT_SETTLED proven.
2. SUBMITTING without txHash after crash: move to RECONCILING, never re-submit.
3. SETTLED evidence bundle survives restart (JSONB in PostgreSQL).
4. NOT_SETTLED evidence bundle survives restart (JSONB in PostgreSQL).
5. All reconciliation observations survive restart (separate table rows).
6. UNIQUE(operation_id) prevents duplicate intents at DB level.
7. compareAndSetState() prevents conflicting terminal transitions.

## Crash Boundaries Tested

| Boundary | Test | Result |
|----------|------|--------|
| AUTHORIZED -> crash before SUBMITTING | T2 | No payment submitted, retry safe |
| SUBMITTING -> crash before facilitator response | T3 | State=SUBMITTING, restart->RECONCILING, no second submit |
| Facilitator accepted -> response lost | T4 | UNKNOWN/RECONCILING -> on-chain reconciliation -> SETTLED |
| Facilitator 500 | T5 | RECONCILING (not FAILED) |
| SETTLED -> crash after seller execution | Golden Test 1 | Evidence survives, no duplicate payment |
| NOT_SETTLED -> new payment | Golden Test 2 | Only after full evidence, new nonce required |
