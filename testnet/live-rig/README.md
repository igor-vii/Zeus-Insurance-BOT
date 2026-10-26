# Zeus live testnet rig (`testnet/live-rig/`)

**What it proves, end to end, with ZERO mocks in the payment path:**

```
payer (viem, EIP-3009 signature)
  → StandardX402Transport        (zeus-secretariat repo code, PAYMENT-SIGNATURE header)
    → OFFICIAL @x402/express seller  (@x402/core+express+evm 2.28.0, unpatched)
      → zeus-facilitator          (zeus-facilitator repo code, real node:http server)
        → transferWithAuthorization ON-CHAIN (anvil fork of sepolia.base.org)
      ← {success, transaction}
    ← PAYMENT-RESPONSE (base64 receipt)
  ← SUBMITTED(txHash)
→ on-chain assertions + hostile replay must be refused
```

## What the rig does (phases)

1. Funds fresh wallets on the fork: USDC via the FiatToken mint path
   (impersonate `masterMinter` → `configureMinter` → `mint`), ETH for the
   facilitator gas payer. The payer stays gasless (EIP-3009).
2. Boots **zeus-facilitator** (`ZEUS_FACILITATOR_NETWORK=eip155:84532`, RPC → anvil).
3. Boots an **official** express seller wired exactly like `api-server/src/app.ts`
   (`paymentMiddleware` + `x402ResourceServer` + `HTTPFacilitatorClient` → our facilitator).
4. Discovery: unpaid probe → **402 + `PAYMENT-REQUIRED`** (canonical v2, domain `USDC`/`2`).
5. Signs the EIP-712 `TransferWithAuthorization` and sends the paid call through
   the repo's `StandardX402Transport`.
6. Hostile replay: the SAME signature a second time → must NOT settle twice.
7. On-chain truth: settlement receipt success, `AuthorizationUsed(from, nonce)`
   event present, payer balance −1000, treasury +1000 (exact price, nothing else moves).

Evidence lands in `evidence/result.json` (+ `evidence/rig.log` with the
facilitator's own verify/settle trail).

## Run it

Prereqs: Foundry `anvil`, Node 20+, network access to `sepolia.base.org`.

```bash
anvil --fork-url https://sepolia.base.org --port 8545 &
cd zeus-facilitator && npx tsc && cd ..            # build the facilitator dist
cd testnet/live-rig && npm install && npx tsx rig.ts
```

Expected tail: `PASS: full live cycle — transport → official seller → zeus-facilitator → on-chain settle → PAYMENT-RESPONSE`.

## Notes

- This folder is a **standalone npm project, NOT a pnpm-workspace member and
  NOT run by CI** (CI has no anvil). It is the D2 staging recipe: before
  pointing the same components at X Layer mainnet (`eip155:196`), the full
  cycle must pass here — it did (2026-10-27, tx `0x5d440e28…3c938` on the fork
  at block 50559799, plus an earlier first pass `0x2927330b…3c938`).
- The rig refuses to run against a stale/foreign facilitator or seller on its
  ports (identity check on `/health` payer address, `/supported` capability
  check, listen-error surface) — leftovers from previous runs were the only
  real failure mode during development.
- Production target: `eip155:196` (X Layer). The staging registry entry
  `eip155:84532` (Base Sepolia) is what this rig exercises; the only intended
  difference on mainnet is the network id, the USDC contract, and the pinned
  domain (`USD Coin`/`2` — D1, verified on-chain).
