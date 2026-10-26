# UNVERIFIED ASSUMPTIONS — RECONCILIATION PROTOCOL V0.1

**Date:** 26.08.2026
**Status:** Implementation complete, experimental validation pending

---

## Classification Legend

- **FACT** — Verified by specification, standard, or direct observation
- **IMPLEMENTATION ASSUMPTION** — Assumed true based on documentation, not experimentally verified
- **EXPERIMENTAL UNKNOWN** — Must be validated by Base Sepolia experiments before production

---

## Facilitator Behavior

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| F1 | Facilitator broadcasts transaction before returning HTTP response | EXPERIMENTAL UNKNOWN | Spec §5 assumes this; must verify with Experiment 3 |
| F2 | Facilitator is idempotent for duplicate /settle with same nonce | EXPERIMENTAL UNKNOWN | Must verify with Experiment 2 |
| F3 | Facilitator returns txHash in successful response | IMPLEMENTATION ASSUMPTION | Coinbase CDP docs suggest this; format may vary |
| F4 | Facilitator HTTP 500 means tx may or may not have been broadcast | EXPERIMENTAL UNKNOWN | Must verify with Experiment 3 |
| F5 | Facilitator timeout means tx may or may not have been broadcast | EXPERIMENTAL UNKNOWN | Must verify with Experiment 3 |
| F6 | Facilitator rejection (4xx) means tx was NOT broadcast | EXPERIMENTAL UNKNOWN | Spec §5 says blockchain has priority; must verify |

## RPC Consistency

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| R1 | Two different underlying providers (Alchemy, Infura) provide independent observations | IMPLEMENTATION ASSUMPTION | Both use separate infrastructure but may share upstream nodes |
| R2 | eth_call for authorizationState returns consistent results across providers within same block | IMPLEMENTATION ASSUMPTION | Standard EVM behavior; must verify with Experiment 4 |
| R3 | eth_getTransactionReceipt returns null for pending transactions | FACT | Ethereum JSON-RPC specification |
| R4 | eth_getLogs returns AuthorizationUsed events reliably | IMPLEMENTATION ASSUMPTION | Depends on node indexing; archive nodes recommended |
| R5 | RPC providers do not return stale data for 'latest' block | IMPLEMENTATION ASSUMPTION | Most providers serve from tip; must verify staleness |
| R6 | Two RPCs will agree on authorizationState after validBefore expiry | EXPERIMENTAL UNKNOWN | Must verify with Experiment 4 |

## Finality

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| C1 | 12 confirmations on Base is sufficient for economic finality | IMPLEMENTATION ASSUMPTION | Base uses OP Stack; typical finality ~2min; 12 blocks conservative |
| C2 | Reorg depth > 6 blocks on Base is an INCIDENT requiring manual review | IMPLEMENTATION ASSUMPTION | OP Stack reorgs are rare; threshold is conservative |
| C3 | receipt.status == 1 means transaction succeeded and state changes are permanent (after finality) | FACT | Ethereum Yellow Paper |
| C4 | receipt.status == 0 means no state changes occurred | FACT | Ethereum Yellow Paper |

## Duplicate /settle

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| D1 | Submitting same EIP-3009 authorization twice does not double-charge | IMPLEMENTATION ASSUMPTION | EIP-3009 nonce mechanism should prevent this; must verify with Experiment 2 |
| D2 | Facilitator handles duplicate /settle gracefully (returns same result or error) | EXPERIMENTAL UNKNOWN | Must verify with Experiment 2 |

## Provider Independence

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| P1 | Alchemy and Infura use independent upstream infrastructure | IMPLEMENTATION ASSUMPTION | Both are major providers; likely independent but not guaranteed |
| P2 | Two endpoints of the same provider do NOT count as independent | FACT | Spec §15 explicitly states this |
| P3 | Adding a third provider (Ankr) increases independence confidence | IMPLEMENTATION ASSUMPTION | Ankr uses aggregated sources; may overlap with others |

## EIP-3009 Behavior

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| E1 | authorizationState(address, bytes32) returns true after successful ReceiveWithAuthorization | IMPLEMENTATION ASSUMPTION | EIP-3009 spec; must verify on Base Sepolia USDC |
| E2 | authorizationState returns false for unused authorization after validBefore | EXPERIMENTAL UNKNOWN | Must verify with Experiment 4 |
| E3 | AuthorizationUsed(address, bytes32) event is emitted on successful authorization use | IMPLEMENTATION ASSUMPTION | EIP-3009 spec; must verify event signature on actual contract |
| E4 | USDC on Base Sepolia implements EIP-3009 | IMPLEMENTATION ASSUMPTION | Circle docs confirm; must verify contract address and interface |
| E5 | Transfer event in same transaction as AuthorizationUsed proves value movement | FACT | ERC-20 standard + EIP-3009 composition |

## Reorg Behavior

| # | Assumption | Classification | Evidence |
|---|-----------|----------------|----------|
| G1 | After N confirmations, transaction is effectively final on Base | IMPLEMENTATION ASSUMPTION | OP Stack challenge window is 7 days; L1 finality differs |
| G2 | A reorg that unconfirms a SETTLED transaction is an INCIDENT | FACT | Spec §24 explicitly defines this |
| G3 | SETTLED → NOT_SETTLED auto-reversal is forbidden after terminal evidence | FACT | Spec §24 explicitly forbids this |

---

## Priority for Experimental Validation

### Must validate before production (Phase 1 experiments):
1. **F1, F4, F5** — Facilitator broadcast timing (Experiment 3)
2. **F2, D1, D2** — Duplicate settle behavior (Experiment 2)
3. **E1, E2, E3, E4** — EIP-3009 on Base Sepolia (Experiments 1 + 4)
4. **R6** — RPC agreement after expiry (Experiment 4)

### Should validate before production (Phase 2 experiments):
5. **C1, C2** — Finality thresholds (monitor over time)
6. **R1, P1** — Provider independence (compare observations over time)
7. **G1** — Reorg frequency on Base (monitor over time)

---

## What Is FACT (No Experiment Needed)

- R3: eth_getTransactionReceipt returns null for pending txs (JSON-RPC spec)
- C3: receipt.status == 1 means success (Yellow Paper)
- C4: receipt.status == 0 means no state changes (Yellow Paper)
- P2: Same provider endpoints are not independent (Spec §15)
- E5: Transfer in same tx proves value movement (ERC-20 + EIP-3009)
- G2: Reorg unconfirming SETTLED is INCIDENT (Spec §24)
- G3: No auto SETTLED→NOT_SETTLED reversal (Spec §24)

---

## EIP-3009 Domain & Facilitator Wire (F-112/F-113, external audit 2026-10-26)

| # | Assumption | Classification | Evidence / Required verification |
|---|-----------|----------------|----------------------------------|
| D1 | USDC on X Layer (0x74b7F16337b8972027F6196A17a631aC6dE26d22) exposes EIP-712 domain name "USD Coin" and version "2" (Circle-canonical FiatToken) | FACT — VERIFIED ON-CHAIN 2026-10-26 | eth_call via public OKX RPC (xlayerrpc.okx.com, eth_chainId=0xc4=196): `name()`="USD Coin", `version()`="2", `symbol()`="USDC", `decimals()`=6; **DOMAIN_SEPARATOR() = 0xb1671065a2ea487729c4ff0e2f8beb2105e3ce63315ad07483374a3476b83972** exactly equals keccak256(abi.encode(EIP712Domain-typehash 0x8b73c3c6…39400f, keccak("USD Coin"), keccak("2"), 196, token)) — cryptographic proof that signatures produced with the pinned domain are the ones the token's transferWithAuthorization enforces. Native USDC + CCTP launched on X Layer 2026-08-07 (Circle announcement). Deploy values: ZEUS_EIP3009_DOMAIN_NAME="USD Coin", ZEUS_EIP3009_DOMAIN_VERSION="2" |
| D2 | The Zeus-operated facilitator implements the canonical x402 v2 remote-facilitator contract: POST /settle {x402Version, paymentPayload, paymentRequirements} → {success, transaction, errorReason?} | IMPLEMENTATION ASSUMPTION → the Zeus facilitator NOW EXISTS (2026-10-26, `zeus-facilitator` package): canonical v2 /verify + /settle enforced by its own hermetic suites (40 tests) + CI build; the wire shape it consumes is byte-identical to the F-112 client envelope. REMAINING: exercise the deployed service against the real X Layer rail (staging settle with a funded test wallet) before mainnet — no live-rail transaction has been made yet |
| D3 | Facilitator HTTP 4xx (except 408/409/429) means the payload is definitively refused and nothing was broadcast | IMPLEMENTATION ASSUMPTION | Spec §6 "blockchain has priority"; D-3 of this table; the client now returns REJECTED for these — verify against the real rail in Experiment 3 |
| D4 | Facilitator 200 + success:false means nothing was broadcast (settlement failed pre-flight) | IMPLEMENTATION ASSUMPTION | errorReason taxonomy (e.g. insufficient_funds) is pre-broadcast; a post-broadcast failure would surface as 5xx/timeout → RECONCILING — must be exercised against the real rail |
| D5 | A FREE external facilitator can serve eip155:196 (making the Zeus-operated one optional for mainnet) | DISMISSED WITH EVIDENCE for "free"; thirdweb documented as PAID fallback | Hour-check 2026-10-26 (scripts/d2-xlayer-eip3009-gas.py; worklog Task 14): CDP facilitator networks = Base/Polygon/Arbitrum/Monad/World/Solana — NO X Layer (free tier: 1,000 onchain tx/mo, then $0.001/tx, gas included in fee). x402.org default — no X Layer. thirdweb: /verify + /settle wire byte-identical to canonical v2, accepts arbitrary CAIP-2 chain ids, but account-gated (401 x-secret-key required on every /supported and /verify), plans from $99/mo + 0.3%/tx + $1/1000 Engine requests beyond 1k/mo + 2.5% gas surcharge, gas funded from the operator's thirdweb server wallet. X Layer preconditions for thirdweb verified on-chain: public thirdweb RPC 196.rpc.thirdweb.com answers eth_chainId=0xc4 unauthenticated; X Layer is Prague (latest block carries requestsHash ⇒ EIP-7702 available for their gasless settlement); USDC on 196 exposes the full EIP-3009 rail — transferWithAuthorization 0xe3ee160e, receiveWithAuthorization 0xef55bec6, authorizationState(address,bytes32) 0xe94a0102 all PRESENT in implementation 0x19556fd56bf1298090d491f995a743ed71bdf89b (behind OZ-legacy proxy slot org.zeppelinos.proxy.implementation); measured gas 0.02 gwei ⇒ $0.00015–0.00026 per settlement (OKB $107.66). At the $0.001 route price any third-party per-tx fee = 100% of the payment ⇒ Zeus-operated facilitator is the only production-viable rail on X Layer; final thirdweb confirmation (one GET /supported?chainId=196 with a dashboard key) remains open but is moot given the fee structure |

---

## Round-7 External Audit (secretariat-audit.md @ fb83dd403) — Verification & Repair 2026-10-26

Auditor's report verified line-by-line against main @ 404049346. Three-way classification per house convention. Fixed in the R7 repair package (commits on main); CI gate: typecheck + jest 55/55 suites (451 tests) + Adversarial E2E blocked=16/16 passed=4/4 PG ok=21/0.

| Finding | Classification | Disposition |
|---|---|---|
| A2 / A3 / B8-mock / A5c / A9 / B13 / C1-DPI / CAIP-2-part-of-A4 / docs (SERVER_PRIVATE_KEY) / ZEUS_FACILITATOR_URL warn / fake topic-hash | FIXED (already) | Landed by blocks 6–9 (F-108..F-116) and D1/D2 before this audit arrived; the report was cut against fb83dd403 (13 commits behind main) |
| A6 UNRESOLVED_MANUAL/INCIDENT collapse to FAILED | REPRODUCED AND FIXED | FSM (operation-fsm.ts) gained PAYMENT_SUBMITTED/SETTLEMENT_PENDING/SETTLEMENT_UNKNOWN → UNRESOLVABLE; dead deprecated execution path (C3) deleted; worker feeds UNRESOLVED_MANUAL/INCIDENT → UNRESOLVABLE |
| A7 SETTLEMENT_PENDING strands operation | REPRODUCED AND FIXED | New SettlementFeedbackService applied by ReconciliationWorker (SETTLED→SETTLED, NOT_SETTLED→SETTLEMENT_FAILED→FAILED, manual/incident→UNRESOLVABLE); ExecutionResult.status gained honest 'PENDING' for every non-terminal state (was 'FAILED') |
| A8 resultData/error/settlementProof not persisted | REPRODUCED AND FIXED | saveOperation persists resultData into extra_fields JSONB + error into error_reason; getOperation restores outcome (incl. fallback to execution_attempts.response_body of the SUCCESS attempt), settlementProof from settled_evidence_bundle, executionEvidence from the attempt |
| B1 adapter: non-JSON 2xx → DELIVERY_UNKNOWN; timeout cleared before body; no cause-aware classification; egress-blocked hidden | REPRODUCED AND FIXED | single text() read with signal armed through the body; JSON.parse on the full body (non-JSON = honest {raw} evidence, still SUCCESS); undici cause codes classified (ECONNRESET/ENOTFOUND/ECONNREFUSED/ETIMEDOUT); new DELIVERY_UNKNOWN reason EGRESS_BLOCKED |
| B2 any 4xx/5xx → terminal FAILED | REPRODUCED AND FIXED | RETRYABLE_SELLER_STATUSES {408,429,500,502,503,504}: attempt recorded DELIVERY_UNKNOWN (HTTP status preserved), fenced same-key retry under EXECUTION_IDEMPOTENT, else UNRESOLVABLE; definitive 4xx stays FAILED; Adversarial E2E B-BS-16 refuse-leg re-baselined to the honest semantics (bounded retries, job UNRESOLVABLE, single settlement, never COMPLETED) |
| B5a idempotency ignores body | REPRODUCED AND FIXED | collision guard compares a key-order-insensitive payload fingerprint; same target+method+different body → 409 REQUEST_COLLISION (derived-id AND explicit-requestId reuse) |
| B5b request_id lookup without client scope | REPRODUCED AND FIXED | getOperationByRequestId(requestId, clientId?) in both stores; Secretariat passthrough |
| B5c GET /v1/requests/:id unauthenticated | REPRODUCED AND FIXED | operations carrying a clientId answer only to the matching X-Client-Id header (404 otherwise — existence not disclosed); anonymous operations stay public; e2e driver sends the header |
| B6a revert → NOT_SETTLED while window open | REPRODUCED AND FIXED | revert holds RECONCILING until validBefore passes, then NOT_SETTLED (double-pay window closed); test AH covers both phases |
| B6d tx not found → eternal RECONCILING | REPRODUCED AND FIXED | receipt lookup reports found:false honestly (vs RPC failure); unanimous not-found → RECONCILING before validBefore, authorizationState fallback (§10/§11) after |
| B7a whole-object consensus | REPRODUCED AND FIXED | field-wise consensus (status/blockNumber/logs/state/found; confirmations+chainId excluded as head-derived), conservative min-confirmations for the consensus value |
| B7b rpcCall no timeout/ok-check | REPRODUCED AND FIXED | 10s AbortSignal.timeout + response.ok check |
| B7c chainId mismatch swallowed | REPRODUCED AND FIXED | ChainMismatchError rethrown past the per-provider catch (misconfiguration surfaces as observation failure) |
| B7d eth_getLogs from block 0 | REPRODUCED AND FIXED | 10k-block chunked scans (strict + lenient finders) |
| B7e "0x" eth_call = authorizationState false | REPRODUCED AND FIXED | malformed answers fail the provider (fail-closed §11 gates keep RECONCILING; a unanimous-malformed panel can no longer declare NOT_SETTLED) |
| B8 engine stale writes | REPRODUCED AND FIXED | txHash recovery writes are same-state CAS (compareAndSetState) instead of unconditional updatePaymentIntentStatus |
| B11b case-sensitive policy compares | REPRODUCED AND FIXED | networks/assets/payee compared case-insensitively (checksum vs lowercase no longer false-rejects) |
| B12 header-claimed capabilities → paid-call retries; SIGNED_RECEIPT stub | REPRODUCED AND FIXED | retries gated STRICTLY on EXECUTION_IDEMPOTENT; SIGNED_RECEIPT removed from the header-accept list (unimplemented → fail closed) |
| C2 Stage-B hash key-order + accepted TypeError | PARTIALLY FIXED | HTTP boundary already defended (payloadShapeIsValid 422); the direct-library TypeError path in validateExternalPaymentPayload remains (documented residual, latent only for library callers) |
| C2-worker probeCount pinned to 1; batchSize dead | REPRODUCED AND FIXED | claimed job read back via new getReconciliationJobById; batchSize bounds getDueReconciliationJobs(limit) |
| C1 terminal outcomes without evidence; SETTLED bundle fabricated zeros | REPRODUCED AND FIXED | terminal early-return carries the persisted bundle; SETTLED bundle: real gasUsed from receipt ("unavailable" when absent — never "0"), computed finalityReached, real rpcObservations; revert-NOT_SETTLED carries revert evidence |
| C3 dead deprecated execution path | REPRODUCED AND FIXED | observeExecution_DEPRECATED + handleRecovery + recoverVia* deleted (only callers were each other; re-fired seller calls without payment proof) |
| C4 Date.now()+Math.random() ids | REPRODUCED AND FIXED | crypto.randomUUID() for operation/request/intent/job/attempt ids (also closes the "guess a requestId" read vector) |
| C5 discovery sends body on GET; GET+body TypeError | REPRODUCED AND FIXED | GET/HEAD probed bodyless |
| C6 mid-file import | REPRODUCED AND FIXED | imports hoisted to the import block |
| C-API-1 blanket 409 for completed (free) resources | REPRODUCED AND FIXED | idempotent replay returns 200 with the public status + outcome for terminal operations |
| C-API-2 bare cors() in secretariat-app | REPRODUCED AND FIXED | allowlist (CORS_ORIGINS + localhost dev origins), parity with app.ts |
| B10 egress: NAT64/6to4 missing; no default timeout | PARTIALLY FIXED | 64:ff9b::/96 and 2002::/16 added to the blocklist; 15s default egress timeout (caller signal combined). DNS-rebinding (double-resolution window) remains a DOCUMENTED RESIDUAL — closing it requires a custom undici dispatcher pinning the validated IP (deferred; tracker: this row) |
| A3-residual 2xx without success field → SUBMITTED | REPRODUCED AND FIXED | success !== true → REJECTED (success:false) or UNKNOWN+RECONCILING (field missing, out-of-spec facilitator) |
| C-signer domain hardwired Base/8453 | REPRODUCED AND FIXED | network→domain bindings (base 8453 / x-layer 196 D1-verified / base-sepolia testnet), fail-fast on unknown networks |
| A1 protocol model: Secretariat settles itself; no PAYMENT-SIGNATURE to seller | ACCEPTED ARCHITECTURE — USER DECISION PENDING | The pay-then-prove model is coherent for the Zeus-owned ecosystem (own sellers + own facilitator, D2). Interop with STANDARD x402 sellers (which expect to settle via their own facilitator after receiving PAYMENT-SIGNATURE) is NOT implemented and blocks selling to third-party x402 endpoints. Decision required: (a) declare pay-then-prove a Zeus extension (document + restrict targets to Zeus sellers), or (b) implement the standard client flow. Nothing in the R7 package depends on this decision |
| A4 x402 v1 seller packages + 713-line patch | ACCEPTED (DEFERRED) | api-server seller-side still x402@1.2.0+patch; buyer side (Secretariat) is v2-only and internally coherent since F-113 (CAIP-2 composition). Migration to @x402/* v2 = week-scale follow-up alongside D2 hardening |
| B13-e2e-mock-only | PARTIALLY FIXED (already) | jest runs in CI since F-114; e2e remains mock-rail-only — real-rail exercise is the D2 staging-settle item (D2 row above) |
| B6b expiry by local clock | DISMISSED WITH EVIDENCE (risk-accepted) | expiry checks (§11-A, §9 window) use server wall clock; on misconfigured-NTP hosts the window could close early/late by the skew. Chain-time enforcement (eth_getBlockByNumber timestamps) is a follow-up; the fail-closed §11 gates (unanimous false + fresh heads + complete empty scan) bound the damage to "late NOT_SETTLED", never a premature one — a premature declaration is the dangerous direction and requires 5 simultaneous §11 conditions, none clock-only |
| F-19 driver baseline (found during gating) | REPRODUCED AND FIXED | policyRejectedBaseline() used an all-time count subtracted from a run-window count — correct only on a fresh-per-run DB (CI accident); window predicate now identical on both sides |
