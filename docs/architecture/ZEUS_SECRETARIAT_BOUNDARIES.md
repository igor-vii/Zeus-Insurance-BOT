# Zeus Platform Architecture Boundaries — Secretariat V0 and Future Modules

> **Status:** Canonical architectural reference
> **Created:** 2026-09-04
> **Base:** BLOCK 8 / Section 4 completion

This document records binding architectural boundaries between the existing Zeus platform and Secretariat V0.

---

## 1. Secretariat Role

Secretariat is an orchestration/execution/evidence layer. Its core owns: request identity, payment intent, settlement, reconciliation, execution obligation, execution evidence, recovery, UNKNOWN/unresolved economic states.

Secretariat core must remain independent of concrete infrastructure (PostgreSQL, Drizzle, RPC, facilitator, seller, key-management). Concrete infrastructure belongs behind interfaces/adapters.

---

## 2. Database Principle

DO NOT create one physical database per module at the current stage. Preferred model: ONE shared PostgreSQL + LOGICAL domain ownership.

```
PostgreSQL
  Secretariat: payment_intents, reconciliation_jobs, execution_attempts, recovery_jobs
  Insurance: policies, claims, coverage, payouts
  Escrow: agreements, funding, releases, refunds
  Future modules: own tables
```

Separate databases are a future scaling option only if justified by real scale/isolation/compliance requirements.

---

## 3. Domain Ownership Principle

Each module owns its DOMAIN CONTRACT and semantics. A module must not make another module's internal ORM types its permanent public API.

- Shared physical storage: acceptable
- Shared internal domain ownership: NOT acceptable

---

## 4. Persistence Boundary

Preferred shape: Domain/Core -> Repository/Port interface -> Concrete adapter -> PostgreSQL/Drizzle

Do not introduce cross-domain Drizzle coupling for convenience. Current stores may use @workspace/db as concrete implementations, but core must remain independent.

---

## 5. Database Growth / Economics

Do NOT optimize prematurely for enormous data volumes. Current data is operational/audit state (IDs, states, timestamps, hashes, tx refs, evidence metadata).

Future mechanisms: partitioning, retention, hot/cold separation, archival, external evidence storage.

Principle: Auditability is required; permanent hot storage of every raw artifact is not.

---

## 6. Money / Signing Authority Boundaries

Distinct authorities:
- Client Payment Authority: client-controlled. Secretariat MUST NOT store client private key.
- Zeus Reserve Authority: infra-controlled for reserve operations. NOT the client key.
- Insurance Reserve: ZeusReserveV2, reserve-backed payouts.
- Escrow: ZeusEscrowBOT, separate rail with own semantics.

Do not collapse into one generic wallet/signer concept.

---

## 7. Monetary Separation Status

- GREEN: Reserve-backed architecture valid for V0/pilot
- YELLOW: Future stronger treasury/key-management separation
- RED: Never treat infra signing key as client key. Never let Secretariat custodian client keys.

---

## 8. Zeus + Secretariat Coexistence

Secretariat integrates INTO existing Zeus, does not replace it. Existing insurance/reserve/escrow/API/watcher/SDK/trust systems remain valid.

Attach through explicit interfaces/adapters. Do NOT rewrite existing modules to be Secretariat-native.

---

## 9. Future-Module Rule

New modules may share PostgreSQL/infra/RPC/observability/deployment but must own their own domain semantics. Must not require changing existing domain semantics to integrate.

---

## 10. Architectural Principles

- Zeus should scale by adding domain modules, not by rewriting foundations.
- Logical ownership does not require physical database separation.
- Concrete infrastructure may be shared; domain semantics must remain explicit.
- Do not optimize for hypothetical scale at the expense of durable correctness.

---

## Current Implementation Gaps

### Gap 1: Secretariat core imports concrete Drizzle types
Some core modules import from @workspace/db directly. Compile-time only, low impact. Yellow-zone resolution.

### Gap 2: ESM/CJS package boundary friction
Workspace packages underwent ESM alignment (Steps 3-K, 3-N). Build pipeline may still have friction. Active resolution.

### Gap 3: Lockfile synchronization
pnpm-lock.yaml requires manual sync after package changes. CI should enforce consistency. Green-zone operational fix.

---

## Document Maintenance

Update when: new domain module added, fundamental decision changes, gap resolved, monetary boundaries restructured.
