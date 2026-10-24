# B4 Readiness / Closure Audit — 2026-10-01

## Status

**B4: NOT CLOSED.**

Canonical main was audited after B6-B closure at commit f1fb302b1548b202b5d370f60e513391ffdd8820.

This is a read-only semantic audit. No source or test files were changed by this audit.

B4 remains an approved roadmap stage. B6-B closure does not implicitly close B4 and does not create B7 readiness.

## B4 contract

The canonical backlog defines B4 as scenario semantic cleanup of S1-S7, covering:
- live versus mock semantics;
- final outcome semantics;
- INCONCLUSIVE handling;
- participant identity;
- fault declarations versus actually executable faults;
- migration from declarative scenarios to observable runtime behavior.

## Scenario-by-scenario audit

| Scenario | Current canonical state | B4 semantic status |
|---|---|---|
| S1 | Duplicate request is executable through action fault dispatch; assertion observes Sut-owned payment-intent evidence. | CLOSED for current Model V0/mock contour. |
| S2 | Seller action is explicit; delayed response is executable through action_deliver; Sut settlement/success observations are supported by the existing observation channel; PASS path is tested. | CLOSED for the current mock/reference contour. Real external adapter evidence remains future work. |
| S3 | Crash fault targets infrastructure and remains outside active L0-F2 dispatch. Required recovery_completed and post-recovery forward_request evidence are not produced by the canonical runtime. | OPEN. |
| S4 | Seller hang is executable through action_deliver; canonical infinite hang is intentionally non-terminal. The assertion remains INCONCLUSIVE unless the Sut explicitly reports delivery_unknown; the canonical scenario does not provide that observation. | OPEN. UNKNOWN must not be inferred from timeout. |
| S5 | Concurrent duplicate behavior is executable. Passive assert_no_unhandled_errors semantics were corrected in R3 to require positive payment_intent_created evidence. | CLOSED for current Model V0/mock contour. |
| S6 | Three explicit payment actions are present, preserving L0-F2. However, the scenario does not currently observe a settlement_unknown state and therefore does not prove the stated invariant that a new authorization is rejected while settlement remains UNKNOWN. | OPEN. |
| S7 | Seller respond evidence (delivery_sent) exists, but the lost_delivery edge fault remains declared-only/no-op in Mock V0. There is no edge mediator producing delivery_received/loss evidence, so the seller-sent-versus-Sut-not-received claim is not executable. | OPEN. |

## Findings

### B4-F1 — S3 crash/recovery semantics remain incomplete

The canonical scenario declares a crash against the infrastructure/test subject, but L0-F2 keeps infrastructure targets declared-only.

The assertion requires:
1. exactly one settlement;
2. observed recovery;
3. an engine-level resumed forward action after recovery.

The current runtime does not provide the required recovery lifecycle or post-recovery forward evidence.

**Conclusion:** S3 cannot be called semantically closed without introducing a separately authorized runtime mechanism or changing the scenario contract.

### B4-F2 — S4 terminal UNKNOWN remains externally unproven

The canonical S4 hang is intentionally non-resolving. Existing tests demonstrate that the hang is active and that timeout/absence must not be converted into FAIL or DELIVERY_UNKNOWN.

The assertion can PASS when the Sut explicitly reports delivery_unknown, but the canonical S4 scenario does not itself have such an external observation path.

**Conclusion:** S4 is correctly preserved as INCONCLUSIVE under insufficient evidence, but its full stated semantic contour is not closed.

### B4-F3 — S6 retry invariant is not yet proven

S6 now uses three explicit payment actions rather than lifecycle-triggered retry dispatch. This correctly respects L0-F2.

However, the current assertion only evaluates the number of observed payment_settled events. It does not establish the stronger stated condition:

> while reconciliation has not confirmed NOT_SETTLED, a new authorization for the same logical operation is rejected.

No canonical settlement_unknown observation drives an actual rejection test.

**Conclusion:** the dispatch semantics are cleaned up, but the business invariant remains semantically under-tested.

### B4-F4 — S7 edge-loss semantics remain declarative

S7 contains a baseline seller response observation, but the lost_delivery edge target has no active runtime dispatch path in Model V0.

There is consequently no evidence chain:
seller sent -> edge lost -> Sut did not receive

The absence of delivery_received cannot by itself prove that the edge dropped delivery.

**Conclusion:** S7 remains open until a real/observable edge boundary exists. This is consistent with the documented Temporal Trust Boundary and Mock limitation.

## What is already resolved

The following historical B4 concerns are no longer open findings:
- participant identity for ARGUS-owned actors was repaired and verified in R3;
- S2/S4 seller behavior was moved from unreachable lifecycle-trigger faults to executable seller actions;
- S5 passive PASS was corrected so absence of an exception is not sufficient evidence;
- S6 lifecycle-trigger retry dispatch was removed in favor of explicit bounded actions;
- L0-F2 fault-dispatch rules remain intact.

These are resolved sub-findings, not evidence that the whole B4 stage is closed.

## Scope boundary

This audit does not authorize:
- lifecycle fault dispatch;
- infrastructure fault interception;
- timeout -> UNKNOWN inference by Argus;
- edge mediation in Mock V0;
- new persistence/session architecture;
- payer identity architecture;
- public API expansion;
- dashboard, chaos engine, or billing;
- Secretariat-specific integration;
- a new R-series block.

## B4 closure gate

B4 should be considered closed only when the remaining semantic gaps are either:
1. implemented and independently verified within an explicitly approved scope, or
2. explicitly classified as deferred because the required external observable boundary does not exist, with the scenario's expected verdict semantics adjusted/recorded accordingly.

The latter must not manufacture PASS from missing evidence.

## B7 readiness

**NOT READY.**

The approved roadmap remains:
B1.2a -> B1.2b -> B1.3 -> B2 -> B4 -> B6 -> B7

B7 should not be defined merely because B6-B is closed.

The immediate architectural task is therefore **B4 closure decision**, not B7 implementation.

## Evidence inspected

- docs/backlog-open-decisions.md
- docs/evidence-source-map.md
- docs/l0-f2-fault-dispatch-contract.md
- src/scenarios/S1_DuplicateRequest.ts
- src/scenarios/S2_PaymentBeforeExecution.ts
- src/scenarios/S3_CrashAfterSettlement.ts
- src/scenarios/S4_SellerTimeout.ts
- src/scenarios/S5_ConcurrentDuplicate.ts
- src/scenarios/S6_PaymentRetry.ts
- src/scenarios/S7_LostDelivery.ts
- src/core/ScenarioEngine.ts
- src/core/FaultInjector.ts
- src/core/Assertions.ts
- src/tests/scenarios/S2-S4-SellerAction.test.ts

**Audit conclusion: B4 remains OPEN; B7 remains gated.**
