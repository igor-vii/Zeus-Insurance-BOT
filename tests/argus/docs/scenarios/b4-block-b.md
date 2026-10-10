# B4 — Block B: Intermediated Scenarios

## Definition

Block B contains architectures where the client interacts through an intermediary: **CLIENT → FACILITATOR → RESOURCE_SERVER**. The facilitator may be the system under test.

## S1 — Duplicate Request

**Purpose:** verify duplicate request/idempotency handling in an intermediated payment-intent flow.

**Topology:** `client-1 → sut-1 → resource-server-1`.

**Processing:** client requests payment; the active duplicate fault repeats the same payment action; facilitator evidence proves reuse.

**Evidence:** one payment-intent creation plus reuse keyed by the same idempotency key.

**Current result:** EXECUTABLE.

## S2 — Payment Before Execution

**Purpose:** verify payment/execution ordering when delivery follows the payment request.

**Topology:** `client-1 → sut-1 → resource-server-1`.

**Processing:** client requests payment; seller delivery is delayed; seller emits delivery observations; settlement/success observations may be supplied through configured lifecycle observations.

**Evidence boundary:** configured lifecycle observations are harness evidence unless produced by the canonical target integration.

**Current result:** PARTIALLY EXECUTABLE; missing canonical settlement/success evidence leaves the run INCONCLUSIVE.

## S5 — Concurrent Duplicate

**Purpose:** verify concurrent idempotency behavior.

**Topology:** `client-1 → sut-1 → resource-server-1`.

**Processing:** five concurrent payment requests use the same payment-intent key.

**Evidence:** one `payment_intent_created`, four reuse outcomes, and no unhandled exception.

**Current result:** EXECUTABLE.

## S6 — Payment Retry

**Purpose:** test bounded retry behavior and the invariant that a fresh authorization is not accepted while settlement remains UNKNOWN.

**Topology:** `client-1 → sut-1 → resource-server-1`.

**Processing:** three explicit payment actions execute sequentially with distinct idempotency keys.

**Evidence boundary:** the current assertion counts `payment_settled`, but no canonical `settlement_unknown` observation drives the stated rejection invariant.

**Current result:** PARTIALLY EXECUTABLE / invariant under-tested. Candidate evidence defect; no repair in B4.

## S7 — Lost Delivery

**Purpose:** test loss between seller response and facilitator receipt without causing duplicate payment.

**Topology:** `client-1 → sut-1 → resource-server-1 → sut-1`.

**Processing:** baseline `respond` should emit `delivery_sent`; an edge `lost_delivery` declaration is intended to prevent receipt; facilitator should observe `delivery_unknown` rather than retry payment.

**Evidence boundary:** the current mock has no reliable edge interception path; `delivery_received` has no emitter. A responder/emission anomaly is recorded as a candidate defect.

**Current result:** NOT EXECUTABLE semantically, but remains Block B because its intended architecture is intermediated.

## Block B evidence rule

Harness-supplied lifecycle observations must be labeled as harness configuration and must not be silently promoted to canonical scenario behavior.

B4 adds no facilitator runtime infrastructure and does not repair S1/S2/S5/S6/S7.
