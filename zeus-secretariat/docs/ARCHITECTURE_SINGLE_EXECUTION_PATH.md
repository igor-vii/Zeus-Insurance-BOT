# ARCHITECTURE: Single Authoritative Execution Path

**Date:** 26.08.2026 | **Status:** FROZEN

## The One Path

REQUEST -> AUTHORIZED (persisted) -> SUBMITTING (atomic CAS before network) -> Facilitator /settle

Facilitator response:
- 2xx + txHash -> SETTLEMENT_PENDING
- 5xx / timeout -> state stays SUBMITTING (crash-safe)
- 4xx rejection -> RECONCILING

ReconciliationEngine.reconcile():
- txHash known -> checkTransaction -> receipt + Transfer -> SETTLED
- txHash unknown -> authorizationState -> AuthorizationUsed -> SETTLED
- expired + 2 RPC false -> NOT_SETTLED
- ambiguous -> RECONCILING (retry on schedule)

SETTLED -> PostSettlementEngine.initiateExecution() (ONLY entry point for seller execution)
-> ExecutionAttempt (PENDING) -> SellerExecutionAdapter.execute()
- SUCCESS -> complete
- HTTP_FAILURE -> definitive failure
- DELIVERY_UNKNOWN -> recovery via capability (IDEMPOTENT/RETRIEVAL/NONE)

## Forbidden Paths

1. StateMachine.observeExecution() MUST NOT make HTTP calls to seller. Observation only.
2. No code may call fetch/HTTP to seller outside SellerExecutionAdapter.
3. No code may create new payment intent without canCreateNewPayment() === true.
4. submittedIntents Set is optimization cache ONLY. Safety boundary is always the database.

## Recovery After Crash

Process restarts -> getNonTerminalIntents() -> for each:
- SUBMITTING without txHash -> move to RECONCILING
- SUBMITTED / SETTLEMENT_PENDING / RECONCILING -> reconcile()

NEVER re-submit to facilitator after crash. Always reconcile first.
