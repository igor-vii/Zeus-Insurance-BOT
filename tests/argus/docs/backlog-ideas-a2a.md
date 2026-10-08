# Argus Backlog Ideas — A2A Failure Modes

## Metadata

- Date: 2026-09-30
- Source: analysis of public A2A failure publications (Anthropic, Google DeepMind, Coinbase x402 troubleshooting, x402 GitHub issues, industry reports on multi-agent failure rates)
- Status: backlog, not roadmap
- Purpose: preserve ideas so they are not lost. None enters the current R-session or near-term blocks without a separate decision.

## Layer separation

Ideas are divided into two layers:

- **Layer 1 — protocol (direct Argus domain).** Argus tests the x402 wire: headers, payload schema, networks, statuses, discovery/resource consistency. This is what Argus can do now and can extend minimally.
- **Layer 2 — above protocol (meta-layer).** Argus tests multi-agent-system behavior: loops, injection, semantic drift. This requires infrastructure Argus does not currently have: real agents on both ends, observable LLM decisions, router layer.

---

# Layer 1 — Protocol ideas

## BL-1. Malformed x402 Payload

**What it tests:** target correctly handles a structurally invalid payment-signature / payment-payload and does not enter an invalid state.

**Motivation:** x402 GitHub issues #196 (dual-auth incompatibility), Coinbase troubleshooting (invalid_payload v1 vs v2, mixed package versions, X-PAYMENT vs PAYMENT-SIGNATURE).

**What Argus needs:**

- ability to send deliberately broken payloads (non-Base64, non-JSON, missing required fields);
- classify response: `malformed_rejected` (correct behavior), `malformed_accepted` (target problem), `unknown`;
- do not confuse this with FAILURE — it is a separate evidence class.

**Layer:** 1  
**Dependencies:** minimal — adapter extension for malformed payload construction.  
**Status:** backlog.

## BL-2. Version Mismatch (x402 v1 vs v2)

**What it tests:** target correctly rejects a request using a mismatched protocol version or correctly handles downgrade/upgrade.

**Motivation:** Coinbase troubleshooting: X-PAYMENT (v1) vs PAYMENT-SIGNATURE (v2), mixed package versions producing invalid_payload.

**What Argus needs:**

- configurable protocol version in the adapter;
- compare v1-client against v2-server and vice versa;
- classify: explicit unsupported_version / silent accept / malformed error.

**Layer:** 1  
**Dependencies:** requires version parameterization in X402AgentAdapter.  
**Status:** backlog.

## BL-3. Network Mismatch (CAIP-2)

**What it tests:** target correctly reacts when client offers a network not present in discovery, or vice versa.

**Motivation:** Coinbase troubleshooting: eip155:8453 vs eip155:84532, wrong chain, settlement fails.

**What Argus needs:**

- configurable network in payment intent;
- compare with accepts[] from 402;
- classify: network_mismatch_rejected / network_mismatch_silent / unknown.

**Layer:** 1  
**Dependencies:** minimal; already partially covered by consistency checking in R1.  
**Status:** backlog.

## BL-4. Expired Authorization Window

**What it tests:** target correctly rejects a signature with expired validBefore.

**Motivation:** Coinbase troubleshooting: authorization expired before reaching facilitator.

**What Argus needs:**

- ability to construct a signature with validBefore < now;
- classify: expired_rejected / expired_accepted (problem) / unknown.

**Layer:** 1  
**Dependencies:** requires validAfter/validBefore control in SigningBinding; currently test-only placeholder.  
**Status:** backlog.

## BL-5. Settlement Timeout Without Inference

**What it tests:** target returns an explicit status on settlement timeout rather than remaining silent.

**Motivation:** x402 settlement timeout is a valid retryable case, but nonce is single-use, so a duplicate settlement will not occur. If the target is silent, the client cannot know whether to retry.

**What Argus needs:**

- ability to send a request and observe timeout as a transport event, not an application event;
- classify: `transport_timeout` (not a semantic verdict), `settlement_unknown_from_sut` (observation), `missing_terminal_state`;
- do not derive settlement_unknown from timeout — that is inference and is prohibited by the Temporal Trust Boundary.

**Layer:** 1  
**Dependencies:** directly intersects current S6 audit (R3-D2). If R3-D2 establishes an external capability class, this idea is absorbed accordingly.  
**Status:** backlog.

---

# Layer 2 — Meta ideas

These are a separate block and are not current work.

## BL-6. Infinite Loop / Polite Disagreement Detection

**What it tests:** multi-agent system detects a dialogue-level loop and stops.

**Motivation:** Anthropic (3 agents generated malware against each other), Google DeepMind (100 agents failed within minutes), empirical failure-rate reports of 41%–86.7%.

**What Argus needs:**

- two or more live agents rather than one target;
- observable dialogue, not a single HTTP request;
- turn/token budget;
- loop detector: A→B→A with semantically equivalent payload.

**Why not now:** Argus is currently one-sided (initiator). Inbound (B6) is not yet done. Bidirectional live dialogue requires B6 + per-participant wiring + a new class of assertions.

**Layer:** 2  
**Status:** backlog, blocked by B6.

## BL-7. Router-Level Tool Call Injection

**What it tests:** router or planner does not pass through a malicious tool call injected through the LLM layer.

**Motivation:** LLM Router attack reports and tool-output injection scenarios.

**What Argus needs:**

- router as a separate participant;
- fabricated tool call in response payload;
- verify router does not forward it without validation.

**Why not now:** Argus tests the x402 wire, not LLM decisions. Router is a separate infrastructure layer that Argus does not currently have.

**Layer:** 2  
**Status:** backlog, requires a new participant class.

## BL-8. Ambiguous Contract / Coordination Failure

**What it tests:** the test explicitly defines the coordination contract (who waits, who responds, what happens on timeout), preventing failures caused by ambiguity.

**Motivation:** production failures can arise from specification/coordination issues: “Agent A should coordinate with Agent B” does not define whether A waits for B, retries on timeout, or validates output.

**What Argus needs:**

- explicit contract declaration (initiator, expected behavior, terminal state);
- verify both sides agree with the contract;
- classify: contract_satisfied / contract_ambiguous / contract_violated.

**Why not now:** this is a meta-principle, not necessarily a standalone test. It should apply across scenarios rather than become a new scenario. It may become a B4 principle for scenario semantic cleanup.

**Layer:** 2 / cross-cutting  
**Status:** backlog, candidate principle for B4.

---

# Selected for near-term consideration

Of the five Layer-1 ideas, two directly intersect current R3-D2:

- **BL-5 (Settlement Timeout)** — depends on the R3-D2 decision.
- **BL-3 (Network Mismatch)** — already partially covered by the R1 consistency checks.

The remaining Layer-1 ideas (BL-1, BL-2, BL-4) remain backlog candidates and may be considered for a future repair block.

Layer-2 ideas (BL-6, BL-7, BL-8) remain backlog and are not part of the current roadmap because they require B6/inbound capabilities or a fundamentally different participant class.

---

# Governance

## What this document is

This is an ideas backlog, not a roadmap and not a decision register.

It exists to preserve candidate work for later review.

## What it is not

Do not:

- promote ideas into the roadmap automatically;
- assign phases without a separate decision;
- duplicate these ideas into `docs/backlog-open-decisions.md`.

`docs/backlog-open-decisions.md` has a strict decision-state format (RESOLVED / DEFERRED-TO-PHASE / DECISION-REQUIRED / WONTFIX). This document intentionally uses a freer idea format.

## Review rule

When an idea becomes relevant to active work, move it into `docs/backlog-open-decisions.md` as `DECISION-REQUIRED` or `DEFERRED-TO-PHASE` before implementation.

## Current work boundary

The existence of BL-1 through BL-8 does not change the current R-session, current roadmap, or active S6/R3-D2 audit.

Current immediate work remains:

1. S6 `settlement_unknown` capability / trigger audit (R3-D2).
2. Decide the R3-D2 architecture from evidence.
3. Only then define the next repair order.
