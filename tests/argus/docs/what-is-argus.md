# What is Argus?

Argus is an AI agent testing and reliability laboratory for controlled failure scenarios.

It is designed to answer a practical question:

> **Does an agent-based system remain correct when the world does not behave as expected?**

Argus runs configured counterparty behavior against a black-box system under test (SUT), observes what can be established at the target boundary, evaluates explicit assertions, and records the resulting evidence and verdict.

## The model

```
SUT → Role / Capability Discovery → Scenario → Counterparty → Evidence → Verdict
```

### SUT

The external system being tested. Argus does not assume its implementation, database, internal state, or product identity.

### Role / capability discovery

Argus establishes, from observable protocol and economic behavior, which participant role(s) the SUT exposes. If the evidence does not establish a unique role, Argus must report **UNKNOWN / AMBIGUOUS** rather than infer one.

### Scenario

A reproducible test definition describing the interaction and the conditions under which the SUT should be exercised. The scenario is selected according to the SUT's observable role and capability, with Argus supplying the opposite-side counterparty behavior.

### Counterparty

Argus supplies the behavior required to test the SUT. For a client/buyer SUT, Argus can act as the resource-server/seller side. For a resource-server/seller SUT, Argus can act as the client/buyer side. This is a product capability, not a Secretariat-specific integration rule.

### Evidence

Observable facts collected during the run: requests, responses, payment observations, receipts, timing, and other externally visible events supported by the target boundary.

### Verdict

The result of evaluating explicit assertions against the collected evidence. Argus distinguishes proven outcomes from states that remain unresolved because an expected observation is missing.

## What makes the testing model different

Traditional API tests often verify that an expected request produces an expected response. Argus is intended for systems where correctness depends on a sequence of participants, payments, execution, delivery, retries, and recovery.

Examples include:

- a payment settles but the delivery response disappears;
- a client retries after an uncertain outcome;
- the same request arrives twice;
- a seller crashes after an externally observable settlement;
- a timeout occurs without enough evidence to classify the operation as failed.

The purpose is not to create random chaos. The purpose is to create **controlled, observable, and reproducible failure conditions** that exercise specific system invariants.

## Secretariat as a case study

Zeus Secretariat is one concrete SUT used in Argus interoperability work. That integration is a case study, not the architectural target or a product dependency. The same testing model must remain applicable to unrelated external clients, resource servers, payment systems, agent applications, and protocols.

## Current scope

Argus is an independent black-box testing product. Its SUT role is determined from observable behavior rather than from a hard-coded product identity.

Argus is currently an engineering-stage project. Public examples and test reports describe what has actually been implemented or observed; future capabilities are identified as future work rather than current product claims.
