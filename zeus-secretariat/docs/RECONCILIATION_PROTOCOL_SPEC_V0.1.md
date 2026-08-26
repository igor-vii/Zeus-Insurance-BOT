# ZEUS SECRETARIAT V0 — RECONCILIATION PROTOCOL SPEC V0.1

**Date:** 26.08.2026 | **Status:** READY FOR IMPLEMENTATION
**Scope:** x402 V2 / EVM exact / EIP-3009
**Out of scope:** insurance logic, payout logic, seller retry policy beyond payment safety

## 1. Goal

Implement a mechanism allowing Secretariat to safely recover payment state after:
facilitator timeout, HTTP 5xx, lost response, crash/restart, missing txHash,
settlement_pending, unknown /settle result, temporary RPC unavailability.

**Core principle:** Never create a new payment until Secretariat has proven the previous payment was NOT settled.

## 2. Canonical Economic States

AUTHORIZED, SUBMITTING, SUBMITTED, SETTLEMENT_PENDING, RECONCILING, SETTLED, NOT_SETTLED, UNRESOLVED_MANUAL

API/UI labels: PAYMENT_RECONCILING, PAYMENT_SETTLED, PAYMENT_NOT_SETTLED, PAYMENT_UNRESOLVED_MANUAL

Do NOT use FAILED as result of uncertain settlement.

## 3. Main Economic Invariant

allow_new_payment = (payment_state == NOT_SETTLED)

| State | New Payment |
|-------|-------------|
| AUTHORIZED | No |
| SUBMITTING | No |
| SUBMITTED | No |
| SETTLEMENT_PENDING | No |
| RECONCILING | No |
| SETTLED | No |
| NOT_SETTLED | Yes |
| UNRESOLVED_MANUAL | No |

Hard safety rule. No timeout, HTTP error, or missing txHash grants right to create new payment.

## 4. Durable Payment Intent

Before first network call, persist: paymentIntentId, operationId, requestId, clientId,
authorizer, payTo, value, asset, network, nonce, validAfter, validBefore,
paymentPayload, paymentPayloadHash, createdAt, submitAttemptAt.

Must exist BEFORE /settle.

## 5. /settle Is NOT Source of Truth

| Response | State |
|----------|-------|
| Success + txHash | SETTLEMENT_PENDING (not auto SETTLED) |
| settlement_pending + txHash | RECONCILING |
| HTTP 500 | RECONCILING |
| timeout | RECONCILING |
| no response | RECONCILING |
| facilitator rejected | RECONCILING (blockchain has priority) |

## 6. Blockchain Is System of Record

Primary primitive: authorizationState(address authorizer, bytes32 nonce)
Secondary: AuthorizationUsed(authorizer, nonce) for txHash recovery.

## 7. SETTLED Proof (minimum bundle)

- authorizationState(authorizer, nonce) == true
- AuthorizationUsed(authorizer, nonce) -> transactionHash
- transactionReceipt.status == 1
- Transfer(from=authorizer, to=payTo, value >= requiredAmount)
- Sufficient confirmations per network config

authorizationState==true alone is NOT sufficient proof of money received.

## 8. Transfer Matching

Same transaction, token==expected asset, from==authorizer, to==payTo, value >= required.
V0 policy: >= (may tighten to == later).

## 9. Reverted Transaction

receipt.status==0 -> NOT_SETTLED for this attempt only.
Reverted events/state changes are NOT economic evidence.
Contradictory RPC picture -> UNKNOWN.

## 10. UNKNOWN Without txHash Flow

RECONCILING -> authorizationState check:
- RPC error -> RECONCILING
- true -> recover tx via logs -> success+Transfer -> SETTLED / inconsistent -> UNKNOWN
- false + before validBefore -> RECONCILING
- false + after validBefore -> multi-RPC: agree false -> NOT_SETTLED / conflict -> UNKNOWN

## 11. NOT_SETTLED Strict Proof (ALL must hold)

A: current time >= validBefore
B: authorizationState == false
C: >= 2 independent RPC observations both false
D: RPCs are current (not stale)
E: No contradicting on-chain evidence

## 12. What Is NOT Proof of NOT_SETTLED

HTTP 500, timeout, txHash==null, AuthorizationUsed not found, validBefore expired — none sufficient alone.

## 13. Why validBefore Is Critical

Before validBefore: absence of settlement != failure.
After validBefore + state==false + multi-RPC -> can prove NOT_SETTLED.

## 14. RPC Policy

Minimum 2 independent RPC observations for negative economic decision.
Config: RPC_PRIMARY, RPC_SECONDARY, RPC_OPTIONAL_THIRD.

| A | B | Result |
|---|---|--------|
| false | true | UNKNOWN |
| timeout | false | UNKNOWN |
| false | false + expired | NOT_SETTLED |

## 15. RPC Independence

Two endpoints of same underlying provider do NOT count as independent.

## 16. Reconciliation Schedule (configurable)

T+2s -> T+10s -> T+30s -> T+2m -> periodic until validBefore + 2min buffer.

## 17. Reconciliation Priority

1. txHash known -> eth_getTransactionReceipt first
2. Receipt found -> status, logs, confirmations
3. Receipt absent -> RECONCILING
4. txHash absent -> authorizationState -> if true: AuthorizationUsed log lookup

## 18. Crash Recovery

On restart: find all non-terminal intents -> move to RECONCILING.
Never auto-repeat /settle just because previous process died. Reconcile first.

## 19. Duplicate /settle Protection

Facilitator idempotency not guaranteed. Secretariat must have own guard:
unique paymentIntentId, row lock / CAS state transition.
Two workers must not simultaneously decide UNKNOWN -> new payment.

## 20. Investigation Idempotency

Repeated investigate(paymentIntentId) allowed. Does not create new payment. Evidence accumulates.

## 21. Terminal Transition Protection

RECONCILING->SETTLED and RECONCILING->NOT_SETTLED must be atomic.
Second worker's conflicting terminal transition is rejected. Terminal state cannot be silently overwritten.

## 22. Evidence Model

Every reconciliation attempt persisted with: attemptId, paymentIntentId, timestamp, rpcProvider, headBlock, authorizationState, validBefore, result.

Settlement evidence: authorizationUsed(txHash, blockNumber, logIndex), receipt(status), transfer(from, to, value).

## 23. NOT_SETTLED Evidence

Required: payload/payloadHash, authorizer, nonce, validBefore, authorizationState=false, RPC A+B observations, timestamps, chain heads.

## 24. Reorg Handling

After SETTLED: configurable N confirmations. Chain contradiction after terminal -> INCIDENT, not auto SETTLED->NOT_SETTLED.

## 25. Client Retry

Client retries during RECONCILING -> return existing state. No new payment.

## 26. When New Payment Allowed

Only NOT_SETTLED + new paymentIntentId + new nonce + new authorization.

## 27. Seller Execution Separate From Reconciliation

Payment reconciliation and seller execution recovery are separate layers.

## 28. Mandatory Adversarial Tests (A-L)

A: Facilitator got payment, crash, response lost -> RECONCILING -> chain recovery
B: Broadcast, txHash lost -> AuthorizationUsed -> recovered -> SETTLED
C: Facilitator 500 after broadcast -> RECONCILING -> chain resolution
D: Facilitator timeout after broadcast -> RECONCILING
E: Facilitator rejected, blockchain successful -> SETTLED
F: RPC A false, RPC B true -> UNKNOWN
G: receipt.status=0 -> NOT_SETTLED (no competing settlement)
H: Expired, state false, two RPC agree -> NOT_SETTLED
I: Expired, RPC disagreement -> UNKNOWN/MANUAL
J: Two reconciliation workers -> one terminal transition
K: Client retries while UNKNOWN -> no new payment
L: Two workers attempt new payment after NOT_SETTLED -> single new intent

## 29. Forbidden Shortcuts

- HTTP 500 -> FAILED
- timeout -> NOT_SETTLED
- no txHash -> NOT_SETTLED
- validBefore expired -> NOT_SETTLED (without multi-RPC)
- AuthorizationUsed -> SETTLED (without Transfer matching)
- authorizationState=true -> blindly SETTLED
- facilitator success -> SETTLED
- duplicate /settle -> assumed safe
- UNKNOWN -> new nonce/payment

## 30. Acceptance Criteria (AC1-AC12)

AC1: After crash, investigation continues without new client signature
AC2: Lost facilitator response does not cause duplicate payment
AC3: Lost txHash recovered via on-chain evidence
AC4: Successful settlement determined via chain evidence
AC5: Reverted transaction not counted as settlement
AC6: NOT_SETTLED impossible before expiry without sufficient evidence
AC7: NOT_SETTLED impossible with RPC disagreement
AC8: Two workers cannot create two payments for one operation
AC9: Client retry during reconciliation creates no new payment
AC10: All reconciliation observations durable
AC11: State transitions auditable
AC12: All tests A-L pass

## 31. Deliverables

1. Implementation 2. DB/state changes 3. Reconciliation worker 4. RPC adapter (multi-provider)
5. Evidence persistence 6. Tests A-L 7. Crash/restart test 8. Duplicate settlement test
9. RPC disagreement test 10. Implementation report

Separate: "Which assumptions were experimentally verified vs implementation-dependent?"
