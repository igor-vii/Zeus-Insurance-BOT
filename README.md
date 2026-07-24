# ⚡ Zeus Insurance BOT — Decentralized Insurance Protocol for AI Agents (BOT Chain)

**Zeus Insurance BOT** is the BOT Chain (chain 677) deployment of the Zeus Insurance Protocol.
Uses **USDT** as the settlement token. Protects AI agents and Web3 projects from financial
losses caused by API failures, technical downtime, oracle risks — and now **validator slashing**.

> 🔗 **Source:** [github.com/igor-vii/Zeus-Insurance-Escrow](https://github.com/igor-vii/Zeus-Insurance-Escrow)
> 📦 **Network:** BOT Chain Mainnet · Chain 677

---

## 🟢 Deployment Status

| Network | Status |
|---|---|
| BOT Chain mainnet (chain 677) | ✅ BOT Chain mainnet — live |
| Base Sepolia (testnet) | ✅ Active (oracle watcher) |
| X Layer mainnet (chain 196) | ✅ Active |

---

## 🌿 BOT Chain — Deployed Contracts

| Contract | Address |
|---|---|
| **ZeusInsuranceV2** | [`0x8D10C2c6C92b613C1938fe532f0e391044e76188`](https://scan.botchain.ai/address/0x8D10C2c6C92b613C1938fe532f0e391044e76188) |
| **ZeusReserveV2** | [`0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c`](https://scan.botchain.ai/address/0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c) |
| **ZeusEscrowBOT** | [`0x0d4AD4C6b60F445d0e478E0AF48075340AC51Cf5`](https://scan.botchain.ai/address/0x0d4AD4C6b60F445d0e478E0AF48075340AC51Cf5) |
| **USDT (BOT Chain)** | [`0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`](https://scan.botchain.ai/address/0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C) |

> 🔍 **Explorer:** [scan.botchain.ai](https://scan.botchain.ai)

**Chain info:**
| Parameter | Value |
|---|---|
| Chain ID | **677** |
| RPC | https://rpc.botchain.ai |
| Explorer | https://scan.botchain.ai |

---

## 🎯 Key Differences from Main Repo

| Parameter | Zeus-Insurance-Escrow | Zeus-Insurance-BOT |
|---|---|---|
| Network | X Layer Mainnet (Chain 196) | BOT Chain Mainnet (Chain 677) |
| Settlement token | USDC | **USDT** |
| Compiler | 0.8.27 | 0.8.24 (BOT Chain compatible) |
| Slashing Protection | ❌ | ✅ **New** |

---

## 💡 How It Works

1. **AI agent / staker** purchases a policy via `buyInsurance()` (API failure) or `buySlashingProtection()` (validator slashing) with USDT.
2. **Oracle watchers** monitor service health or validator slashing events on BOT Chain.
3. **On failure / slashing**, Zeus automatically pays out `amount` USDT to the policyholder from the reserve.

---

## 🛡 Coverage Products

### 1. Standard Insurance (API / Uptime)
```solidity
buyInsurance(address seller, uint256 amount, uint256 timeoutSeconds, uint256 maxRetries)
```
- **Premium:** 7% + 2% × (retries − 1) of coverage amount
- **Claim:** Timeout-based (buyer calls `claimPayout`) or oracle quorum (3-of-N watchers vote TIMEOUT)

### 2. Slashing Protection (Validators) — NEW
```solidity
buySlashingProtection(address validator, uint256 amount, uint256 timeoutSeconds)
```
- **Premium:** **5%** (500 bps) of coverage amount — flat rate
- **Claim:** Watcher calls `reportSlashing(policyId, evidenceHash)` upon detecting on-chain slashing event
- **Coverage:** Immediate full payout, no voting quorum needed

---

## 🏗 Architecture

```
ZeusInsuranceV2  ←→  ZeusReserveV2  (USDT reserve pool)
     ↑
  Watcher nodes (oracle observations + slashing oracle)
ZeusEscrowBOT                        (escrow for direct agreements)
```

---

## 🚀 Deploy to BOT Chain

```bash
cd contracts
cp .env.example .env  # set PRIVATE_KEY, BOT_CHAIN_MAINNET_RPC_URL
pnpm install
pnpm deploy:bot-chain-mainnet
```

---

## 🔧 Environment Variables

| Variable | Description |
|---|---|
| `ZEUS_INSURANCE_NETWORK` | `bot-chain-mainnet` for BOT Chain |
| `BOT_CHAIN_MAINNET_RPC_URL` | `https://rpc.botchain.ai` |
| `ZEUS_INSURANCE_ADDRESS` | `0x8D10C2c6C92b613C1938fe532f0e391044e76188` |
| `SERVER_PRIVATE_KEY` | Server wallet for automatic mode |
| `WATCHER_PRIVATE_KEY` | Registered watcher key (oracle + slashing) |

---

## 🧪 Тестирование (Test Results)

**108 tests — all passing** (`cd contracts && pnpm test`, run 2026-07-24)

### ZeusInsuranceV2 — 46 tests ✅

```
  constructor
    ✔ sets usdt and reserve addresses
    ✔ reverts on zero usdt address
    ✔ reverts on zero reserve address
  buyInsurance
    ✔ creates a policy and emits PolicyCreated
    ✔ premium transferred to reserve (formula: 700 + (retries-1)×200 bps)
    ✔ increments nextPolicyId
    ✔ stores correct policy fields
    ✔ reverts for zero seller
    ✔ reverts for zero amount
    ✔ reverts for maxRetries = 0
    ✔ reverts for maxRetries > 10
  claimPayout
    ✔ pays out after retryDeadline and emits PayoutExecuted
    ✔ marks policy status as Claimed (1)
    ✔ reverts if not buyer
    ✔ reverts before retryDeadline
    ✔ reverts on double-claim
  watcher management
    ✔ addWatcher registers a watcher and emits WatcherAdded
    ✔ getWatchers returns all registered watchers
    ✔ removeWatcher deregisters and emits WatcherRemoved
    ✔ reverts addWatcher for zero address
    ✔ reverts addWatcher for duplicate
    ✔ reverts removeWatcher for non-watcher
    ✔ reverts addWatcher from non-owner
  submitObservation (oracle)
    ✔ accepts a valid watcher observation and emits ObservationSubmitted
    ✔ resolves to PAYOUT when 2+ TIMEOUT votes (status=1)
    ✔ resolves to REJECTED when < 2 TIMEOUT votes
    ✔ reverts if watcher votes twice on same requestId
    ✔ reverts for a signature from a non-watcher
    ✔ reverts for a stale timestamp (> 120 s old)
    ✔ reverts if requestId doesn't match (buyer/seller/timestamp)
    ✔ reverts after requestId is resolved (used)
  buySlashingProtection ★ NEW
    ✔ creates a SlashingProtection policy and emits PolicyCreated
    ✔ sets coverageType to SlashingProtection (1)
    ✔ standard buyInsurance has coverageType Standard (0)
    ✔ premium is 5% (500 bps) of amount
    ✔ stores maxRetries = 1 and correct fields
    ✔ reverts for zero validator address
    ✔ reverts for zero amount
  reportSlashing ★ NEW
    ✔ watcher can reportSlashing and emits SlashingReported + PayoutExecuted
    ✔ sets policy status to Claimed after report
    ✔ reverts if caller is not a watcher
    ✔ reverts for a standard (non-slashing) policy
    ✔ reverts for a non-active policy (already claimed)
  IInsuranceContract interface
    ✔ isClaimApproved returns false before claim
    ✔ isClaimApproved returns true after claimPayout marks status=Claimed
    ✔ markClaimFulfilled reverts if not called by reserve
```

### ZeusEscrowBOT — 23 tests ✅

```
  constructor
    ✔ sets the token address correctly
    ✔ reverts if token address is zero
  depositAndCreateAgreement
    ✔ creates an agreement and locks tokens in the contract
    ✔ increments agreementCount
    ✔ reverts if executor is zero address
    ✔ reverts if initiator and executor are the same
    ✔ reverts if amount is zero
    ✔ reverts if timeout is zero
    ✔ reverts if allowance is insufficient
  confirmExecution
    ✔ releases funds to executor and emits event
    ✔ accepts empty proof bytes
    ✔ reverts if called by non-executor
    ✔ reverts if called by initiator
    ✔ reverts if agreement does not exist
    ✔ reverts if agreement is already completed
  requestRefund
    ✔ returns funds to initiator after timeout and emits event
    ✔ reverts if timeout has not elapsed
    ✔ reverts if called by non-initiator
    ✔ reverts if called by executor
    ✔ reverts if agreement does not exist
    ✔ reverts if agreement is already refunded
    ✔ reverts if executor already confirmed (agreement completed)
  getAgreement
    ✔ reverts for non-existent agreement
```

### ZeusReserveV2 — 39 tests ✅

Reserve deposit, withdraw, payClaim, daily payout cap, reentrancy protection — all green.

---

## 📄 License

MIT © 2025 Igor Ivanov
