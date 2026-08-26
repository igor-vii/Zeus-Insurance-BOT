# CANONICAL V0 EXECUTION PATH

**Date:** 27.08.2026 | **Status:** FROZEN

## Payment Path

CLIENT -> SECRETARIAT API -> REQUEST -> PAYMENT REQUIRED (x402 402)
-> CLIENT-SIGNED PAYLOAD (EIP-3009) -> PAYMENT INTENT (AUTHORIZED, persisted)
-> SUBMITTING (atomic CAS before network I/O) -> FACILITATOR /settle
-> SETTLEMENT_PENDING / RECONCILING -> ReconciliationEngine
-> SETTLED / NOT_SETTLED / UNRESOLVED_MANUAL

Facilitator response handling:
- 2xx + txHash -> SETTLEMENT_PENDING (CAS SUBMITTING->SETTLEMENT_PENDING)
- 4xx rejection -> RECONCILING (blockchain has priority)
- 5xx / timeout / no response -> state stays SUBMITTING (crash-safe)

Reconciliation probes: [2s, 10s, 30s, 2m, periodic]
- txHash known -> receipt + Transfer matching -> SETTLED
- txHash unknown -> authorizationState -> AuthorizationUsed -> SETTLED
- expired + 2 RPC agree false -> NOT_SETTLED
- ambiguous -> RECONCILING (retry)

## Seller Execution Path (after SETTLED)

SETTLED -> PostSettlementEngine.initiateExecution() [ONLY entry point]
-> ExecutionAttempt (PENDING, persisted) -> RecoveryJob (atomic claim)
-> SellerExecutionAdapter.execute()
- SUCCESS (2xx) -> complete
- HTTP_FAILURE (4xx/5xx) -> definitive failure
- DELIVERY_UNKNOWN -> recovery via capability (IDEMPOTENT/RETRIEVAL/NONE)

## Economic Safety Invariant

allow_new_payment(state) = (state == NOT_SETTLED)

Enforced at: type level, store level (PostgreSQL read), DB level (UNIQUE operation_id), CAS level.

## Removed / Isolated Paths

| Path | Status | Reason |
|------|--------|--------|
| StateMachine.observeExecution() | REMOVED from production | Alternative execution path bypassing PostSettlementEngine |
| InMemoryExecutionStore | EXPERIMENTAL only | Phase 2.4 prototype, not production |
| InMemoryEvidenceStore | REMOVED | Replaced by PostgresEvidenceStore |
| submittedIntents Set | OPTIMIZATION CACHE only | NOT safety boundary. DB is authoritative. |
| MockX402FacilitatorClient | TEST only | Same semantics as production |
| MockSellerExecutionAdapter | TEST only | Same 3-way taxonomy |
| MockMultiRpcChecker | TEST only | Same agreement logic |

## On-Chain Verification

ReconciliationEngine -> MultiRpcChecker -> SingleRpcProvider x N -> ViemOnChainChecker
- MultiRpcChecker = aggregation + agreement detection + NOT_SETTLED gate
- SingleRpcProvider = single RPC endpoint wrapper
- ViemOnChainChecker = viem calls (authorizationState, getLogs, getTransactionReceipt)
- Network config = explicit configuration, not hardcoded

## Recovery After Crash

Process restarts -> getNonTerminalIntents() finds SUBMITTING/SUBMITTED/SETTLEMENT_PENDING/RECONCILING
- SUBMITTING without txHash -> CAS to RECONCILING
- Others -> ReconciliationEngine.reconcile()
- NEVER re-submit to facilitator after crash. Always reconcile first.

## Database Tables

| Table | Purpose | Key Constraints |
|-------|---------|-----------------|
| payment_intents | Payment lifecycle | PK, UNIQUE(operation_id), version for CAS |
| nonce_registry | Nonce reservation | PK(nonce) |
| reconciliation_observations | Per-probe RPC data | FK(payment_intent_id) |
| reconciliation_jobs | Probe schedule | Atomic claim via UPDATE...RETURNING |
| execution_attempts | Seller execution | UNIQUE(execution_id, attempt_number) |
| recovery_jobs | Post-settlement queue | Atomic claim via locked_by/locked_until |
