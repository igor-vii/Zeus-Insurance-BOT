# ZEUS SECRETARIAT V0 - SPEC FREEZE & IMPLEMENTATION GATE

**Date:** 26.08.2026
**Status:** SPEC FROZEN - IMPLEMENTATION IN PROGRESS

---

## Economic Safety Invariant (THE acceptance criterion)

> **No path from UNKNOWN / RECONCILING may lead to creation of a new economic payment.**

Mirror:

> **New payment is allowed ONLY after positive proof of NOT_SETTLED.**

This is the single most important property of Secretariat V0.
Not code volume. Not test count. This invariant.

---

## Responsibility Boundary

PAYMENT TRUTH (authorizationState, AuthorizationUsed, Transfer, receipt)
is separate from EXECUTION TRUTH (seller response, delivery evidence, retry/recovery).
Reconciliation connects them but does not merge them.

Payment reconciliation does NOT decide whether service was delivered.
seller_delivery_unknown does NOT trigger re-payment until first payment proven NOT_SETTLED.

---

## Implementation Gate (executor must provide ALL)

1. Commit hash
2. List of changed files
3. Implemented state transitions
4. DB constraints / locks added
5. Test results A-L (pass/fail per test)
6. Crash/restart test output
7. Duplicate-payment test output
8. RPC conflict test output
9. Evidence examples for SETTLED and NOT_SETTLED
10. List of UNVERIFIED assumptions

After this: red-team pass on implementation (not theoretical discussion).

---

## Experiment Priority (Base Sepolia)

### Phase 1 - Core economic safety (4 scenarios)

1. Successful settle -> authorizationState -> AuthorizationUsed -> Transfer -> receipt
2. Duplicate settle -> same PaymentPayload/nonce -> verify second call -> balance -> chain
3. Broadcast + lost response -> UNKNOWN -> txHash absent -> recovery by nonce
4. Expired unused authorization -> validBefore passed -> state=false -> 2 RPC -> NOT_SETTLED

If these 4 pass: core economic safety model validated.

### Phase 2 - Extended (3 scenarios)

5. Reverted tx
6. RPC disagreement
7. Restart recovery

---

## Process

SPEC FROZEN -> EXECUTOR implements -> delivers gate artifacts -> RED-TEAM PASS
PASS = Accept -> full execution lifecycle
FAIL = Executor fixes -> re-deliver -> re-review
PARALLEL: Base Sepolia experiments (Phase 1 first, then Phase 2)

---

## What is NOT happening until gate passes

- No insurance logic
- No payout logic
- No new features
- No scope expansion
- No theoretical architecture discussions

Freeze spec -> implementation -> experiments -> adversarial acceptance.
