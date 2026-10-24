# B4 Scenario Structure

B4 organizes the current scenario set by architecture/execution boundary, without moving or changing runtime scenario implementations.

## Block A — Direct bilateral

**Topology:** CLIENT ↔ RESOURCE_SERVER

- S8 — X402Payment

Spec: [b4-block-a.md](./b4-block-a.md)

## Block B — Intermediated

**Topology:** CLIENT → FACILITATOR → RESOURCE_SERVER

- S1 — DuplicateRequest
- S2 — PaymentBeforeExecution
- S5 — ConcurrentDuplicate
- S6 — PaymentRetry
- S7 — LostDelivery

Spec: [b4-block-b.md](./b4-block-b.md)

## Block C — Current execution/evidence boundary

**Meaning:** the intended semantic scenario exists, but the current canonical runtime cannot produce the required evidence chain.

- S3 — CrashAfterSettlement
- S4 — SellerTimeout

Spec: [b4-block-c.md](./b4-block-c.md)

## Runtime/source boundary

The executable scenario implementations remain in src/scenarios/ and remain registered centrally by src/cli/ScenarioRegistry.ts.

B4 does not create separate runtime registries for A/B/C, move scenario source files, change imports, or alter execution semantics.

The A/B/C split is a documentation and planning structure until a later implementation task explicitly requires otherwise.

## Defect boundary

Known scenario defects/evidence gaps remain defects. They are not repaired merely because a scenario is classified into a block.

In particular:

- S3/S4 remain Block C.
- S6 remains Block B with an evidence-gap candidate.
- S7 remains Block B with a responder/emission candidate.
- Harness-only observations remain explicitly labeled as harness configuration.
