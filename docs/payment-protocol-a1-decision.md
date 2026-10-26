# A1 — Payment Protocol Model: Decision Memo (R8, 2026-10-26)

**Status: OPEN — requires the owner's call. Nothing else in the codebase blocks on it.**
Origin: external audit `secretariat-audit.md` finding A1 (verified against code —
the description below is accurate as of main @ R8).

## What exists today (verified)

The Zeus Secretariat is a **pay-then-prove client**, not a standard x402 client:

1. Secretariat discovers a seller endpoint, gets the 402 payment terms, builds and
   signs an EIP-3009 authorization (or relays an external Stage-B signature).
2. Secretariat calls **its own facilitator** (`zeus-facilitator`, D2) to `verify`
   and `settle` — the money moves **before** the seller is ever called.
3. Only then does the post-settlement engine call the seller (`Content-Type` +
   `Idempotency-Key`; no `X-PAYMENT`, no `PAYMENT-SIGNATURE`, no tx-hash header).

A standard x402 v2 seller expects the opposite order: it receives the request with
the `X-PAYMENT` header, verifies and settles **via its own facilitator**, then
returns 200 with `X-PAYMENT-RESPONSE`. A standard seller answered our bare
post-settlement call with 402, which (since R7-B2) is honestly classified as a
definitive failure after the money already moved.

## Why it exists

- The seller leg is idempotent-by-key and money-ordered: **the paid call can never
  race or double-fire while a settlement is ambiguous** — settlement truth is
  established first, then delivery, with fenced retries (INV-9/10/13).
- The Zeus ecosystem is self-contained: Zeus sellers + Zeus facilitator + Zeus
  buyer. Inside that perimeter the model is coherent and safe.
- The R7/R8 repair packages made the model *honest* (no more fake FAILED/UNKNOWN
  collapse) and unified the wire to canonical v2 on every leg.

## What changed with R8-A4 (this round)

The seller side now runs the **official v2 middleware** (`@x402/express` +
`@x402/evm`, no patch). Consequences:

- **Standard x402 clients can already pay Zeus sellers.** The middleware's
  verify→route→settle loop is the reference implementation's, pointed at the Zeus
  facilitator. Third-party buyers need nothing from us.
- The remaining gap is one-directional: **the Zeus buyer (Secretariat) still cannot
  buy from third-party standard sellers**, because it never sends `X-PAYMENT` and
  never lets the seller settle.

## Option A — declare pay-then-prove a Zeus extension (document + gate)

- Action: write the protocol up as a Zeus extension ("x402-ZP: pre-settled
  delivery with idempotent retry tokens"), restrict Secretariat targets to
  Zeus-approved sellers (config allowlist), ship a `PAYMENT-PROOF` header carrying
  the settle receipt so Zeus sellers can verify on their side if they choose.
- Cost: ~1-2 days (mostly docs + an allowlist check + one header).
- Risk: none to the current money path; the interop gap stays deliberate.
- When it wins: mainnet scope is Zeus-owned endpoints (the current reality).

## Option B — implement the standard client flow

- Action: Secretariat gains a second transport: send `X-PAYMENT` to the seller and
  let the **seller's** facilitator verify/settle, parse `X-PAYMENT-RESPONSE`,
  reconcile on the seller's settlement result. The pay-then-prove path stays for
  Zeus sellers.
- Cost: week-scale. Touches the settlement state machine (a settlement owned by a
  *remote* facilitator), evidence schema, reconciliation inputs, and needs a
  testnet seller to certify against.
- Risk: new failure modes in the money path (seller-side settle can revert after
  the route responded; the response must not be trusted before on-chain truth —
  the exact class of bug R7 just removed).
- When it wins: Secretariat must transact with arbitrary third-party x402 APIs.

## Recommendation

**A now, B later behind a capability flag.** Ship A as the documented, gated
extension before mainnet; implement B only when a concrete third-party seller
integration exists, and certify it on base-sepolia first (real v2 seller +
Zeus facilitator), never on X Layer first.
