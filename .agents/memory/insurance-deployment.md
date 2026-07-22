---
name: Insurance deployment
description: ZeusInsuranceV2 (oracle watcher) — current deployed addresses, verified status, watcher setup
---

# ZeusInsuranceV2 Deployment (Base Sepolia)

## Addresses
- **ZeusInsuranceV2** (oracle v2): `0x58038Df01A824C94F3D2fEd6d4e1bEf2211Ad8F4`
- **ZeusReserveV2**: `0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47`
- **USDC** (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

## Status
- Verified on BaseScan: https://sepolia.basescan.org/address/0x58038Df01A824C94F3D2fEd6d4e1bEf2211Ad8F4#code
- `ZeusReserveV2.setInsuranceContract(0x58038...)` — done
- 3 test watchers registered on-chain: `0x70997970...`, `0x3C44CdDd...`, `0x90F79bf6...` (Hardhat accounts #1–3)

## Env vars (Replit shared env)
- `ZEUS_INSURANCE_ADDRESS=0x58038Df01A824C94F3D2fEd6d4e1bEf2211Ad8F4`
- `ZEUS_INSURANCE_NETWORK=base-sepolia`
- `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`
- `PRIVATE_KEY` — Replit Secret (deployer: 0xaF8c45345e79dA97Dd41db5FE04d13ad4BEB1640)

## Policy struct change
V2 replaced boolean fields `isActive/isPaidOut/isExpired` with `status: uint8` enum:
- 0 = Active, 1 = Claimed, 2 = Rejected, 3 = Expired

**Why:** Needed for oracle watcher voting resolution to set status atomically.

**How to apply:** Any place that reads `getPolicy` must derive booleans: `status===0→isActive`, `status===1→isPaidOut`, `status===3→isExpired`. `chain-sync.ts` already does this. If adding a new chain reader, follow the same pattern.

## API route prefix
Insurance routes are mounted WITHOUT `/insurance/` prefix:
- `/api/quote` (not `/api/insurance/quote`)
- `/api/prepare-buy` (not `/api/insurance/buy`)
- `/api/observation` (not `/api/insurance/observation`)
- `/api/policies`, `/api/reserve`

**Why:** `routes/index.ts` does `router.use(insuranceRouter)` without a sub-path.

## Watcher service
`watcher/` package (`@zeus/watcher`). Run with:
```
WATCHER_PRIVATE_KEY=0x... pnpm watcher
```
The registered Hardhat test accounts need their known private keys:
- 0x70997970... → `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`
- 0x3C44CdDd... → `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`
- 0x90F79bf6... → `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6`

## Verification quirk
First `hardhat verify` attempt failed (bytecode mismatch) but second attempt succeeded immediately. Retry once before debugging.

## evmVersion
`hardhat.config.ts` must use `evmVersion: "cancun"` for OZ 5.x (mcopy opcode in Bytes.sol). Without it compilation fails with "mcopy instruction only available for Cancun-compatible VMs".
