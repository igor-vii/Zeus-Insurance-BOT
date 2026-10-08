# B4 Defect Act — Scenario Evidence & Execution Boundaries

Status: **OPEN — documentation only**  
Scope: **B4.4**  
Canonical branch: `main`

## 1. Purpose

This document records the defects, evidence gaps, and execution-boundary findings surfaced during B4 scenario inventory and block classification.

B4.4 does **not** repair runtime code, alter scenario semantics, change verdict logic, add emitters/dispatch, or expand the public API.

The purpose is to preserve the exact findings for a later, explicitly scoped decision.

## 2. Classification

| ID | Scenario | Finding type | Current disposition |
|---|---|---|---|
| B4-F1 | S3 | Lifecycle/infrastructure dispatch + missing evidence chain | OPEN |
| B4-F2 | S4 | Canonical execution/timeout evidence boundary | OPEN |
| B4-F3 | S6 | Missing canonical settlement-unknown driver / under-tested invariant | OPEN |
| B4-F4 | S7 | Responder/emission anomaly + incomplete delivery-loss evidence chain | OPEN |
| B4-D1 | S2/S4 docs | Documentation drift against current scenario implementations | DOCUMENTATION DEBT |

## 3. B4-F1 — S3 CrashAfterSettlement

### Finding

S3 declares a crash-after-settlement fault triggered by `payment_settled`, but the canonical scenario run does not currently dispatch that lifecycle trigger into the fault path.

The required post-settlement evidence chain is also incomplete: `recovery_completed` and the engine-side `forward_request` evidence required by the scenario's intended proof are not currently emitted by the canonical runtime.

### Observed boundary

The canonical run can complete without exercising the declared crash/recovery path. The resulting evidence therefore cannot establish the intended post-settlement recovery behavior.

### Classification

**Architecture/evidence boundary.**

This is not classified here as a verdict-engine defect.

### Required later decision

A future repair act must explicitly decide how lifecycle-triggered infrastructure faults are dispatched and how recovery/forwarding evidence is produced before S3 can be treated as semantically executable.

### B4 no-change rule

No lifecycle dispatcher, infrastructure interception, recovery emitter, or verdict change is introduced by B4.4.

---

## 4. B4-F2 — S4 SellerTimeout

### Finding

S4 declares an active seller-delivery hang with `duration_ms: -1`. The canonical in-process scenario therefore does not independently terminate and cannot itself establish a bounded timeout outcome.

The repository also contains harness paths using a finite copy of the fault (for example, `duration_ms: 10`). Such harness configuration must not be treated as equivalent to the canonical S4 scenario definition.

### Observed boundary

A timeout must not be converted implicitly into `DELIVERY_UNKNOWN`. The current semantics correctly avoid treating timeout alone as proof of an economic/application outcome.

S4 can become meaningful only when an explicit observation/evidence path establishes `delivery_unknown` (or another supported terminal observation) without inferring it from elapsed time alone.

### Classification

**Execution/evidence boundary.**

### Required later decision

Decide whether S4 should gain a bounded canonical execution mechanism, an explicit external lifecycle observation contract, or remain in Block C until such evidence can be produced.

### B4 no-change rule

No timeout reinterpretation, automatic UNKNOWN inference, or canonical fault mutation is introduced by B4.4.

---

## 5. B4-F3 — S6 PaymentRetry

### Finding

S6 exercises three explicit payment attempts, but its current assertion path primarily counts `payment_settled` evidence.

The intended invariant — reject a new authorization while the prior settlement state is UNKNOWN — is not established by the canonical scenario because there is no canonical `settlement_unknown` driver/observation path in the scenario.

### Observed boundary

A run can show multiple payment requests without proving the specific UNKNOWN-state invariant.

Therefore, passing or inconclusive execution of the current S6 scenario must not be interpreted as proof of the full retry-safety invariant.

### Classification

**Evidence/coverage gap.**

### Required later decision

Define the minimal canonical observation/fault contract required to place a payment attempt into an explicitly observed UNKNOWN state, then test the retry invariant against that state.

### B4 no-change rule

No new settlement state, payment behavior, retry rule, or verdict logic is added by B4.4.

---

## 6. B4-F4 — S7 LostDelivery

### Finding

S7 is correctly classified in Block B by intended topology, but its current evidence path has an implementation/anomaly boundary:

- the `respond(emit delivery_sent)` responder is associated with the payment-request event path;
- the ScenarioEngine actor context causes the observed operation to execute against `client-1`, not the intended resource-server responder context;
- the canonical probe therefore produces no `delivery_sent` evidence despite a non-empty responder lookup;
- the `lost_delivery` edge fault is declaration-only/no-op in the current scenario;
- there is no canonical `delivery_received` emitter establishing the receiving side of the intended chain.

### Observed boundary

The scenario cannot currently establish the intended lost-delivery evidence chain from canonical runtime behavior.

The topology remains Block B; this finding does not justify moving S7 to Block C.

### Classification

**Implementation/evidence anomaly.**

### Required later decision

Trace the responder/actor contract and define the minimal correction needed to produce an observable delivery-loss chain without broadening the scenario architecture.

### B4 no-change rule

No responder routing, actor selection, edge-fault implementation, delivery emitter, or verdict change is introduced by B4.4.

---

## 7. B4-D1 — Documentation drift

The existing fault-dispatch documentation contains statements about S2/S4 lifecycle-triggered declarations that no longer precisely match the post-R3 scenario implementations.

This is recorded as documentation debt only.

It must not be silently corrected as part of a runtime defect repair.

---

## 8. Evidence discipline

The following distinctions remain mandatory:

1. **Canonical scenario behavior** is separate from harness-configured observations.
2. **Timeout** is not proof of `DELIVERY_UNKNOWN`.
3. **Payment request/sign/retry evidence** is not proof of `payment_settled`.
4. **Declared fault configuration** is not proof that the fault was dispatched.
5. **Topology classification** is based on intended participant structure, not on whether the current implementation happens to emit the expected evidence.
6. **INCONCLUSIVE** means the intended proof was not established; it must not be silently promoted to PASS.

## 9. Exit condition for B4.4

B4.4 is complete when this defect act is present on canonical `main` and the four findings above are preserved as explicit, bounded follow-up items.

No runtime repair is part of B4.4.

## 10. Related B4 documents

- `docs/scenarios/b4-scenario-inventory.md`
- `docs/scenarios/b4-block-a.md`
- `docs/scenarios/b4-block-b.md`
- `docs/scenarios/b4-block-c.md`
- `docs/scenarios/README.md`
