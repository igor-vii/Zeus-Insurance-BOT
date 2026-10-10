# B0 — Open Decisions & Audit Backlog

**Repository:** `igor-vii/Argus-Agent-Test-Lab`  
**Canonical branch:** `main`  
**Purpose:** authoritative decision register for unresolved, deferred, and unverifiable findings across the Argus audit phases.

> **Core rule:** no finding disappears silently, and no finding is invented silently.

---

## 1. Objective

Maintain a single authoritative register of findings and decisions originating from:

- L0-S — S1–S7 semantic audit
- L0-F — fault/event contract audit
- L0-F2 — fault dispatch contract
- L0a — participant live wiring
- L0-T / B3 — topology and multi-participant runtime
- B4 — scenario semantic cleanup
- B5 — infrastructure / repository hygiene

B0 does **not** implement the unresolved architecture.

B0 establishes the audit trail and makes every known item explicit as one of:

- `RESOLVED`
- `DEFERRED-TO-PHASE`
- `WONTFIX-WITH-REASON`
- `DECISION-REQUIRED`

---

## 2. Evidence and No-Change Rule

### Evidence hierarchy

Each backlog item must identify its source type:

- **REPO** — directly verifiable in the current canonical `main`
- **REPORT** — present in a prior Qwen/agent report, but not necessarily committed to `main`
- **CONVERSATION** — stated in the project conversation / prior session, without a corresponding report or repository artifact
- **UNKNOWN** — mentioned but no reliable source can currently be located

Do not silently promote REPORT, CONVERSATION, or UNKNOWN evidence into REPO evidence.

### No-code-change rule

B0 is a research/register phase.

Do not modify:

- `src/**`
- tests
- runtime behavior
- adapters
- scenario definitions
- configuration
- `.gitignore`
- CI configuration

The only intended repository artifact of B0 is this document.

### No backlog cleanup

Do not re-classify an existing backlog item without new evidence.

If a prior item's status must change, create a separate row containing:

`REVISED-FROM: <old-status>`

and record the new evidence and rationale.

Do not silently overwrite prior decisions.

---

## 3. Backlog Schema

Every finding must be represented with the following fields:

| ID | Problem / Decision | Category | Source Type | Source | Current Status | Why Deferred / Status Rationale | Owner Phase | Decision Owner |
|---|---|---|---|---|---|---|---|---|
| B0-001 | L0-S findings cannot currently be verified from canonical main because the prior L0-S document is absent from `main`. | Audit evidence | CONVERSATION | Prior session; source document not present in repo | DECISION-REQUIRED | Do not reconstruct the four L0-S findings from memory. Original evidence is required before resolution can be verified. | B0 / evidence recovery | Architect |
| B0-002 | L0-F findings cannot currently be verified from canonical main because the prior L0-F document is absent from `main`. | Audit evidence | CONVERSATION | Prior session; source document not present in repo | DECISION-REQUIRED | Do not reconstruct L0-F findings from memory. | B0 / evidence recovery | Architect |
| B0-003 | L0-F2 fault-dispatch contract is present in canonical main, including contract documentation and tests. | Fault contract | REPO | `docs/l0-f2-fault-dispatch-contract.md`; `src/tests/core/FaultDispatchContract.test.ts` | RESOLVED | Contract implementation was merged into main. Remaining coverage gaps are tracked separately and are not silently treated as contract failures. | B1.1 | Architect |
| B0-004 | Four L0-F2 coverage gaps remain distinct from contract holes: infrastructure-target validation, lifecycle no-dispatch spy coverage, end-to-end positive fault application, and explicit S1/S5 structure assertions. | Test coverage | REPORT | Prior Qwen audit/report; not committed as a source document in main | DEFERRED-TO-PHASE | These are coverage gaps, not evidence that the frozen L0-F2 contract itself is invalid. | B1.1 | Architect |
| B0-005 | Lifecycle trigger semantics must be decided: evidence-only, separate non-recursive dispatch, or bounded recursive dispatch. | Architecture | CONVERSATION | Prior L0-F2 decision record / project discussion | DEFERRED-TO-PHASE | Current frozen state is evidence/declaration only; no recursive active-fault dispatch is implemented. | B1.2 | Architect |
| B0-006 | Edge/infrastructure fault targets, including S7 `lost_delivery`, need an explicit runtime decision. | Architecture | CONVERSATION | Prior L0-F2 discussion | DEFERRED-TO-PHASE | Current L0-F2 supports active participant/action dispatch only; edge/infrastructure targets remain declarative-only. | B1.3 | Architect |
| B0-007 | `respond` remains a separate baseline responder path rather than an active fault-dispatch path. | Type / contract boundary | REPO | L0-F2 implementation and tests | DEFERRED-TO-PHASE | Current compatibility behavior is intentionally retained; future type separation is a bounded decision. | B1.4 | Architect |
| B0-008 | Participant live wiring must be audited: participant → controller → adapter, including the current multi-participant registration behavior. | Runtime wiring | CONVERSATION | Prior L0a analysis | DEFERRED-TO-PHASE | No live wiring redesign belongs in B0. | B2 | Architect |
| B0-009 | Topology / multi-participant runtime semantics are not yet established as an execution model. | Architecture | CONVERSATION | Prior L0-T / B3 planning | DEFERRED-TO-PHASE | Current runtime is primarily actor/controller driven. B3 must determine whether explicit topology runtime is required or whether participant-aware wiring is sufficient. | B3 | Architect |
| B0-010 | S1–S7 scenario semantic cleanup and migration from mock/declarative assumptions to live semantics remain open. | Scenario semantics | CONVERSATION | Prior B4 planning | DEFERRED-TO-PHASE | B0 records the debt; it does not change scenario behavior. | B4 | Architect |
| B0-011 | Repository / CI hygiene requires investigation of generated artifacts, `.gitignore`, explicit commit paths, and related index hygiene. | Infrastructure | CONVERSATION | Prior B5 planning | DEFERRED-TO-PHASE | No infrastructure cleanup is performed by B0. | B5 | Architect |
| B0-012 | Audit documents and decisions are fragmented between repository, reports, and conversation. | Process / audit trail | REPO + CONVERSATION | Current main inspection + prior session history | DECISION-REQUIRED | The repository does not currently provide a complete historical audit trail. Future audit documents require an explicit persistence rule. | B5 / audit-process decision | Architect |
| B0-013 | PR #47 containing the first real external Sitecheck behavioral test is merged into main. The exact historical “W7” finding linkage is not independently recoverable from the current source set. | Audit traceability | REPO + CONVERSATION | PR #47; prior W7 reference | DECISION-REQUIRED | Merge is verified, but the original W7 finding document/evidence is not present in main, so the finding itself must not be declared resolved solely from the merge. | B0 / evidence recovery | Architect |

---

## 4. L0-S Evidence Rule

The prior L0-S audit document is not present in the current canonical `main`.

Therefore:

1. Record that fact explicitly.
2. Do not reconstruct the four L0-S findings from memory.
3. If the original report becomes available, re-enter each finding with its actual source.
4. Until then, each unresolved L0-S item remains `DECISION-REQUIRED`, not `RESOLVED`.
5. A prior-session statement may be recorded as `Source Type = CONVERSATION`, but it must not be represented as repository evidence.

This prevents both:

- silent loss of prior findings; and
- silent invention of findings from memory.

---

## 5. L0-F Evidence Rule

The same rule applies to L0-F.

If the original L0-F report/document is not present in canonical `main`:

- do not reconstruct its contents;
- record the absence;
- preserve only source-qualified references that can be traced to a REPORT or CONVERSATION;
- keep verification-dependent items at `DECISION-REQUIRED`.

---

## 6. L0-F2 Frozen Contract

The currently verified L0-F2 state is:

- active fault dispatch is action-triggered;
- active fault targets are participant targets;
- the participant target must equal the action actor;
- lifecycle triggers are evidence/declaration only;
- recursive active-fault dispatch is not implemented;
- edge/infrastructure targets are declarative-only;
- `respond` is handled by a separate baseline responder path.

The contract itself is represented in canonical main.

The four known coverage gaps remain separate backlog items and must not be conflated with a contract defect.

---

## 7. Lifecycle Decision — B1.2

The current state is intentionally frozen as evidence/declaration only.

Future decision options:

**A. Evidence-only**

Lifecycle events never dispatch active faults.

**B. Separate non-recursive dispatch**

Lifecycle events can trigger a bounded class of faults without recursively re-entering the event/fault loop.

**C. Bounded recursive dispatch**

Lifecycle events can participate in controlled depth-1 recursive dispatch.

B0 does not select A, B, or C.

The decision belongs to B1.2.

---

## 8. Edge / Infrastructure Targets — B1.3

Current L0-F2 behavior does not provide active edge/infrastructure interception.

Therefore S7-style delivery faults cannot be treated as live runtime behavior merely because a scenario declares an edge/infrastructure target.

B0 records the decision point only.

No edge runtime is implemented here.

---

## 9. Participant Wiring — B2

The next runtime question is:

`participant → controller → adapter`

The current scenario set has evidence of multi-participant registration behavior that requires explicit analysis before live execution is expanded.

B2 owns:

- participant-to-controller mapping;
- participant-to-adapter mapping;
- controller identity;
- whether one controller may safely serve multiple participants;
- first live participant execution.

The first live candidate remains S1 with an `HttpAgentAdapter` and local mock HTTP target.

No Sitecheck dependency is required for B2.

---

## 10. Topology — B3

Topology remains a declarative/runtime-boundary question.

Current evidence does not establish a requirement for a separate topology execution engine.

B3 must determine whether:

1. explicit topology runtime is necessary; or
2. participant-aware controller/adapter wiring is sufficient.

B0 does not decide this.

---

## 11. Scenario Semantics — B4

B4 owns semantic cleanup of S1–S7, including:

- live versus mock semantics;
- final outcome semantics;
- `INCONCLUSIVE` handling;
- participant identity;
- fault declarations versus actually executable faults;
- migration from declarative scenarios to observable runtime behavior.

B0 records these as open work and does not alter scenario semantics.

---

## 12. Audit Trail Fragmentation

The Argus audit trail currently spans multiple locations:

1. **REPO** — canonical code, tests, and committed documents;
2. **REPORT** — Qwen/agent reports that may not be committed;
3. **CONVERSATION** — architectural decisions, layer maps, audit conclusions, and prior-session findings.

This fragmentation is itself a finding.

### Future persistence rule

Any future audit document that is intended to be authoritative must be committed under `docs/` as part of the phase that produces it.

If a document is intentionally ephemeral, it must be explicitly marked **EPHEMERAL** and must not later be treated as authoritative evidence.

No future phase may silently rely on a prior conversation artifact as if it were repository evidence.

---

## 13. Infrastructure Hygiene — B5

The following remain explicitly deferred:

- generated `dist/` content and repository indexing;
- `node_modules/` indexing;
- `.gitignore` restoration / correctness;
- explicit commit-path discipline;
- CI / repository hygiene checks;
- audit-document persistence rules.

B0 does not modify these files or settings.

---

## 14. Decision Ownership

Each item must distinguish:

### Implementation decision

How an already-decided behavior is implemented.

### Architectural decision

What runtime or contract behavior should exist.

### Scope decision

Whether the behavior belongs in the current phase at all.

The default decision owner for Argus architectural and scope questions is the project architect.

Qwen/implementation agents may provide evidence and implementation proposals but do not silently change architectural or scope decisions through code.

---

## 15. Dependency Map

The current planned dependency order is:

```
B0  — authoritative evidence/backlog
 │
 ├── B5.1 — infrastructure/audit-trail research
 │
 ├── B1.1 — close L0-F2 coverage gaps
 │
 └── B1.2 — lifecycle decision
          │
          ▼
        B2 — participant live wiring
          │
          ├── B3 — topology decision
          │
          └── B4 — scenario semantic cleanup
```

B3 remains optional until B2 establishes whether explicit topology runtime is actually required.

---

## 16. Forbidden Outcomes

The following are explicitly forbidden:

- declaring an absent audit document resolved;
- reconstructing missing findings from memory;
- treating a conversation statement as repository evidence;
- silently changing backlog status;
- silently rewriting a prior decision;
- implementing lifecycle recursion during B0;
- implementing edge/infrastructure dispatch during B0;
- redesigning participant wiring during B0;
- modifying S1–S7 semantics during B0;
- treating a merged PR as proof that an undocumented historical finding was resolved;
- expanding B0 into a general architecture refactor.

---

## 17. Coverage Gaps vs Contract Holes

B0 must preserve the distinction:

**Contract hole**  
The frozen behavioral contract is wrong, incomplete, or internally inconsistent.

**Coverage gap**  
The contract is explicit, but tests do not yet prove an aspect of it.

The four L0-F2 items currently identified are coverage gaps unless new evidence demonstrates otherwise.

---

## 18. Audit Evidence Policy

For every future finding:

1. Identify the source.
2. Identify the source type.
3. Verify against canonical main where possible.
4. If verification is impossible, say so.
5. Never convert uncertainty into resolution.
6. Never convert memory into evidence.
7. Preserve prior status history when changing a status.
8. Link the item to an owner phase.

The backlog is authoritative about **status and traceability**, not a substitute for the underlying evidence.

---

## 19. Readiness Gate

B0 is complete only when all of the following are true:

- [ ] Every known finding/decision source is accounted for.
- [ ] Missing L0-S evidence is explicitly recorded.
- [ ] Missing L0-F evidence is explicitly recorded.
- [ ] L0-F2 contract state is verified against canonical main.
- [ ] L0-F2 coverage gaps are separated from contract holes.
- [ ] Lifecycle, edge/infrastructure, responder, participant wiring, topology, scenario semantics, and infrastructure items have explicit owner phases.
- [ ] Audit Trail Fragmentation is recorded.
- [ ] No finding has been silently reconstructed from memory.
- [ ] No existing status has been silently reclassified.
- [ ] `docs/backlog-open-decisions.md` exists and is readable.
- [ ] `git status --short` shows exactly one untracked or modified file: `docs/backlog-open-decisions.md`.
- [ ] `git diff --cached --stat` is empty.
- [ ] No staged changes exist in `src/`.
- [ ] No staged changes exist in `.gitignore`.
- [ ] `git ls-files | grep -E '^(dist|node_modules)/'` returns 0.
- [ ] The backlog contains all required sections: backlog table, Confirmed Resolved, Deferred, Decision Required, Wontfix, Coverage Gaps.

### Required status views

For operational use, the backlog must make it possible to identify separately:

- **Confirmed Resolved**
- **Deferred**
- **Decision Required**
- **Wontfix**
- **Coverage Gaps**

No category may be inferred only from prose.

---

## 20. Final Principle

B0 does not mean everything is solved.

It means everything currently known is accounted for, its evidence source is explicit, its status is explicit, its owner phase is explicit, and nothing important is left only in conversation memory.

A missing document is a finding.

An unverifiable resolution is not a resolution.

A coverage gap is not automatically a contract hole.

And a clean backlog is not permission to erase history.

---

# R3 CONSOLIDATION ADDENDUM — 2026-09-30

This addendum records the verified state after R3: clean harness merge with per-participant controllers, merged to canonical main as commit `fcfca681492fb13fed62bb00629d0a55a3d161c6` (PR #53).

**Important scope note:** the R-series is a repair track, not part of the final roadmap dated 2026-09-29. R1/R2/R2.5/R3 arose after A0/A1 as minimal repairs. The next R block is not pre-numbered. Do not infer that the next work item is R4 until the open architectural decisions below are resolved and the next repair block is explicitly defined.

## R3 verified outcomes

| Item | Status | Evidence / consequence |
|---|---|---|
| S2 seller-action | RESOLVED FOR R3 | resource-server-1 now performs deliver; delayed_response is attached to action_deliver; delivery_started / delivery_completed use the existing fault emit path. |
| S4 seller-action | IMPLEMENTED / INCONCLUSIVE | resource-server-1 performs deliver; canonical hang remains duration_ms: -1; finite-hang execution is tested. PASS still requires a legitimate delivery_unknown source. |
| Per-participant controller wiring | RESOLVED FOR R3 | R3-CLEANUP creates a distinct AgentController per participant. The previous shared-controller defect is not carried into main. |
| Lifecycle dispatch | UNCHANGED | No lifecycle-trigger fault dispatch was introduced. L0-F2 remains action/participant dispatch only. |
| S6 retry | BLOCKED | settlement_unknown can arrive through the Sut-observation channel, but lifecycle-trigger fault dispatch remains declared-only. |
| delay_ms: 0 falsy handling | DEFERRED | The falsy-value behavior in FaultInjector.handleDelayedResponse was identified during R3 and intentionally not absorbed into R3. |
| S5 passive unhandled_exception PASS | OPEN | Current assertion can PASS when the evidence is simply absent. Whether this is semantically acceptable remains an open decision. |
| S3.1–S3.3 | DEFERRED | R3 did not attempt to close the remaining S3 atoms. |

## R3 open decisions

### R3-D1 — delivery_unknown source

The R3 capability audit is now complete. See `docs/capability-audit-delivery-unknown.md`.

**Verified classification: C — internal-only Sut state.**

The audit established:

- Sut has the semantic notion/state of `delivery_unknown`.
- In canonical S4, that state is not exposed through an external observable interface.
- S4's `sut-1` is a hypothetical/external coordinator in the scenario model; the current harness does not provide a real external Sut endpoint for it.
- The canonical hang path emits `delivery_started`, but does not externally emit `delivery_unknown`.
- Argus therefore cannot objectively obtain the terminal `delivery_unknown` state from the current Sut boundary.
- Deriving `delivery_unknown` from timeout/absence inside Argus would be an Argus-owned temporal inference and would change the Temporal Trust Boundary. That path is explicitly rejected for this finding.

**Decision:** S4 remains **INCONCLUSIVE by design** under the current external Sut boundary. No Argus timeout inference is introduced.

A future **C→A** transition would require the Sut itself to export a terminal UNKNOWN state through an external observable/protocol interface, followed by the corresponding adapter mapping. Until that capability exists, S4 is not a broken PASS test; it is an intentionally unprovable terminal-observation case.

**Status:** the capability question previously marked `DECISION-REQUIRED` is resolved as **C / internal-only**. The remaining product/roadmap question is when, if ever, to build a real Sut contract that exports this state.

### R3-D2 — S6 retry trigger

Current evidence before this decision: S6 retry was attached to lifecycle trigger `settlement_unknown`, but L0-F2 does not dispatch lifecycle triggers.

The R3-D2 feasibility audit established:

- a direct lifecycle-trigger retry is incompatible with the frozen L0-F2 dispatch boundary;
- an action-bound retry is technically feasible;
- the existing `handleRetry()` cannot create fresh authorizations because it repeats the same operation closure and therefore reuses the same idempotency key;
- an Engine Guard would require new evidence→execution control flow and a new fresh-key retry mechanism;
- the existing scenario/action model already supports sequential actions with per-action payloads and distinct idempotency keys;
- S2/S4 provide a canonical precedent for expressing required causal structure through explicit scenario actions without lifecycle dispatch;
- no lifecycle dispatch, timeout inference, synthetic `settlement_unknown`, or EvidenceCollector-driven control flow is required for the minimal implementation.

### R3-D2 — Architectural decision

**RESOLVED — Option B, implemented as the Explicit Second Action pattern.**

Canonical semantic shape:

```
attempt 1
  client-1: request_payment
  idempotencyKey = K1
        ↓
Sut positively reports settlement_unknown
        ↓
attempt 2
  client-1: request_payment
  idempotencyKey = K2
        ↓
Sut may again report settlement_unknown
        ↓
attempt 3
  client-1: request_payment
  idempotencyKey = K3
```

The implementation shall use the existing sequential `Scenario.actions` model and distinct per-action idempotency keys.

**The following are explicitly NOT authorized as part of R3-D2 implementation:**

- lifecycle observation → FaultInjector dispatch;
- generic EvidenceCollector → execution control flow;
- timeout/absence → `settlement_unknown` inference;
- synthetic `settlement_unknown` evidence;
- modification of L0-F2 dispatch rules;
- modification of `AgentController` retry behavior;
- a new retry/authorization subsystem;
- engine-level evidence guards.

### Why this decision

The explicit-second-action pattern requires the smallest architectural change:

- ScenarioEngine already executes actions sequentially.
- Action payloads already carry idempotency keys.
- A distinct idempotency key already creates a distinct payment intent in the current adapter.
- S2/S4 already establish explicit multi-action scenario structure as the canonical way to express this kind of sequence.
- Core execution, fault dispatch, evidence collection, validation, and controller behavior remain unchanged.

The Engine Guard alternative remains architecturally possible, but is **not selected for R3-D2** because it would introduce the first evidence→execution interpretation path into the engine and would still require a separate fresh-authorization mechanism.

### Important semantic limitation

The explicit-second-action pattern expresses the intended causal sequence **declaratively through scenario structure**. It does not introduce a generic runtime guard proving that attempt N+1 was dynamically authorized only after a positive `settlement_unknown` observation.

That stronger runtime conditional-execution capability is **not part of R3-D2**.

If future Argus requirements establish a need for general runtime evidence-conditioned execution, that must be opened as a separate architectural decision rather than smuggled into S6.

### R3-D2 implementation boundary

The expected implementation footprint is intentionally narrow:

**Expected source change:**
- `src/scenarios/S6_PaymentRetry.ts`

**Expected test adjustments, only where existing S6 shape assertions require them:**
- relevant S6 scaffolding tests;
- the existing S6 containment/regression test that asserts the old declared-only lifecycle trigger shape.

**Must remain unchanged:**
- `src/core/ScenarioEngine.ts`
- `src/core/FaultInjector.ts`
- `src/core/Fault.ts`
- `src/core/EvidenceCollector.ts`
- `src/core/AgentController.ts`
- `src/core/validateScenario.ts`
- lifecycle observation allow-lists
- L0-F2 dispatch contract
- other S1–S7 semantics outside the S6 change

The exact implementation must still be validated against the current canonical source before coding.

### R3-D2 status

**RESOLVED — architectural decision.**

Implementation is a separate scoped task and is not implied by this decision record.

### R3-D3 — S5 passive PASS

Current evidence: assert_no_unhandled_errors passes when no unhandled_exception evidence exists.

The question is whether absence of an error observation is sufficient for PASS, or whether S5 requires a positive observation/closure condition.

No option is selected by this addendum.

## R3 backlog findings

| ID | Finding | Status | Owner |
|---|---|---|---|
| R3-001 | delay_ms: 0 is treated as falsy by the existing delayed-response handling and therefore does not represent an explicit zero-delay value. | DEFERRED-TO-PHASE | Next repair block / separate bug fix |
| R3-002 | Canonical S4 lacks a legitimate runtime source for delivery_unknown; finite-hang execution alone does not establish the terminal observation. | DECISION-REQUIRED | Architect |
| R3-003 | S6 retry cannot execute under the frozen L0-F2 contract while its trigger remains lifecycle settlement_unknown. | REVISED — RESOLVED BY R3-D2 | Architect |
| R3-004 | S5 unhandled_exception assertion has a passive-absence PASS condition whose semantic validity is not yet decided. | DECISION-REQUIRED | Architect |
| R3-005 | R3 per-participant controller identity is corrected and verified in the merged R3 implementation. | RESOLVED | — |
| R3-006 | S3.1–S3.3 remain outside R3 scope. | DEFERRED-TO-PHASE | Next repair block / roadmap owner |

## Relationship to the 2026-09-29 roadmap

The final roadmap remains:

**B1.2a → B1.2b → B1.3 → B2 → B4 → B6 → B7**

The R-series must not silently replace or reorder that roadmap.

R-series work is a repair track created after A0/A1 to close concrete gaps with the minimum necessary change. Each subsequent R block must be explicitly defined from verified findings; its number and scope must not be assumed in advance.

## Next-step gate

R3-D1 and R3-D2 are now resolved.

Before defining the next R repair block:

1. Decide R3-D3: S5 passive PASS semantics.
2. Define the scoped R3-D2 implementation task.
3. Implement and test R3-D2 separately from this decision record.
4. Only then define any subsequent R repair block from verified remaining findings.

**No implementation of delivery-unknown inference, lifecycle dispatch, edge mediation, or S6 runtime evidence guards is authorized by this addendum.**

## Real-adapter strategic direction

The transition from mock-backed execution toward **real external adapters** remains a major objective of the Argus redesign, but it is **not automatically assigned the next R number**.

When that work is scheduled, the preferred proof shape is:

Argus → real TargetAdapter → real external system → externally observable evidence → Assertion → Verdict

The first real-adapter slice should be one narrow vertical proof. It must not become a mass replacement of MockTargetAdapter, a new transport subsystem, a dashboard, persistence layer, chaos engine, billing system, or new x402 behavior.

---

# R3 CONSOLIDATION ADDENDUM — 2026-09-30

This addendum records the canonical-main state after the R3 repair track. It does not rewrite the historical B0 entries above.

## R3-D1 — delivery_unknown

**Status: RESOLVED — classification C (internal-only Sut state).**

The S4 Sut (`sut-1`) is an EXTERNAL FACILITATOR with no externally observable endpoint in the current harness. Argus has no objective external evidence channel from which it can obtain a terminal `delivery_unknown` observation. The state may exist as Sut knowledge, but deriving it from timeout or absence would violate the Temporal Trust Boundary.

Future transition C → A requires the Sut to export a terminal UNKNOWN state through an external observable/protocol interface; the TargetAdapter may then map that observation into Argus evidence.

## R3-D2 — S6 payment retry

**Status: RESOLVED — Option B, explicit sequential payment actions.**

The canonical S6 implementation uses exactly **3 total attempts**:

- `key-6`
- `key-6-retry-1`
- `key-6-retry-2`

`faults: []`; no lifecycle-trigger dispatch was introduced. `settlement_unknown` remains an observation term rather than a runtime fault-dispatch trigger. This preserves the frozen L0-F2 contract.

## R3-D3 — S5 passive PASS

**Status: RESOLVED.**

`assert_no_unhandled_errors` no longer treats absence of `unhandled_exception` as sufficient evidence. It requires the positive base of exactly one `payment_intent_created`; otherwise the assertion remains INCONCLUSIVE. An observed unhandled exception remains FAIL.

## R3 deferred items

- **R3-001 `delay_ms: 0`** — DEFERRED-TO-PHASE.
- **R3-006 S3.1–S3.3** — DEFERRED-TO-PHASE.

## R3 closure

R3-D1, R3-D2 and R3-D3 are resolved in canonical `main`. L0-F2 and per-participant controller identity remain intact. No R4 is created by this addendum. The approved roadmap remains:

**B1.2a → B1.2b → B1.3 → B2 → B4 → B6 → B7**.

This addendum is the authoritative canonical-main record for the R3 repair-track decisions and supersedes the earlier unresolved wording only for the R3 items explicitly named above; historical B0 entries remain preserved as audit history.

# B1.3 — Edge / Infrastructure Fault Boundary — 2026-09-30

## Status

**RESOLVED — declared-only boundary; no active edge/infrastructure dispatch in the current Argus runtime.**

B1.3 closes the decision recorded as B0-006 without introducing a new runtime subsystem.

## Canonical decision

1. L0-F2 remains the active dispatch contract:
   - active fault dispatch is limited to `action_<type>` triggers;
   - active fault targets are participant targets;
   - edge and infrastructure targets are not active dispatch targets.
2. S7 `lost_delivery` therefore remains a declared scenario condition, not an executable edge fault in the current runtime.
3. Argus must not infer `delivery_unknown` merely from absence, timeout, or a missing response.
4. An edge/infrastructure fault becomes executable only when Argus has an actual observable boundary on which the fault can be applied and from which the resulting evidence can be collected.
5. No edge proxy, network interception layer, infrastructure fault engine, recursive dispatch, or new event bus is introduced by B1.3.

## Verification already present in canonical main

The frozen L0-F2 contract and tests explicitly cover this boundary:

- active edge targets are rejected by validation;
- active infrastructure targets are rejected by validation;
- S7 remains valid as a declaration because its `lost_delivery` edge fault is not an active dispatch target;
- lifecycle/event triggers remain evidence-only.

This is a **capability boundary**, not a missing implementation to be filled speculatively.

## Consequence for later work

The first executable edge/lost-delivery proof belongs to the future external/reference-seller contour, where there is a real observable HTTP boundary.

That work is intentionally deferred to the later roadmap stage where the seller scenario is designed and the scenarios are split into:

- Block A — direct end-to-end;
- Block B — intermediary/facilitator paths;
- Block C — abnormal/problem paths such as S3/S7-style divergence.

B1.3 therefore closes the decision without creating another repair stage or expanding the runtime prematurely.


# B6-B CLOSURE — 2026-10-01

## Status

**CLOSED — all B6-B repair gates verified on canonical main.**

B6-B is closed as a technical verification block. No new runtime architecture, payer/session mechanism, lifecycle dispatch, or public API is introduced by this closure.

## Verified canonical state

**Canonical HEAD:** `ec2eb757706501b45cc78b2ed707497837b74104`

Commit:

`fix(b6-b-r4): complete F2 timeout evidence with payment_accepted before timeout`

## Verification gates

| Gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck`, exit 0 |
| Full regression | PASS | 24 test files, 237/237 tests |
| B6-B suite | PASS | 13/13 tests |
| F2 error-after-payment | PASS | `DELIVERY_UNKNOWN` with payment acceptance observed before seller error |
| F2 no-response | PASS | `payment_signature_submitted → payment_accepted → timeout_no_response` |
| F2 no-response verdict | PASS | `DELIVERY_UNKNOWN` |
| R4 signer/from mismatch | PASS | HTTP 402 |
| R5 wrong recipient | PASS | HTTP 402 |
| Valid payment | PASS | HTTP 200 / delivery proven |
| Expired authorization | PASS | HTTP 402 |
| Not-yet-valid authorization | PASS | HTTP 402 |
| Repository integrity | PASS | HEAD unchanged after verification; worktree clean |

## F2 no-response semantic closure

The timeout path now records `payment_accepted` only when the real upstream seller acceptance callback reports `true`.

The independent counter-check without the callback produced:

```
payment_signature_submitted → timeout_no_response
Verdict: UNKNOWN
```

Therefore timeout, signature presence, and the timeout flag alone do not establish payment acceptance.

`computeB6BVerdict()` remains unchanged. The existing rule requiring both payment acceptance and timeout for `DELIVERY_UNKNOWN` is preserved.

## Scope boundary

B6-B closure does **not** authorize:

- a payer/session identity subsystem;
- expected-payer architecture;
- lifecycle-trigger dispatch;
- evidence-driven execution control flow;
- timeout-based payment or delivery inference;
- changes to L0-F2 dispatch semantics;
- public Argus API expansion;
- persistence, dashboard, chaos engine, or billing work;
- a new R-series repair block.

The earlier R4 identity question remains resolved by the existing cryptographic signer/from mismatch test: a signature made by signer A while declaring authorization.from = B is rejected by the real seller boundary. No hypothetical expected payer is introduced.

## Process note

The independent verification used a temporary forensic scratch test which was created and removed during testing. It was not committed and the final worktree was clean. This is recorded as a process note only and does not alter the technical closure result.

## Closure decision

B6-B repair findings are closed against the verified canonical state above.

The next work item must be selected from the approved roadmap or from a newly verified finding. B6-B closure does not itself create or imply an R4 block.

**B6-B: CLOSED.**


# B4 READINESS / CLOSURE AUDIT — 2026-10-01

## Status

**B4 remains OPEN. B7 is gated.**

Canonical main was audited after B6-B closure. The detailed audit is committed at:

`docs/b4-readiness-audit-2026-10-01.md`

### Remaining B4 semantic gaps

- **B4-F1 / S3:** crash/recovery evidence is not executable under the current L0-F2 boundary; `recovery_completed` and post-recovery `forward_request` are absent.
- **B4-F2 / S4:** canonical seller hang remains non-terminal; `delivery_unknown` is not supplied by the canonical Sut, and timeout/absence must not be converted into UNKNOWN.
- **B4-F3 / S6:** explicit retry actions respect L0-F2, but the stated UNKNOWN-settlement rejection invariant is not proven because no canonical `settlement_unknown` observation drives the rejection path.
- **B4-F4 / S7:** `lost_delivery` remains declared-only in Mock V0; there is no edge mediator establishing seller-sent versus Sut-not-received.

### Resolved B4 sub-findings

R3 already resolved participant identity, executable seller actions for S2/S4, S5 passive-PASS semantics, and lifecycle-triggered S6 retry dispatch.

These resolutions do not close B4 as a whole.

### Decision

Do not define or implement B7 yet.

B4 must first receive an explicit closure decision: either close each remaining item through separately authorized, evidence-backed work, or classify the item as deferred with its semantic limitation recorded. No PASS may be manufactured from missing evidence.

