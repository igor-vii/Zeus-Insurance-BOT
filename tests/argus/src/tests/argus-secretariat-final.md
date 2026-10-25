# Argus ⇄ Secretariat — Final Historical Integration Report

> **Historical case study.** This report documents a specific Argus/Secretariat interoperability run. It is evidence of one SUT integration, not a statement that Secretariat is Argus's primary, default, or required SUT. Current canonical product model: Argus tests arbitrary black-box SUTs and determines the applicable counterparty scenarios from observable role/capability evidence.

**Date:** 2026-09-24 (last live run: 2026-09-24T05:48:24Z, clean database)  
**Environment:** Argus (`/workspace`, Vitest + Node) · Secretariat api-server (`/tmp/zeus`, `scripts/run-local.mjs`, `http://localhost:4021`) · PostgreSQL 15 `zeus` (migrations applied) · mode `ZEUS_SIGNER_MODE=custodial_test`  
**Machine-readable run log:** `reports/argus-secretariat-run-2026-09-24T05-48-24-391Z.json`  
**Result:** **13 PASS / 2 FAIL out of 15 matrix checks** on a clean database after three marked Zeus patches. Both FAILs are in contour B, caused by external Zeus configuration issues (F-Z1; in the fresh run the routes returned 404/503 instead of a stable 500 — see the F-Z1 clarification). Not Argus errors. All HTTP codes came from live requests, and all database rows were verified with direct SQL queries. Nothing was mocked or tuned to fit the result.

---

## 1. Integration Architecture — What the Reconnaissance Established

Secretariat acts as an intermediary between buyer and seller, with two external-agent connection contours:

| Contour | Argus role | Path | Status |
|---|---|---|---|
| **A (Stage-A non-custodial API)** | Argus = **seller** (`X402AgentServer` as `target`); Secretariat performs discovery, parses 402, checks policy, creates DPI; Argus = **buyer** signer (EIP-3009 → `POST /v1/requests/:id/payment`) | `POST /v1/requests` → discovery → 201 → signing → submit → 200 | ✅ **works end-to-end** (after 2 marked Zeus patches) |
| **B (x402 middleware on Insurance/Escrow routes)** | Argus = buyer against protected api-server POST routes | `POST /api/insurance/prepare-buy` / `/api/escrow/create` → expected 402 | ❌ **blocked by Zeus configuration defect (F-Z1)** — see §5 |

Full api-server route inventory (grep across `api-server/src`):

| Route | Ownership | x402 middleware |
|---|---|---|
| `GET /health`, `/healthz` | infrastructure | no |
| `POST /api/insurance/prepare-buy`, `POST /api/escrow/create` | Insurance / Escrow (Zeus) | **yes** (`app.ts:90 paymentMiddleware`) — both prices `$0` → 500 |
| other `/api/insurance/*`, `/api/escrow/*`, `/api/staking/*`, `/api/auth/*`, `/api/admin/*`, `GET /api/x402/info` | Insurance/Escrow/supporting | no |
| `POST /v1/requests`, `GET /v1/requests/:id`, `POST /v1/requests/:id/payment` | **Secretariat-specific (Stage-A/B API)** | **no** — Secretariat acts as x402 client to the seller here |

**Conclusion for contour B:** Secretariat routes do not use x402 middleware — only the Stage-A/B API does. Therefore the end-to-end “Argus pays for a resource” cycle is closed through contour A (Argus-seller + Argus-signer against the same Secretariat). The classic B contour can only be exercised after Zeus fixes the route prices (a Zeus-team decision; see F-Z1).

Regarding S1–S8: these are internal Argus engine scenarios running on mock transport; running them against a live HTTP SUT would be meaningless because it is a different protocol. Integration scenarios against real Secretariat are labeled A1–A6/B/W and exist as a separate set in `src/tests/integration/ArgusSecretariatRun.test.ts`. S1–S8 were not changed and continue to pass (170 unit tests green).

---

## 2. Matrix: “Argus Action → HTTP Verdict → Database Record → Interpretation”

Interpretation follows the rule “a test checks an expectation”: for negative scenarios, an intentional Argus refusal is expected behavior, and an honest recorded refusal by Secretariat is a **PASS for both systems**.

| # | Scenario | Action | HTTP | Database evidence (verified with psql) | Verdict |
|---|---|---|---|---|---|
| 1 | A1 happy-path | Secretariat performs discovery against Argus-seller (`X402AgentServer`, port 0) | **201** `AWAITING_PAYMENT_SIGNATURE` (+paymentRequired: amount=100000, asset=Base-Sepolia-USDC, network=base-sepolia, payee, deadline) | — | **PASS** |
| 2 | A1 | `GET /v1/requests/:id` before payment | **200**, status AWAITING_PAYMENT_SIGNATURE, evidenceCount=1 | — | **PASS** |
| 3 | A1 | DPI verification | — | `payment_intents`: state=`PENDING_SIGNATURE`, authorizer=`0xf39Fd6e5…`, nonce=`0x00c1a567…` | **PASS** |
| 4 | A1 | `POST /v1/requests/:id/payment` — canonical V2 JSON with Argus EIP-3009 signature | **200** `PROCESSING`, evidenceCount=3 (verifier accepted signature) | state transition + settlement attempt + evidence | **PASS** |
| 5 | A1 | `GET /v1/requests/:id` after payment | **200** `PROCESSING`; in `payment_intents`: `RECONCILING`, `error_reason='Missing paymentPayload or paymentRequirements'` | reconciliation record was NOT lost; it honestly remained in reconciliation (no Base Sepolia USDC facilitator — expected) | **PASS** |
| 6 | A2 policy-reject | Argus-seller raises price (5000000 atomic with maxPrice=100) | **422** `REQUEST_REJECTED` | POLICY_REJECTED is **not persisted** → finding F-Z6 | **PASS** (expected policy rejection) |
| 7 | A3 network-mismatch | seller announces `eip155:999`, policy permits only 84532 | **422** `REQUEST_REJECTED` | same (F-Z6) | **PASS** |
| 8 | A4 idempotency | two `POST /v1/requests` with the same requestId | **201 / 201** | exactly one `payment_intents` row | **PASS** |
| 9 | A5 tampered-signature | submit with corrupted signature | **422** INVALID_SIGNATURE | state remains intact | **PASS** |
| 10 | A5 | repeat original valid signature after tampering | **200** | accepted | **PASS** |
| 11 | A6 authorizer-mismatch | sign with Argus key when intent is bound to another authorizer | **422** AUTHORIZER_MISMATCH | — | **PASS** |
| 12 | B buyer | `POST /api/insurance/prepare-buy` (raw unpaid and signed retry) | **500** | — | **FAIL — blocked by F-Z1 (Zeus defect, outside our code)** |
| 13 | B buyer | `POST /api/escrow/create` | **500** | — | **FAIL — same** |
| 14 | W1 wire-format | conversion `signX402Payment` → canonical V2 (offline) | — | — | **PASS** |
| 15 | W2 discovery | raw `GET` to Argus-seller resource without payment | **402** + correct `payment-required` | — | **PASS** |

**System-level result:** Argus behaves correctly in all tested roles (seller returns valid x402 V2 402; signer produces signatures accepted by the real `Eip3009PaymentVerifier`; tamper/mismatch are correctly detected). Secretariat correctly evaluates the actions and records all material information in the database (DPI, nonce, authorizer, evidence, reconciliation stages), except for the two documented gaps (F-Z6 and catch-all diagnostic masking).

---

## 3. Applied Marked Zeus Patches (minimal, both commented `[ARGUS-INTEGRATION PATCH]`)

All three were present in the working copy `/tmp/zeus` (git diff: 2 files, +42/−14). They were not committed upstream in Zeus — merge decision belongs to the Zeus team.

### Patch #1 — `api-server/src/routes/requests.ts` (Zod schema for `/v1/requests`)

The core state machine reads `body.authorizer` (non-custodial mode), but the Zod schema discarded the field → `createPendingPaymentIntent()` threw an exception → every `POST /v1/requests` returned 422. Happy-path Stage-A was impossible for any external agent.

```ts
// [ARGUS-INTEGRATION PATCH #1] Stage-A non-custodial mode requires the
// authorizer address; core state-machine reads body.authorizer, but the Zod
// schema dropped it -> createPendingPaymentIntent threw and every
// /v1/requests call returned 422. Minimal fix: accept optional field.
authorizer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
```

### Patch #2 — `lib/db/src/secretariat/postgres-store.ts` (F-Z5)

Postgres `NUMERIC(38,6)` returns `"100000.000000"`, while canonical x402 V2 `accepted.amount` is the integer string `"100000"`; `eip3009-verifier` compares strings → permanent `VALUE_MISMATCH`. The client cannot normalize this because normalized data is not the same as persisted data. Canonicalization is applied at the store→verifier boundary:

```ts
// [ARGUS-INTEGRATION PATCH #2 (F-Z5)] ... value: canonNumeric(row.value)
function canonNumeric(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' ? '0' : t;
}
```

After patch #2, test #4 (payment submission) became **200** — confirmed by a live run.

### Patch #3 — `lib/db/src/secretariat/postgres-store.ts` (`append()`) (F-Z7)

Evidence append is called before the payment intent exists (discovery/policy phase), while the bridge hard-coded `paymentIntentId: ""` → foreign-key violation `reconciliation_observations_payment_intent_id_fkey` → **HTTP 500 on `POST /v1/requests` against a clean database** (the first A1 scenario failed before the DPI phase). Minimal fix: resolve the real intent by operationId and skip the observation row when the intent does not yet exist (the JSONB update below is already protected by `if (intent)`):

```ts
// [ARGUS-INTEGRATION PATCH #3 (F-Z7)] ...
const linkedIntent = await this.getPaymentIntentByOperationId(record.operationId);
if (linkedIntent) {
  await this.appendReconciliationObservation({
    paymentIntentId: linkedIntent.paymentIntentId, ...
  });
}
```

After patch #3, the full clean-database run was green (A1–A6, W1/W2), with 12 meaningful rows in `reconciliation_observations` and real foreign keys.

---

## 4. What Had to Be Done on the Argus Side (without changing the core)

Argus core (`ScenarioEngine`, `ExecutionRegistry`, `RunOrchestrator`, `X402AgentAdapter`, `PaymentAdapter`, S1–S8) was **not changed**. Only new components/tests were added:
- `src/adapters/x402/X402AgentServer.ts` — x402 V2 resource server (seller contour): 402+payment-required without signature, 200+resource with valid signature, evidence log.
- `src/tests/integration/ArgusSecretariatRun.test.ts` — A1–A6/B/W matrix against `SECRETARIAT_URL` (ENV, no hard-codes), with direct psql verification.
- Helpers for wire-format conversion (Argus base64-header form ↔ Secretariat canonical JSON form) and binding the signature to the persisted DPI (nonce/window/amount/payTo are taken from GET status, not generated again).
- Fixed a bug in our own test: amount normalization order (raw NUMERIC from discovery was overriding the bound value) + TypeScript null checks.

---

## 5. Findings (defects identified by the run)

### F-Z1 — Zeus configuration defect: $0 price breaks x402 middleware (BLOCKS contour B) ⚠️ kept as a separate item, as requested

This is insurance-policy purchase logic coupled to payment middleware. `api-server/src/config/x402.ts`:

```ts
/**
 * NOTE: API fee is DISABLED for now (price set to $0).
 * When ready to enable, change price to "$0.001" and ensure
 * ZEUS_TREASURY env var is set on Railway.
 */
export const x402Routes: RoutesConfig = {
  "/api/insurance/prepare-buy": { price: "$0", network: "eip155:196", ... },
  "/api/escrow/create":         { price: "$0", network: "eip155:196", ... },
};
```

With `ZEUS_TREASURY` set, `x402-express` validates the price with a minimum of `$0.0001` → **“Invalid price $0”** while forming the 402, so Express returns **500 instead of 402**. Clarification from the fresh run (clean restart): codes are unstable (500 → in the last run 404/503 depending on middleware/RPC-provider startup order), but the route is in any case unusable for an x402 client; the conclusion is unchanged: protected routes are closed until prices are fixed. The protected routes are unavailable to any x402 client, including a production buyer. We did not comment on or change the config (it is a functional contract owned by the other team). **Zeus recommendation:** either use `$0.001`, or do not attach `paymentMiddleware` to zero-priced routes.

### F-Z2 — Diagnostic loss: catch-all → 422 “rejected by the payment policy”

`prepareStageA` turns any internal exception into `{status:'REJECTED'}` with the same message as an honest policy rejection. The client therefore receives an indistinguishable 422 without the real cause (this is how F-Z3 and F-Z4 were masked). Recommendation: use a separate error.code / HTTP 500 for internal errors.

### F-Z3 — (closed by Patch #1) `authorizer` was dropped by the Zod schema → 100% Stage-A rejection.

### F-Z4 — Stage-A response does not contain binding fields in canonical form

`paymentRequired` in the 201 response is returned without `maxTimeoutSeconds` / canonical amount; the client is forced to read `GET /v1/requests/:id` and use the raw NUMERIC database representation. Recommendation: return the complete `accepted` object in the response.

### F-Z5 — (closed by Patch #2) NUMERIC `"100000.000000"` vs canonical `"100000"` → structurally impossible happy-path.

### F-Z6 — POLICY_REJECTED is not persisted

A2/A3 (real policy rejections) return the correct 422, but there are no rows in `payment_intents`/`audit_logs` (verified with psql). For an intermediary whose job is to “see and record,” this is an observability gap: the audit chain of “who was rejected and why” cannot be reconstructed after the fact.

### F-Z7 — (closed by Patch #3) Evidence append before intent existed violated the FK → 500 on a clean database

It appears only on the first request against an empty database (in earlier runs it was masked by residual data). Class: telemetry writes must not be able to crash the primary transaction.

### F-A1 — (Argus, informational) Network/domain mismatch

`BaseSepoliaPaymentAdapter` signs the USDC domain with chainId 84532, while live Zeus routes use `eip155:196` (X Layer). In contour A this is deliberately aligned (Argus-seller announces base-sepolia, policy permits it); for production, an X Layer signer adapter is needed.

### F-A2 — (Argus, closed in tests) Wire format

Argus sends base64(JSON) in the `PAYMENT-SIGNATURE` header, while Secretariat accepts JSON body in `payload` — a converter was added to the integration helpers; it may be worth making JSON-body mode a standard adapter mode.

---

## 6. Testbed Limitations (honest)

- Settlement does not reach terminal SUCCESS: there is no funded wallet/facilitator for Base Sepolia USDC. What was verified is that the payment was **accepted by the verifier and recorded** (PROCESSING→RECONCILING), not lost. Terminal settlement is the next level of the testbed (testnet facilitator).
- The real Zeus database is unavailable — a local copy of the project schema was used (migrations applied).
- Stage-A rate limiting is in-memory (resets on restart) — production should account for per-client limits.

## 7. Next-Step Recommendations

1. **Zeus:** fix F-Z1 (prices) → then run the full B contour (Argus-buyer against middleware) without workarounds; decide the fate of the two marked patches (#1 — required merge; #2 — either canonicalization in the store or BigInteger comparison in the verifier); add POLICY_REJECTED persistence (F-Z6) and distinguishable error codes (F-Z2).
2. **Argus:** XLayerPaymentAdapter for production (F-A1); standard JSON-body signature mode (F-A2); promote the A1–A6 matrix into S9/S10 ScenarioDefinition scenarios; connect a real facilitator to verify terminal settlement.
3. **CI:** the integration suite runs when `SECRETARIAT_URL` is set, otherwise SKIPPED — ready for a docker-compose testbed (Postgres + api-server + Argus).

---
*All HTTP status codes, req_… identifiers, nonce values, and database strings in this report were copied from the live run `argus-secretariat-run-2026-09-24T05-48-24-391Z.json` and psql queries recorded in the session logs.*