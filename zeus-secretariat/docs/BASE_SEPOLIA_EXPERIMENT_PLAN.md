# BASE SEPOLIA EXPERIMENT PLAN

**Date:** 26.08.2026
**Network:** Base Sepolia (chainId 84532)
**Token:** USDC (or test ERC-20 with EIP-3009)
**Purpose:** Validate risky assumptions from RECONCILIATION_PROTOCOL_SPEC_V0.1

---

## Phase 1 - Core Economic Safety (MUST PASS)

### Experiment 1: Successful Settle

**Steps:**
1. Create EIP-3009 authorization (sign with EOA)
2. Submit to facilitator /settle
3. Record txHash from response
4. Verify on-chain:
   - authorizationState(authorizer, nonce) == true
   - AuthorizationUsed(authorizer, nonce) event exists
   - transactionReceipt.status == 1
   - Transfer(from=authorizer, to=payTo, value >= amount) in same tx
5. Record block number and confirmation count

**Expected:** All 4 on-chain checks pass. SETTLED proof bundle complete.

**What we learn:** Does the facilitator actually broadcast? Is authorizationState reliable?

---

### Experiment 2: Duplicate Settle

**Steps:**
1. Use SAME PaymentPayload (same nonce, same signature) from Experiment 1
2. Submit to facilitator /settle again
3. Record response
4. Check on-chain: was a second transaction created?
5. Check balances: was authorizer charged twice?

**Expected:** Facilitator rejects or returns same txHash. No double charge.

**What we learn:** Is facilitator idempotent at protocol level? Or only HTTP level?
**This directly validates spec section 19 (Duplicate /settle protection).**

---

### Experiment 3: Broadcast + Lost Response

**Steps:**
1. Submit to facilitator /settle
2. Simulate lost response (kill connection after send, before receiving response)
   OR: use a proxy that drops the response after forwarding the request
3. Secretariat has no txHash, status = UNKNOWN
4. Wait T+10s
5. Check authorizationState(authorizer, nonce)
6. If true: scan for AuthorizationUsed event to recover txHash
7. Verify full SETTLED proof bundle

**Expected:** Recovery succeeds via nonce. txHash recovered. SETTLED.

**What we learn:** Can we reliably recover from lost facilitator response?
**This validates spec sections 5, 10, 17.**

---

### Experiment 4: Expired Unused Authorization

**Steps:**
1. Create EIP-3009 authorization with validBefore = now + 60 seconds
2. Do NOT submit to facilitator (leave it unused)
3. Wait for validBefore to pass
4. Check authorizationState(authorizer, nonce) via RPC A
5. Check authorizationState(authorizer, nonce) via RPC B (different provider)
6. Both should return false
7. Conclude: NOT_SETTLED

**Expected:** Both RPCs agree false. NOT_SETTLED is safe to declare.

**What we learn:** Is authorizationState reliable after expiry?
**Do two independent RPCs agree? This validates spec sections 11-15.**

---

## Phase 2 - Extended (AFTER Phase 1 passes)

### Experiment 5: Reverted Transaction

**Steps:**
1. Create authorization
2. Submit to facilitator but ensure tx reverts (e.g., insufficient balance after approval)
3. Check receipt.status == 0
4. Verify: NOT_SETTLED for this attempt
5. Verify: no Transfer event in reverted tx logs

**Expected:** Reverted tx is NOT counted as settlement.

---

### Experiment 6: RPC Disagreement

**Steps:**
1. Use two RPC providers (e.g., Alchemy + Infura)
2. Find a scenario where they disagree on authorizationState
   (may need to hit during block propagation window)
3. Verify: result is UNKNOWN, not NOT_SETTLED

**Expected:** Disagreement -> UNKNOWN. Never auto-declare NOT_SETTLED.

---

### Experiment 7: Restart Recovery

**Steps:**
1. Submit payment, get to SETTLEMENT_PENDING or RECONCILING
2. Kill the process
3. Restart
4. Verify: process finds non-terminal intent
5. Verify: moves to RECONCILING
6. Verify: does NOT re-submit to /settle
7. Verify: completes reconciliation using persisted data

**Expected:** Recovery without new signature, without duplicate /settle.

---

## Success Criteria

Phase 1 (4 experiments) ALL pass = core economic safety model validated.
Phase 2 (3 experiments) ALL pass = extended confidence.

If ANY Phase 1 experiment fails: spec assumption is wrong, must revise before implementation.

## Configuration Needed

- RPC_PRIMARY: (e.g., Alchemy Base Sepolia)
- RPC_SECONDARY: (e.g., Infura Base Sepolia)
- Test EOA private key (funded with test ETH + USDC)
- USDC contract address on Base Sepolia
- Facilitator endpoint (Coinbase CDP x402 or self-hosted mock)
- EIP-3009 compatible token contract
