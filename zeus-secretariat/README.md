# Zeus Secretariat

**Payment, execution, delivery, evidence, and resolution for AI-agent transactions.**

Zeus Secretariat is the orchestration and evidence layer within the Zeus system.

Its purpose is to coordinate a transaction across the boundary where **payment, settlement, execution, and delivery can diverge** — without becoming the custodian of the client's funds or private keys.

## The problem

For an agent transaction, these states are not equivalent:
- payment authorized
- payment settled
- seller execution started
- execution completed
- delivery observed
- obligation resolved

A successful payment does not by itself prove that the requested execution occurred or that the expected result was delivered.

Secretariat therefore treats the transaction as an evidence-backed lifecycle rather than a single payment event.

## Canonical execution path

```
CLIENT → SECRETARIAT API → REQUEST → x402 PAYMENT REQUIRED (402)
→ CLIENT-SIGNED EIP-3009 PAYMENT → PAYMENT INTENT
→ FACILITATOR SETTLEMENT → RECONCILIATION → SETTLED
→ SELLER EXECUTION → DELIVERY OBSERVATION → EVIDENCE → RESOLUTION
```

The canonical implementation details are maintained in:

- [`CANONICAL_V0_EXECUTION_PATH.md`](docs/CANONICAL_V0_EXECUTION_PATH.md)

## Evidence and uncertainty

Secretariat distinguishes proven outcomes from incomplete observation.

```
PROVEN_SUCCESS
PROVEN_FAILURE
UNRESOLVED
DELIVERY_UNKNOWN
```

> **UNKNOWN ≠ FAILURE**

When the available evidence cannot establish what happened, the system preserves the unresolved state rather than converting missing evidence into a definitive failure.

This is important after crashes, timeouts, transport errors, delayed delivery, or a settlement response that does not reveal the final execution state.

## Economic safety

The core payment safety rule is:

```
allow_new_payment(state) = (state == NOT_SETTLED)
```

After a payment may have settled, recovery and reconciliation must establish the state before another payment-side effect is created.

Crash recovery therefore reconciles existing payment state first; it does not blindly resubmit a possibly settled payment.

## Non-custodial boundary

Secretariat is an orchestration and evidence layer.

It does **not** require the client to transfer custody of funds to Secretariat, and the production boundary must not require Secretariat to hold the client's private key.

The client signs its payment authorization; Secretariat coordinates the lifecycle and records the resulting evidence.

## Relationship to Zeus

Zeus is evolving from a standalone insurance application into broader infrastructure for protecting economic obligations in AI-agent transactions.

Within that system:

```
Zeus
├── Secretariat
│   └── payment / execution / evidence / resolution
├── protection mechanisms
├── escrow
└── other trust and risk components
```

Insurance remains one possible protection mechanism. Secretariat provides the underlying transaction-orchestration and evidence boundary.

## Relationship to Argus

**Argus Agent Test Lab** is an independent external testing layer.

Argus can test Secretariat through observable interfaces and evidence:

```
Argus → external target interaction → Secretariat
                                  ↓
                    payment → settlement → execution → delivery
                                  ↓
                            observable evidence
                                  ↓
                              Argus verdict
```

This separation is intentional: the system under test should not define its own test evidence.

## Status

The V0 execution path is frozen as the current canonical implementation path. Engineering and hardening continue around payment reconciliation, execution recovery, delivery uncertainty, and externally observable evidence.

This document describes the architecture and boundary; it is not a claim that every production integration is complete.

## Documentation

- [`CANONICAL_V0_EXECUTION_PATH.md`](docs/CANONICAL_V0_EXECUTION_PATH.md)
- [`ROADMAP_2026-08-29.md`](docs/ROADMAP_2026-08-29.md)