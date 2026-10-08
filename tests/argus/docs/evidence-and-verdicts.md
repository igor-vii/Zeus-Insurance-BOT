# Evidence and Verdicts

Argus treats evidence as a first-class part of a test result.

## Evidence

Evidence represents an observable event or fact established during a run. Examples include an outbound request, an HTTP response, an externally observable payment event, a receipt, or a delivery observation.

The intended boundary is:

> **Collect what can be established from the target boundary; do not infer hidden state without evidence.**

## Assertions

Assertions define what the test is trying to establish. An assertion should be evaluated against the evidence available for that run.

## Verdicts

Argus uses evidence-backed outcome categories. In particular, an unresolved state is valid when the available evidence is insufficient to prove either success or failure.

Conceptually:

```
PROVEN_SUCCESS
PROVEN_FAILURE
UNRESOLVED
```

The exact verdict vocabulary may evolve with the implementation. The invariant is that the report should not claim more certainty than the evidence supports.

## Why this matters for agent systems

Consider a payment that is observed as settled followed by a missing seller response. Treating the missing response as automatic failure can be incorrect: execution may have occurred even though delivery was not observed.

A useful test report therefore preserves the distinction between:

- what happened;
- what was observed;
- what was not observed;
- what the assertions establish;
- what remains unresolved.

This evidence discipline is central to Argus.
