# Standard x402 Transport — Claim Boundary (R9-A1, 2026-10-26)

Style reference: Once (onceexec.com) "Claim boundary" — narrow, honest claims.
This document states exactly what the standard transport guarantees, what it
does NOT, and where the edges are.

## What this is

`StandardX402Transport` (`zeus-secretariat/src/core/standard-x402-transport.ts`)
implements the **canonical x402 v2 CLIENT flow** for third-party sellers
(A1 decision memo, Option B):

1. The signed EIP-3009 payload travels in the `PAYMENT-SIGNATURE` header
   (base64 canonical JSON — byte-compatible with `@x402/core`'s
   `encodePaymentSignatureHeader`, verified against 2.28.0).
2. The SELLER's own facilitator verifies + settles during the paid request;
   the same response carries `PAYMENT-RESPONSE` (base64) and the route result.
3. The seller's settlement CLAIM is persisted (`txHash`) and verified by the
   ordinary reconciliation machinery (multi-RPC receipt consensus +
   `AuthorizationUsed` nonce-scan fallback). It is NEVER trusted inline.
4. Execution is discharged atomically by the paid call — there is NO
   post-settlement seller leg (a second call would 402 or double-pay).
   The `STANDARD_PAID_CALL` marker on the intent tells the scanner and the
   SettlementFeedbackService this.
5. Honest verdicts: `2xx + strict receipt → SUBMITTED`; `2xx without/invalid
   receipt → UNKNOWN (fail-closed)`; `402 → REJECTED (pre-settle refusal,
   durable RECONCILING so the reconciler confirms the nonce is unused)`;
   `408/409/429/5xx/network → UNKNOWN`. The transport NEVER throws.

Selection: `policy.transport: "standard"` per request, or
`ZEUS_PAYMENT_TRANSPORT=standard` deployment-wide (default "zeus" — the
pay-then-prove flow is unchanged for Zeus-perimeter targets).

## What we claim

- **One settlement per operation.** Durable CAS (`transitionToSubmitting`)
  before any network exposure; one submit per intent; duplicate submits fail
  closed. Certification: `tests/r9-a1-standard-transport.test.ts` —
  24 scenarios, seller effects counted from an append-only journal
  (methodology adapted from Once hostile-retry labs).
- **One paid seller call per operation.** Sync path, async crash window, and
  scanner race are all covered: the scanner skips `STANDARD_PAID_CALL`
  intents; the SettlementFeedbackService completes the FSM from the durable
  marker (`EXECUTION_PENDING → EXECUTION_CONFIRMED → DELIVERED → SUCCESS`).
- **Settlement truth is on-chain only.** The seller's claimed tx is verified
  by the existing ReconciliationEngine. A receipt we cannot verify keeps the
  operation in SETTLEMENT_PENDING (public status PROCESSING), never SUCCESS.
- **No unpaywalled results.** A 200 without a canonical settlement receipt is
  UNKNOWN; the captured body is retained for forensics but is NOT delivered
  as an operation result.
- **Wire compatibility** with the official `@x402/*` v2 stack (header names,
  encoding, canonical payload shape) and with our own seller middleware
  (api-server runs the official `@x402/express` — the same stack third-party
  sellers run, making it a faithful certification target).

## What we do NOT claim

- **No universal exactly-once.** If the seller settles and the response is
  lost (timeout after settle), the money moved and the result is unknown —
  the operation terminates honestly as `UNRESOLVABLE` after reconciliation
  confirms the nonce was used. This is the physics of any x402 client, not a
  fixable bug.
- **No seller-trust assumptions removed.** A malicious seller can 402 AFTER
  settling, or return a receipt for a tx that never happened; reconciliation
  detects both, but detection ≠ refund recovery.
- **Supported paths are narrow (fail-closed elsewhere):**
  - EVM `exact` scheme only (EIP-3009 / `transferWithAuthorization`).
  - Networks whose USDC EIP-712 domain is pinned in the signer grid
    (D1-verified: `eip155:196` "USD Coin"/"2"; base-sepolia for certification).
    A new chain requires the D1 procedure BEFORE first payment.
  - Sellers whose middleware verifies the payload against their route config;
    a middleware that strict-matches `maxTimeoutSeconds` may refuse the
    payload — that surfaces as an honest 402 → REJECTED, re-discover and
    retry with fresh terms.
- **Free resources are out of scope.** If a target stops requiring payment,
  the paid call returns 200 without a receipt → UNKNOWN → reconciler proves
  the nonce unused → NOT_SETTLED → FAILED. We do not silently accept
  unpaywalled deliveries.
- **Non-EVM rails (SVM etc.) are out of scope** for this iteration.

## Certification matrix (Once-style, effects counted from the seller journal)

| # | Scenario | Verdict | Seller paid calls |
|---|----------|---------|-------------------|
| 1 | Happy path (200 + receipt + body) | SUCCESS, result delivered, tx persisted | 1 |
| 2 | 402 on the paid call | REJECTED → FAILED, durable RECONCILING | 1 |
| 3 | 200 without receipt | UNKNOWN → non-terminal (reconciler owns) | 1 |
| 4 | Network error mid-call | UNKNOWN, never throws | 1 |
| 5 | 408/409/429/503 | UNKNOWN | 1 |
| 6 | 400/401/403/404 | REJECTED → FAILED | 1 |
| 7 | success:false / bad tx / missing tx receipt | UNKNOWN (strict parsing) | 1 |
| 8 | GET target | no body on the paid call | 1 |
| 9 | Discovery probe | carries NO PAYMENT-SIGNATURE | 0 |
| 10 | Scanner race after crash | skip — no seller re-call | +0 |
| 11 | Async SETTLED + marker with body | SUCCESS from durable marker | +0 |
| 12 | Async SETTLED without body | honest UNRESOLVABLE | +0 |
| 13 | Zeus-mode intent (no marker) | SETTLED only; engine leg unchanged | +0 |
| 14 | Duplicate feedback apply | idempotent no-op | +0 |
| 15–24 | Header/wire invariants | PAYMENT-SIGNATURE decodes to canonical payload; Idempotency-Key = operationId; maxTimeoutSeconds restored from discovery; CAS discipline | — |

Full lifecycle (1 → 11 → 10 in sequence) keeps the total at **exactly one**
paid seller call — the one-effect invariant.

## Certification plan beyond the unit matrix

1. **Own stack first** (no marketing needed): Secretariat (standard mode) →
   api-server's official `@x402/express` middleware → zeus-facilitator, on
   base-sepolia — a faithful full-loop rehearsal.
2. **base-sepolia against an external reference seller** (official x402
   examples), never X Layer first.
3. **X Layer live rehearsal** with a funded wallet only after (1) and (2).
