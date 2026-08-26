# CANONICAL V0 EXECUTION PATH

**Date:** 26.08.2026 | **Status:** FROZEN - AUTHORITATIVE

---

## THE ONE PAYMENT PATH

CLIENT -> SECRETARIAT -> REQUEST -> PAYMENT REQUIRED -> CLIENT-SIGNED PAYLOAD
-> PAYMENT INTENT CREATED (state=AUTHORIZED, persisted to PostgreSQL)
   UNIQUE(operation_id) enforced at DB level
   All spec section 4 fields persisted BEFORE any network I/O
-> SUBMITTING (atomic CAS: AUTHORIZED -> SUBMITTING, persisted)
   compareAndSetState with version check
   This transition MUST succeed before network call begins
-> FACILITATOR /settle (network I/O)
   2xx + txHash -> recordSubmissionResult(SUBMITTED or SETTLEMENT_PENDING)
   4xx rejection -> recordSubmissionResult(RECONCILING)
   5xx / timeout -> state stays SUBMITTING (crash-safe, recovery handles it)
   crash -> state stays SUBMITTING (recovery handles it)
-> RECONCILING (explicitly set, or recovered from SUBMITTING after crash)
-> ReconciliationEngine.reconcile()
   txHash known -> checkTransaction -> receipt + Transfer match
     success + confirmed -> SETTLED
     reverted -> NOT_SETTLED
     pending/unconfirmed -> RECONCILING (retry)
   txHash unknown -> authorizationState(authorizer, nonce)
     true -> find AuthorizationUsed event -> recover txHash -> SETTLED path
     false + expired + 2 RPC agree -> NOT_SETTLED
     false + not expired -> RECONCILING (wait)
     RPC disagreement -> RECONCILING (wait)
     RPC error -> RECONCILING (retry)
-> TERMINAL STATE: SETTLED or NOT_SETTLED or UNRESOLVED_MANUAL

## THE ONE SELLER EXECUTION PATH

SETTLED (persisted with SettledEvidenceBundle)
-> PostSettlementEngine.initiateExecution() <-- ONLY ENTRY POINT
   Verifies settlement state == SETTLED
   Creates ExecutionAttempt with stable idempotency key = operationId
   Creates RecoveryJob in reconciliation_jobs table
-> RecoveryWorker claims job (atomic SQL UPDATE...RETURNING)
-> SellerExecutionAdapter.execute(request)
   SUCCESS -> execution complete, evidence persisted
   HTTP_FAILURE -> definitive failure, evidence persisted
   DELIVERY_UNKNOWN -> capability-based recovery:
     EXECUTION_IDEMPOTENT -> retry with SAME idempotency key
     RESULT_RETRIEVAL -> GET observation (NOT re-execution)
     NONE -> UNRESOLVABLE (no blind retry)

## REMOVED / ISOLATED PATHS

### StateMachine.observeExecution()
**Status:** REMOVED from production execution path.
Phase 2.1 initial implementation. NO LONGER authoritative.
Must be deleted, or delegate to PostSettlementEngine, or marked @experimental.
MUST NOT contain own HTTP execution logic or economic decision-making.

### InMemoryExecutionStore (Phase 2.4)
**Status:** EXPERIMENTAL - NOT PRODUCTION
V0 uses execution_attempts and reconciliation_jobs tables in PostgreSQL.
InMemoryExecutionStore remains for unit tests only.

### InMemoryEvidenceStore
**Status:** TEST ONLY. Production uses PostgresEvidenceStore exclusively.

### Mock implementations
**Status:** TEST ONLY. Never imported in production code paths.

## ECONOMIC SAFETY INVARIANT

NEW_PAYMENT_ALLOWED(state) <=> state == NOT_SETTLED

Enforcement layers:
1. Type level: allowNewPayment() function
2. Store level: canCreateNewPayment(operationId) reads PostgreSQL
3. DB level: UNIQUE(operation_id) prevents duplicate intent creation
4. CAS level: compareAndSetState() prevents conflicting terminal transitions
5. Facade level: X402FacilitatorClient.submit() calls canCreateNewPayment() before network I/O

No code path may bypass these checks. No as any. No optional method calls. No in-memory-only guards.

## COMPONENT RESPONSIBILITY MAP

ReconciliationEngine -> MultiRpcChecker -> SingleRpcProvider x N -> Chain RPC
PostSettlementEngine -> SellerExecutionAdapter -> Seller HTTP endpoint
PostgresEvidenceStore -> PostgreSQL (payment_intents, nonce_registry, reconciliation_observations, reconciliation_jobs)

## NETWORK CONFIGURATION

V0 targets Base Sepolia. All network-specific values MUST come from configuration:
- Chain ID, Token contract address, RPC URLs (min 2 independent providers)
- Confirmation count (FinalityPolicy), Facilitator endpoint, Seller endpoint
Hardcoded baseSepolia or 0xUSDC inside generic components is a defect.
