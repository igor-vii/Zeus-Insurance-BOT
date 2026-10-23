# B4 — Block C: Current Execution/Evidence Boundary

## Definition

Block C contains scenarios whose intended semantic test cannot currently be brought to a meaningful, evidence-backed completion by the canonical Argus runtime. C is a boundary classification, not a failure verdict and not a repair task.

## S3 — Crash After Settlement

**Purpose:** verify that after settlement a crash/restart does not create a second settlement and that seller execution resumes after recovery.

**Intended processing:** settlement → crash → restart → recovery → resumed forwarding, with evidence proving exactly one settlement and resumed forwarding after recovery.

**Current boundary:** the crash targets infrastructure and triggers on `payment_settled`; L0-F2 declares infrastructure/lifecycle dispatch non-runtime. Required `recovery_completed` and `forward_request` evidence have no canonical emitters.

**Current result:** INCONCLUSIVE / NOT EXECUTABLE semantically.

**B4 treatment:** keep in C. Do not add lifecycle dispatch, infrastructure interception, recovery machinery, or new evidence emitters.

## S4 — Seller Timeout

**Purpose:** verify that settled payment plus absent seller response yields `DELIVERY_UNKNOWN`, not SUCCESS or FAILED and not a second payment.

**Intended processing:** settlement → seller delivery does not return → explicit `delivery_unknown` → evidence proves no duplicate settlement and no false terminal success/failure.

**Current boundary:** canonical `action_deliver` uses an infinite hang. The engine cannot manufacture `delivery_unknown`; timeout alone is deliberately not interpreted as UNKNOWN. The finite smoke-loop copy is harness behavior, not the canonical scenario.

**Current result:** PARTIALLY EXECUTABLE / INCONCLUSIVE without explicit Sut-owned UNKNOWN evidence; therefore classified C for the current B4 architecture.

**B4 treatment:** keep in C. Do not convert timeout into UNKNOWN, add a hidden timeout verdict, or introduce new lifecycle semantics.

## C-block rule

C means: the semantic test is defined, but the current Argus runtime/evidence boundary cannot produce the required proof chain. It does not mean the scenario is logically invalid and does not authorize repair during B4.
