# Argus Product Boundary

**Status: CANONICAL**

## Product identity

Argus is an independent black-box testing product for external agents, agent systems, protocols, and economic workflows.

Argus is **not** a test harness built specifically for Zeus Secretariat.

Secretariat is one possible system under test (SUT), alongside any other external client, resource server, payment service, agent application, or protocol endpoint.

## SUT role model

Argus must not assume the SUT role from product identity, repository name, adapter name, or historical integration context.

The canonical flow is:

```
Opaque SUT
   ↓
Observable discovery / probing
   ↓
Role + capability classification
   ├── CLIENT / BUYER
   │      ↓
   │   Argus exercises the resource-server / seller side
   │
   └── RESOURCE_SERVER / SELLER
          ↓
      Argus exercises the client / buyer side
   ↓
Evidence → Assertions → Verdict
```

If observable evidence does not establish a unique role, Argus must return **UNKNOWN / AMBIGUOUS** rather than guess.

## Opposite-side principle

The SUT is the party being tested.

Argus supplies the counterparty behavior required to exercise the relevant scenarios:

| Observable SUT role | Argus counterparty |
|---|---|
| CLIENT / BUYER | RESOURCE_SERVER / SELLER |
| RESOURCE_SERVER / SELLER | CLIENT / BUYER |

This is the product-level rule. It is not Secretariat-specific.

## Historical Secretariat integration

The Argus × Secretariat work remains valid as an interoperability case study and as real evidence that Argus can exercise both sides of an x402 interaction in a controlled integration.

Historical documents may therefore contain Secretariat-specific terminology, routes, findings, and role assignments.

Those historical references must **not** be interpreted as:

- Secretariat being Argus's default SUT;
- Argus existing primarily to test Secretariat;
- Argus requiring Secretariat to operate;
- a reason to hard-code Secretariat into the testing architecture.

When a historical document conflicts with this product boundary, this document and the current implementation take precedence.

## Documentation rule

New documentation must describe Secretariat as **one SUT / case study** unless the document is explicitly about the Argus × Secretariat integration.

Avoid formulations such as:

- "Secretariat is the target of Argus";
- "Argus is the tester for Secretariat";
- "the Argus target is Secretariat".

Prefer:

- "Secretariat is one SUT tested by Argus";
- "Argus can test an external resource server such as Secretariat";
- "the SUT role is discovered from observable behavior".

## Engineering consequence

Future audits must begin from this product boundary.

Do not introduce architecture, scenarios, adapters, or assertions solely because they would make Argus better at testing Secretariat.

A capability is justified when it improves Argus's ability to test a class of external SUTs.

