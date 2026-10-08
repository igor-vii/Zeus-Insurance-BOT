# B4 — Block A: Direct Bilateral Scenarios

## Definition

Block A contains direct bilateral interactions: **CLIENT ↔ RESOURCE_SERVER**, without a facilitator/orchestrator intermediary in the request path.

## S8 — X402 Payment Flow

**Purpose:** verify the x402 payment-required exchange at the engine boundary.

**Participants:** `client-1` is CLIENT; `sut-1` is RESOURCE_SERVER.

**Topology:** `client-1 → sut-1`.

**Processing:** client requests a protected resource; the resource server returns PAYMENT_REQUIRED; the configured PaymentResolver signs; ScenarioEngine retries through `actWithSignature`; engine records `payment_signed_and_retried`.

**Primary observable:** `engine:payment_signed_and_retried`.

**What this proves:** the payment-required → sign → retry control flow.

**What this does not prove:** on-chain settlement, final delivery, successful resource execution, or economic finality. `payment_signed_and_retried` must not be interpreted as `payment_settled`.

**Current result:** PASS when the expected engine evidence is observed; otherwise the current assertion returns FAIL.

## Boundary

B4 adds no new x402 behavior or settlement semantics to Block A.
