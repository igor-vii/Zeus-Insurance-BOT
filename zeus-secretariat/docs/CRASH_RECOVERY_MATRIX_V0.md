# CRASH RECOVERY MATRIX V0

**Date:** 26.08.2026 | **Status:** FROZEN

For each state: what is in PostgreSQL, can worker re-submit payment,
can worker reconcile, what happens after restart, can second payment appear.

| State | In PostgreSQL | Re-submit? | Reconcile? | After Restart | 2nd Payment? |
|-------|--------------|------------|------------|---------------|-------------|
| AUTHORIZED | intent row, state=AUTHORIZED | NO (must transition to SUBMITTING first) | NO (not yet submitted) | Stays AUTHORIZED, safe to submit | NO (UNIQUE op_id) |
| SUBMITTING | intent row, state=SUBMITTING, no txHash | NO (already in progress) | YES (recovery moves to RECONCILING) | Recovery finds SUBMITTING without txHash -> RECONCILING | NO (state != NOT_SETTLED) |
| SUBMITTING (with txHash) | intent row, state=SUBMITTING, txHash set | NO | YES (recovery uses txHash path) | Recovery finds txHash -> reconcileByTxHash | NO |
| SUBMITTED | intent row, state=SUBMITTED, txHash set | NO | YES (reconciliation via txHash) | Stays SUBMITTED -> reconcile | NO |
| SETTLEMENT_PENDING | intent row, state=SETTLEMENT_PENDING, txHash | NO | YES (reconciliation via txHash) | Stays SETTLEMENT_PENDING -> reconcile | NO |
| RECONCILING | intent row, state=RECONCILING | NO | YES (active reconciliation) | Stays RECONCILING -> continue reconcile | NO |
| SETTLED | intent row + settledEvidenceBundle | NO (terminal) | NO (terminal) | Stays SETTLED, evidence intact | NO |
| NOT_SETTLED | intent row + notSettledEvidenceBundle | YES (only allowed state) | NO (terminal) | Stays NOT_SETTLED, evidence intact | YES (new nonce required) |
| UNRESOLVED_MANUAL | intent row | NO | NO (requires human) | Stays UNRESOLVED_MANUAL | NO |

## Critical Boundaries

### Boundary 1: AUTHORIZED -> SUBMITTING
- CAS transition MUST persist before network I/O begins
- If crash occurs between CAS and fetch(): state=SUBMITTING, no txHash
- Recovery: move to RECONCILING, check authorizationState on-chain
- NEVER re-submit to facilitator from SUBMITTING

### Boundary 2: SUBMITTING -> network response
- If facilitator accepted but response lost: state=SUBMITTING, no txHash
- Recovery: authorizationState=true -> find AuthorizationUsed -> recover txHash -> SETTLED
- If facilitator rejected: state transitions to RECONCILING
- If facilitator timeout: state stays SUBMITTING (safe)

### Boundary 3: Terminal transitions (SETTLED / NOT_SETTLED)
- compareAndSetState() with version check prevents conflicting transitions
- Two workers cannot both succeed on same RECONCILING -> SETTLED/NOT_SETTLED
- Terminal states are irreversible (no auto-reversal per spec section 24)

### Boundary 4: New payment creation
- canCreateNewPayment() reads persisted state from PostgreSQL
- Returns true ONLY for NOT_SETTLED
- UNIQUE(operation_id) prevents duplicate intents even if guard is bypassed
- New payment requires new nonce (old nonce is consumed or expired)

## Recovery Procedure After Restart

1. Query all non-terminal intents: getNonTerminalIntents()
2. For each SUBMITTING without txHash: transition to RECONCILING
3. For each SUBMITTING with txHash: keep as-is, reconcile via txHash
4. For each SUBMITTED / SETTLEMENT_PENDING / RECONCILING: call reconcile()
5. Schedule next probe per reconciliation schedule config
6. NEVER re-submit to facilitator. Always reconcile first.
