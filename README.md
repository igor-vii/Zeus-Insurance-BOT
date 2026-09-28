# Zeus

**Trust and execution infrastructure for AI-agent transactions.**

> **What happens to an agent transaction when payment, execution, and participant observations diverge?**

Zeus is evolving from a standalone insurance application into infrastructure for protecting economic obligations in AI-agent transactions.

The system coordinates and verifies the lifecycle around:

**Payment → Settlement → Execution → Delivery → Evidence → Resolution**

Insurance is one protection mechanism within this broader system, not the whole architecture.

## Why Zeus exists

AI agents can authorize payments automatically, but a settled payment does not necessarily prove that the requested work was executed or that the expected result was delivered.

A transaction can therefore reach states such as:
- payment settled, execution uncertain
- execution completed, delivery not observed
- transport failed after settlement
- response missing after a paid operation
- duplicate/retry attempted while the original payment state is unresolved

Zeus is designed around this boundary between **economic state and observed reality**.

## Core principle

> **Payment is an event. Execution and delivery require evidence.**

The system preserves uncertainty when evidence is insufficient:

**UNKNOWN ≠ FAILURE**

This allows reconciliation and recovery to operate on what can actually be established rather than on assumptions.

## Zeus architecture

```
AI Agent / Client
       ↓
   Zeus boundary
       ↓
   Secretariat
       ↓
Payment → Settlement → Execution → Delivery
       ↓
     Evidence
       ↓
    Resolution
       ↓
Protection / Escrow / Other mechanisms
```

### Secretariat

**Zeus Secretariat** is the non-custodial orchestration and evidence layer.

It coordinates payment intents, settlement, reconciliation, seller execution, delivery observations, recovery, and resolution.

→ [`Zeus Secretariat`](zeus-secretariat/README.md)

### Protection mechanisms

Insurance, reserves, escrow, and related mechanisms can provide economic protection around specific transaction risks.

The repository still contains the original Zeus Insurance implementation and its on-chain contracts. That history remains part of the project; the broader Zeus architecture now places those mechanisms within a larger execution-protection model.

## Non-custodial boundary

Zeus components are designed around explicit custody boundaries.

Secretariat is not intended to become the holder of a client's private key or the custodian of client funds. Client authorization and transaction evidence remain distinct from orchestration and resolution.

## External testing

The Zeus system is also tested from outside its production boundary by **Argus Agent Test Lab**.

Argus asks whether the system behaves correctly when payment, execution, delivery, network behavior, retries, or participant behavior diverge.

```
Zeus / Secretariat = system being tested
Argus              = external testing and evidence layer
```

## Current repository areas

- `zeus-secretariat/` — payment, execution, reconciliation, recovery, evidence
- insurance contracts and protection logic
- escrow components
- MCP/API integration
- tests and engineering documentation

## Documentation

- [`Zeus Secretariat`](zeus-secretariat/README.md)
- [`Secretariat canonical execution path`](zeus-secretariat/docs/CANONICAL_V0_EXECUTION_PATH.md)
- [`Zeus roadmap`](zeus-secretariat/docs/ROADMAP_2026-08-29.md)

## Original insurance implementation

Zeus began as an insurance protocol for autonomous AI-agent transactions, including delivery-failure and related economic protection.

That implementation remains in this repository.

The current public framing is broader:

> **Zeus is infrastructure for protecting economic obligations when payment, execution, delivery, and evidence do not automatically agree.**

## License

MIT