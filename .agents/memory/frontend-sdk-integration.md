---
name: Frontend SDK integration pattern
description: How the frontend uses @zeus/sdk for insurance operations (buy + claim + read)
---

## What changed
- `frontend/src/hooks/useZeusSDK.ts` — new hook that bridges wagmi WalletClient → ethers v6 `BrowserProvider` → `ZeusSDK.connect()`
- `frontend/src/pages/buy.tsx` — direct mode now calls `sdk.insurance.createPolicy()` (SDK auto-approves USDC; no separate approve step in UI)
- `frontend/src/pages/policies.tsx` — direct mode reads via `useQuery` + `Promise.all(sdk.insurance.getPolicy())`, claims via `sdk.insurance.claimPayout()`
- `frontend/src/lib/contracts.ts` — updated `ZEUS_INSURANCE_ADDRESS` to newly deployed address; added `INSURANCE_DEPLOY_BLOCK` constant

## What stayed on wagmi
- `escrow.tsx` — already uses API-backed server calldata via `useSendTransaction`; no SDK escrow module needed here
- `reserve.tsx` / `dashboard.tsx` — ZeusReserve has no SDK coverage; kept as wagmi `useReadContract` / `useWriteContract`
- `use-auth.ts` — SIWE signing via `useSignMessage`; keep as wagmi

## Viem → ethers bridge
`BrowserProvider(walletClient.transport as unknown as Eip1193Provider)` — viem's WalletClient transport is EIP-1193 compatible. The `useZeusSDK` hook reconnects whenever `walletClient` identity changes (account/network switch).

**Why:** ZeusSDK uses ethers v6 internally; wagmi v3 uses viem internally. The transport layer is the cleanest bridge — no extra package needed.
