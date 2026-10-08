# Argus Agent Test Lab — integration into the Secretariat clean external-client test

Repository added to the sandbox: **https://github.com/igor-vii/Argus-Agent-Test-Lab**
Working copy location: `tests/argus/` (clone at HEAD, `--depth 1`, taken 2026-10-08).

## Role of Argus in this experiment

Per the task spec (§2, §12), Argus plays two roles simultaneously:

1. **Scenario driver / harness** — Argus owns the canonical scenario engine
   (`src/core/RunOrchestrator`, `ScenarioEngine`, `FaultInjector`,
   `AssertionEngine`, `EvidenceCollector`) and its registered scenario set
   **S1–S9** (`src/cli/ScenarioRegistry.ts`). All Argus scenarios are run
   against the Secretariat sandbox boundary (clients → `/v1/requests` →
   Controlled Resource Server), not against production.
2. **Counterparty adapter library** — the client-side drivers used for
   ClawRouter / Franklin / BlockRun reuse Argus adapters
   (`HttpAgentAdapter`, `X402AgentAdapter`, `X402SellerAdapter`, payment
   adapters) so that every client speaks the same observable protocol.

The Controlled Resource Server modes required by the task
(`HAPPY / TIMEOUT / RESPONSE_LOST / EXEC_FAILURE / RETRY / IDEMPOTENT`)
map onto Argus fault primitives (`hang`, `delayed_response`,
`duplicate_request`, `concurrent_request`, lost-delivery) already present
in `src/core/Fault.ts` / `FaultInjector.ts`.

## Pre-flight verification performed inside the sandbox (2026-10-08)

### A. Argus own unit/integration suite (mock transport, no external SUT)

```
cd tests/argus && npm install --no-audit --no-fund   # 109 packages
npx vitest run
→ Test Files 25 passed (25) | Tests 243 passed (243) | Duration 20.17s
```

### B. Full Argus CLI scenario matrix (canonical S1–S9, mock target)

Runner: `tests/secretariat-sandbox/drivers/run-argus-matrix.sh`
Raw logs: `S1.log … S9.log`, summary: `matrix.txt` (this directory).

| Scenario | Exit | Verdict | Reason (from raw log) |
|---|---|---|---|
| S1 DuplicateRequest      | 0 | PASS          | — |
| S2 PaymentBeforeExecution| 0 | INCONCLUSIVE  | payment_settled not observed yet |
| S3 CrashAfterSettlement  | 0 | INCONCLUSIVE  | no settlement observed yet |
| S4 SellerTimeout         | 0 | (no verdict — non-terminating hang killed by 120s timeout; empty log) | matches B4 inventory "canonical infinite hang is non-terminating" |
| S5 ConcurrentDuplicate   | 0 | PASS          | — |
| S6 PaymentRetry          | 0 | INCONCLUSIVE  | no settlement observed yet |
| S7 LostDelivery          | 0 | INCONCLUSIVE  | seller has not sent response yet |
| S8 X402Payment           | 1 | FAIL          | payment not signed and retried (mock transport, no real payment path) |
| S9 X402Seller            | 0 | PASS          | inbound self-check with public hardhat test key (no funds, local signing only) |

Notes:
- These verdicts reproduce Argus's own documented B4 readiness state
  (`docs/scenarios/b4-scenario-inventory.md`) — i.e., the clone is intact
  and functional in this environment. They are **harness pre-flight
  evidence**, NOT Secretariat results.
- Per task §0 and §24, old results from `evidence/secretariat-driver-results.json`
  and Argus's historical `argus-secretariat-final.md` report are explicitly
  NOT reused as new-test results.
- No Argus core files were modified. Only env-driven execution
  (`ARGUS_TARGET_KIND=mock` default; `ARGUS_TEST_WALLET_PRIVATE_KEY` =
  publicly known Hardhat account #0 test key with zero funds).

## Next stage (pending)

Wire the three external clients (ClawRouter, Franklin, BlockRun) through
Secretariat `POST /v1/requests` against the isolated test DB + Controlled
Resource Server, then replay the Argus S1–S9 fault semantics as the task's
S0–S5 matrix, capturing per-run evidence per task §7–§17.
