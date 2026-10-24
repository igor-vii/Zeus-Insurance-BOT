# B4.1 — Scenario Inventory

## Scope

This document inventories the current Argus scenario surface as preparation for B4 A/B/C classification.

Inventory covers S1–S8 registered by `src/cli/ScenarioRegistry.ts`, their current implementations, tests, evidence, executability, and known limitations.

B4.1 is reconnaissance only. No scenario behavior, verdict semantics, engine behavior, or architecture is repaired by this document.

## Inventory

| ID | Scenario | Block | Current executability | Current evidence / verdict | Main limitation |
|---|---|---|---|---|---|
| S1 | DuplicateRequest | B | EXECUTABLE | PASS; one `payment_intent_created`, reused key evidence | None identified in inventory |
| S2 | PaymentBeforeExecution | B | PARTIALLY EXECUTABLE | Canonical run INCONCLUSIVE without Sut lifecycle observations; PASS path proven with configured observations | Settlement/success observation channel is harness-configured |
| S3 | CrashAfterSettlement | C | NOT EXECUTABLE | Canonical run INCONCLUSIVE; no settlement, recovery, or forward evidence | Infrastructure crash target is declared-only; recovery_completed/forward_request have no emitters |
| S4 | SellerTimeout | C | PARTIALLY EXECUTABLE | Canonical infinite hang is non-terminating; PASS requires explicit Sut delivery_unknown | No canonical delivery_unknown source; timeout must not imply UNKNOWN |
| S5 | ConcurrentDuplicate | B | EXECUTABLE | PASS; one payment intent created and four reused; no unhandled exception | None identified in inventory |
| S6 | PaymentRetry | B | PARTIALLY EXECUTABLE | INCONCLUSIVE; three explicit payment actions exist, but UNKNOWN-rejection invariant is unproven | No canonical settlement_unknown observation |
| S7 | LostDelivery | B | NOT EXECUTABLE semantically | INCONCLUSIVE; no reliable lost-delivery evidence | lost_delivery is declared-only/no-op; delivery_received has no emitter |
| S8 | X402PaymentFlow | A | EXECUTABLE | PASS-gated on engine evidence; covered by X402FullFlow and lifecycle observation tests | Uses engine evidence; must not be reinterpreted as payment_settled |

## Scenario Details

### S1 — DuplicateRequest

**Purpose:** Test duplicate request handling.

**Participants:** client-1 as CLIENT/ARGUS; resource-server-1 as RESOURCE_SERVER/ARGUS; sut-1 as FACILITATOR/EXTERNAL.

**Processing:** A request reaches the payment-intent path, followed by a duplicate request using the same key.

**Fault:** `duplicate_request` on `action_request_payment`; active.

**Observable evidence:** `payment_intent_created` with the expected key and duplicate/reuse behavior.

**Current status:** EXECUTABLE. Default mock probe produced PASS with one payment intent created.

### S2 — PaymentBeforeExecution

**Purpose:** Test that payment-before-execution behavior preserves the intended payment/execution ordering and observations.

**Participants:** client-1 CLIENT/ARGUS; resource-server-1 RESOURCE_SERVER/ARGUS; sut-1 FACILITATOR/EXTERNAL; seller delivery action.

**Processing:** Payment request is followed by seller delivery processing, with delayed response behavior available.

**Fault:** `delayed_response` on `action_deliver`; active. Resource-server action emits delivery started/completed observations.

**Observable evidence:** Payment settlement/success observations when supplied through the configured Sut lifecycle-observation channel; delivery evidence from the seller action.

**Current status:** PARTIALLY EXECUTABLE. The canonical scenario is INCONCLUSIVE when required settlement evidence is absent. The PASS path is demonstrated in `S2-S4-SellerAction.test.ts` when lifecycle observations are explicitly configured.

### S3 — CrashAfterSettlement

**Purpose:** Test behavior when a resource/infrastructure crash occurs after settlement and recovery is required.

**Participants:** client-1 CLIENT/ARGUS; resource-server-1 RESOURCE_SERVER/ARGUS; sut-1 FACILITATOR/EXTERNAL.

**Processing:** Intended flow is settlement, crash, recovery, then observable recovery/forward processing.

**Fault:** `crash` targeting infrastructure and triggered by `payment_settled`; currently declared-only and not dispatched.

**Observable evidence:** Current run produces only intent/payment-action evidence. Required `recovery_completed` and `forward_request` evidence have no emitters.

**Current status:** NOT EXECUTABLE semantically. Canonical run is INCONCLUSIVE because settlement/recovery evidence cannot establish the intended outcome.

**Finding:** B4-F1 — architecture/evidence boundary.

### S4 — SellerTimeout

**Purpose:** Test seller non-response / delivery uncertainty.

**Participants:** client-1 CLIENT/ARGUS; resource-server-1 RESOURCE_SERVER/ARGUS; sut-1 FACILITATOR/EXTERNAL; seller delivery action.

**Processing:** Seller delivery is intentionally hung.

**Fault:** `hang` with `duration_ms: -1` on `action_deliver`; active.

**Observable evidence:** A valid PASS requires explicit Sut-owned `delivery_unknown`. The timeout itself must not be interpreted as UNKNOWN or failure.

**Current status:** PARTIALLY EXECUTABLE. The canonical infinite hang does not terminate in-process. The shared smoke loop uses a finite copy with `duration_ms: 10`, which is not the same canonical scenario. Harness-configured lifecycle observations can supply the explicit UNKNOWN observation.

**Finding:** B4-F2 — evidence/architecture boundary.

### S5 — ConcurrentDuplicate

**Purpose:** Test concurrent duplicate request handling.

**Participants:** client-1 CLIENT/ARGUS; resource-server-1 RESOURCE_SERVER/ARGUS; sut-1 FACILITATOR/EXTERNAL.

**Processing:** Five concurrent requests target the same payment-intent key.

**Fault:** `concurrent_request(5)` on `action_request_payment`; active.

**Observable evidence:** One `payment_intent_created`, four reused requests, and no unhandled exception.

**Current status:** EXECUTABLE. Passive-PASS behavior was corrected in R3-D3.

### S6 — PaymentRetry

**Purpose:** Test bounded payment retry behavior and the invariant that a new authorization is not accepted when settlement remains UNKNOWN.

**Participants:** client-1 CLIENT/ARGUS; resource-server-1 RESOURCE_SERVER/ARGUS; sut-1 FACILITATOR/EXTERNAL.

**Processing:** Three explicit `action_request_payment` attempts are executed with distinct keys. This replaced lifecycle-triggered retry dispatch.

**Faults:** `[]`; retry behavior is represented explicitly by the scenario actions.

**Observable evidence:** Payment-settled evidence is counted by the assertion. No canonical `settlement_unknown` observation currently drives the stated rejection invariant.

**Current status:** PARTIALLY EXECUTABLE / invariant under-tested.

**Finding:** B4-F3 — evidence gap.

### S7 — LostDelivery

**Purpose:** Test delivery loss between seller response and recipient receipt.

**Participants:** client-1 CLIENT/ARGUS; resource-server-1 RESOURCE_SERVER/ARGUS; sut-1 FACILITATOR/EXTERNAL; response edge.

**Processing:** Seller response should produce delivery evidence and an edge fault should prevent successful receipt.

**Fault:** `lost_delivery` is currently declared-only/no-op.

**Observable evidence:** `delivery_received` has no emitter in the current mock allow-list. Inventory probing also observed that a baseline responder is returned by `getRespondersForEvent('action_request_payment')`, but no `delivery_sent` evidence appeared in the observed run.

**Current status:** NOT EXECUTABLE semantically.

**Finding:** B4-F4 — implementation/evidence boundary. The responder-emission anomaly is a candidate defect and must be dispositioned separately; absence of `delivery_received` is not proof of lost delivery.

### S8 — X402PaymentFlow

**Purpose:** Test the x402 payment-required/payment-signature flow at the engine boundary.

**Participants:** client-1 CLIENT/ARGUS; sut-1 RESOURCE_SERVER/EXTERNAL.

**Faults:** None declared. The engine PAYMENT_REQUIRED path emits `payment_signed_and_retried` evidence.

**Observable evidence:** Engine behavior assertions in `X402FullFlow.test.ts` and `LifecycleObservationPlumbing.test.ts`.

**Current status:** EXECUTABLE in the current mock/integrated harnesses.

**Boundary:** `payment_signed_and_retried` must not be reinterpreted as `payment_settled`.

## Current Evidence Map

| Scenario | Key observable evidence | Missing / boundary-limited evidence |
|---|---|---|
| S1 | payment_intent_created; duplicate/reuse behavior | None identified |
| S2 | seller delivery observations; configured lifecycle observations | Canonical settlement/success observation without harness configuration |
| S3 | intent/payment action evidence | payment_settled, recovery_completed, forward_request |
| S4 | seller action/hang behavior; explicit configured delivery_unknown when supplied | Canonical delivery_unknown source |
| S5 | payment_intent_created; reuse; no unhandled exception | None identified |
| S6 | payment action sequence; payment_settled assertion input | settlement_unknown and resulting rejection proof |
| S7 | action response plumbing; observed absence of delivery evidence | reliable delivery_sent, delivery_received, and loss edge evidence |
| S8 | payment_signed_and_retried engine evidence | settlement proof is intentionally outside this engine assertion |

## Known Problems / Candidate Defects

### B4-F1 — S3 crash/recovery lifecycle

The infrastructure crash target is declared but not dispatched. Required recovery and forward-processing evidence has no emitter.

**Disposition:** architecture/evidence boundary; classify during B4.2. No repair performed here.

### B4-F2 — S4 seller timeout

The canonical scenario uses an infinite hang. A timeout must not be converted into UNKNOWN or failure. Explicit `delivery_unknown` is not produced by the canonical scenario.

**Disposition:** evidence/architecture boundary; classify during B4.2. No repair performed here.

### B4-F3 — S6 payment retry invariant

The explicit retry actions are present, but the invariant requiring rejection of a new authorization while settlement remains UNKNOWN is not proven because there is no canonical `settlement_unknown` observation.

**Disposition:** evidence gap; classify during B4.2. No repair performed here.

### B4-F4 — S7 lost delivery

The `lost_delivery` edge fault is declared-only/no-op and `delivery_received` has no emitter. A probe additionally observed a responder returned by `getRespondersForEvent('action_request_payment')` without corresponding `delivery_sent` evidence.

**Disposition:** candidate implementation/evidence defect plus boundary limitation; classify during B4.2. No repair performed here.

### Documentation drift

`docs/l0-f2-fault-dispatch-contract.md` still describes S2/S4 as using lifecycle-triggered declarations, contradicting the post-R3 scenario implementations.

### Harness override dependence

The S1–S7 smoke loop uses a finite copy of S4, and several PASS proofs rely on harness-configured `lifecycleObservations` rather than the canonical scenario files.

## Current Verdict Semantics

Observed scenario verdicts are PASS / FAIL / INCONCLUSIVE with fail-fast aggregation in `AssertionEngine.aggregateResults`.

`RunStatus.FAILED` is distinct from an assertion verdict of FAIL.

The inventory does not infer a verdict from missing evidence, timeout alone, or absence of a downstream observation.

## B4.2 Classification Result

The canonical three-block split is frozen for B4:

- **Block A — Direct bilateral:** `CLIENT ↔ RESOURCE_SERVER`. Current scenario: **S8**.
- **Block B — Intermediated:** `CLIENT → FACILITATOR → RESOURCE_SERVER`. Current scenarios: **S1, S2, S5, S6, S7**.
- **Block C — Currently not executable as a meaningful scenario:** current Argus cannot produce the evidence chain required by the scenario. Current scenarios: **S3, S4**.

Block C is an execution/evidence boundary classification, not a repair target.

**S7 remains Block B** because its intended topology is explicitly `client-1 → sut-1 → resource-server-1 → sut-1`; its responder/emission anomaly is a candidate defect, not an architecture reclassification.

**S8 remains Block A** because its topology is only `client-1 → sut-1`, with `sut-1` as RESOURCE_SERVER. Its `payment_signed_and_retried` evidence proves only the x402 sign-and-retry control flow, not settlement.

## Questions for B4.2

1. Which scenarios belong to Block A, B, or C under the agreed three-block model?
2. Are S3 and S4 C-block boundary-limited scenarios?
3. Does S6 remain in A with a candidate defect, or require a boundary classification?
4. Is S7 currently A with a repairable mock/evidence defect, or C because delivery-edge mediation is absent?
5. Should S8 be included in the B4 scenario register as a separate executable x402 engine-flow scenario?
6. How should the documentation drift in the L0-F2 contract be corrected?
7. Which harness-only observations are acceptable evidence for a scenario specification, and which must be treated as test-harness configuration rather than canonical scenario behavior?

## No-Change Statement

B4.1 inventory work did not modify scenario source, tests, ScenarioEngine, FaultInjector, AssertionEngine, verdict semantics, or architecture. The inventory records the current state and candidate problems only.

Observed verification during reconnaissance: scenario/core tests 89/89 passed and TypeScript typecheck exited 0. These results are recorded as reconnaissance observations, not as a B4 closure gate.
