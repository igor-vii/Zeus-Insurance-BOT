# Argus Layer Map

This document defines the boundary between the x402 v2 wire protocol, the Argus protocol client, Argus scenario/engine semantics, and application-level orchestration semantics.

## 1. Five layers

| Layer | What lives here | Canonical source | Owner |
|---|---|---|---|
| L1. x402 v2 wire | HTTP/payment headers, PaymentRequired, PaymentRequirements, PaymentPayload, SettlementResponse, CAIP-2 network, EIP-3009 authorization | External x402 specification | Protocol |
| L2. Argus protocol client | X402AgentAdapter, 402 parser, payment selection, PAYMENT-SIGNATURE retry, PAYMENT-RESPONSE capture | Argus implementation of L1 | Argus |
| L3. Argus actions | request_payment, request_resource | Argus scenario model | Argus |
| L4. Argus internal engine | ScenarioEngine, AgentController, RunOrchestrator, evidence, assertions, fault execution | Argus core | Argus |
| L5. Application/orchestrator | payment_intent_created, payment_settled, delivery_unknown, recovery_completed and similar events | Application / Secretariat semantics | Secretariat / application |

**Boundary rule:** L1-L2 are protocol-facing. L3-L4 are Argus semantics and execution. L5 is application-level and is not part of the x402 wire protocol.

## 2. W1-W10 status

| ID | Current state | Classification | Decision |
|---|---|---|---|
| W1 | accepts[].amount replaces v1 maxAmountRequired | Wire conformance | FIXED in A1.2-A |
| W2 | PAYMENT-RESPONSE uses success/transaction/network | Wire conformance | FIXED in A1.2-A |
| W3 | Top-level PaymentRequired.resource present | Wire conformance | FIXED in A1.2-A |
| W4 | Type/runtime consistency | Argus model | FIXED in A1.2-A |
| W5 | v1 resource residue removed from accepts[] | Wire conformance | FIXED in A1.2-A |
| W6 | 402 parser has body fallback | Argus tolerance beyond strict header path | LEAVE + document tolerance |
| W7 | X402AgentAdapter is POST-only | Capability limitation; x402 does not require POST | LEAVE POST-only for MVP + document |
| W8 | Fixture verifies payment off-chain; no on-chain settlement | Fixture limitation | LEAVE + document |
| W9 | Default signing intent source uses zero nonce | Test-only placeholder | LEAVE + explicitly mark test-only |
| W10 | accepted.maxTimeoutSeconds is derived from local binding window rather than selected 402 requirement | Potential semantic mismatch | LIKELY FIX; verify exact code/tests first |

W6-W9 are not to be expanded into architecture work merely to eliminate a difference. W10 requires a focused semantic check before implementation.

## 3. L2 — Argus protocol client

Current capabilities:
- parse PaymentRequired;
- select one accepts[] requirement deterministically;
- sign through PaymentAdapter;
- retry with PAYMENT-SIGNATURE;
- capture PAYMENT-RESPONSE;
- preserve externally observable transport facts.

Current gap: HTTP/X402 adapters do not yet fully populate participant-scoped behavioral observations. This is Block E1.

Argus observes the target from the outside. It must not depend on private keys, signer internals, database state, or private application state.

## 4. L3 — Argus actions

| Action | Current usage | Rule |
|---|---|---|
| request_payment | S1-S7 | Keep as Argus action vocabulary; it is not an x402 wire message |
| request_resource | S8 | Keep as Argus action vocabulary; it describes the protected-resource request |

Do not rename Argus actions merely to mirror protocol terminology.

## 5. L4 — Argus engine

| Capability | Current state | Target |
|---|---|---|
| Action evidence | Implemented | Preserve |
| payment_signed_and_retried evidence | Implemented | Preserve |
| request_payment fault trigger | Live where used | Preserve |
| delivery_started | No general emitter | Needed by dependent scenarios |
| payment_settled | No general emitter | Needed by dependent scenarios |
| settlement_unknown | No general emitter | Needed by dependent scenarios |
| delivery_sent | No general emitter | Needed by dependent scenarios |
| Per-participant adapters | Current path can share adapter construction | Participant identity must survive runtime wiring |
| HTTP/X402 observations | Incomplete | Participant-scoped observable transport evidence |
| lost_delivery execution | No dedicated executor | Block E3 |
| crash execution | No external lifecycle hook | Block E3/future, only where harness permits |

**Important:** the requirements above do not prescribe an event bus. Block E must use the smallest mechanism compatible with the existing Argus architecture. A dedicated event bus is not an approved architectural requirement.

## 6. L5 — application semantics

These concepts are outside x402 and must not be presented as x402 protocol messages.

| Concept | Current state | Layer |
|---|---|---|
| payment_intent_created / reused | Mock path | Application |
| payment_settled | No general emitter | Application |
| delivery_unknown | No general emitter | Application |
| delivery_sent / delivery_completed | Mock/fault path | Application |
| recovery_completed | No general emitter | Application |
| forward_request | Application concept | Application |
| unhandled_exception | Engine/application boundary | Argus/application |

## 7. Canonical source vs our layer

| Topic | Canonical source | Our layer |
|---|---|---|
| PaymentRequired | External x402 specification | Argus parses/observes it |
| PaymentPayload | External x402 specification | Argus constructs it |
| SettlementResponse | External x402 specification | SUT/fixture exposes it; Argus observes it |
| CAIP-2 network | External x402 specification | Argus fixture configuration |
| PAYMENT-* headers | External x402 specification | Argus transports/parses them |
| request_payment / request_resource | — | Argus action vocabulary |
| payment_intent_created / payment_settled | — | Application/Secretariat vocabulary |
| delivery_unknown / recovery_completed | — | Application/Secretariat vocabulary |
| payment_signed_and_retried | — | Argus evidence vocabulary |
| delivery_started / settlement_unknown | — | Argus scenario/fault vocabulary |

## 8. Roadmap

| Block | Status |
|---|---|
| Block A — canonical ProtocolRole | Done |
| A1.1 — forensic x402/action audit | Done |
| A1.2-A — W1-W5 | Done + runtime verified |
| A1.3 — Layer Map | This document |
| A1.2-B — W6-W10 | Next |
| E1 — participant wiring + observations | After A1.2-B |
| E2 — S1-S7 mock to real transport | After E1 |
| E3 — fault execution | After E2 |
| B — broader real x402 client conformance | Partial; S8 already exercises real x402 |

## 9. Non-goals

This map does not authorize:
- a new event bus;
- new /v1/argus/* endpoints;
- persistence/database work;
- dashboard/UI;
- Secretariat changes;
- x402 v2 wire-contract changes;
- target-system internal-state access;
- expanding the MVP merely to make every theoretical fault executable.

The next implementation block is deliberately narrow: **A1.2-B**, followed by **E1**.
