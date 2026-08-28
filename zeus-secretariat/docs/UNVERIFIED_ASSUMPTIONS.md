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
