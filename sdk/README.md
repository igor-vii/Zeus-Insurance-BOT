# @zeus/sdk

Unified TypeScript SDK for **Zeus Insurance Protocol** — designed for AI agents and developers.

Uses **ethers v6** and works in Node.js ≥ 18 and browser environments.

---

## Installation

```bash
pnpm add @zeus/sdk ethers
```

---

## Quick Start

```ts
import { ZeusSDK } from "@zeus/sdk";
import { ethers } from "ethers";

const sdk = new ZeusSDK();

// Browser — use MetaMask / injected provider
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
await sdk.connect("base-sepolia", signer);

// Node.js — use a private key wallet
// const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
// const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
// await sdk.connect("base-sepolia", wallet);
```

---

## Escrow

### Create an agreement

> You must `approve()` the escrow contract to spend USDC before calling this.

```ts
const USDC_DECIMALS = 6;
const amount = ethers.parseUnits("10", USDC_DECIMALS); // 10 USDC

const { agreementId, tx } = await sdk.escrow.depositAndCreateAgreement(
  "0xExecutorAddress",
  amount,
  86_400, // 1 day timeout in seconds
);

console.log("Agreement ID:", agreementId);
console.log("Tx hash:     ", tx.hash);
```

### Confirm execution (executor side)

Proof is stored **on-chain** in the `Agreement` struct — pass any string (IPFS CID, tx hash, URL).

```ts
await sdk.escrow.confirmExecution(agreementId, "ipfs://QmXxx...");
// or a tx hash:
await sdk.escrow.confirmExecution(agreementId, "0xabc123...");
```

### Request refund (initiator side, after timeout)

```ts
await sdk.escrow.requestRefund(agreementId);
```

### Read agreement state

```ts
const ag = await sdk.escrow.getAgreement(agreementId);
console.log(ag.status);   // AgreementStatus.Active | Completed | Refunded
console.log(ag.proof);    // on-chain proof bytes (hex), or null
```

---

## Insurance

```ts
// Create a policy
const { policyId } = await sdk.insurance.createPolicy(seller, amount, timeout, retries);

// Claim payout
await sdk.insurance.claimPayout(policyId);

// Read policy
const policy = await sdk.insurance.getPolicy(policyId);
```

---

## Deployed Addresses

| Network | Contract | Address |
|---|---|---|
| Base Sepolia | ZeusEscrowBOT | [`0x87365462353bCBAB2CF0DF57c7Cb15519C5B7c76`](https://sepolia.basescan.org/address/0x87365462353bCBAB2CF0DF57c7Cb15519C5B7c76#code) |
| Base Sepolia | USDC (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## Error Handling

```ts
import {
  ZeusError,
  ZeusNotConnectedError,
  ZeusValidationError,
  ZeusTransactionError,
  ZeusContractError,
} from "@zeus/sdk";

try {
  await sdk.escrow.depositAndCreateAgreement(executor, amount, timeout);
} catch (err) {
  if (err instanceof ZeusValidationError) {
    console.error("Bad input:", err.details);
  } else if (err instanceof ZeusTransactionError) {
    console.error("Tx failed:", err.txHash);
  } else if (err instanceof ZeusContractError) {
    console.error("Contract not deployed on this network");
  }
}
```

---

## Supported Networks

| Network | Chain ID | Escrow | Insurance |
|---|---|---|---|
| `base-sepolia` | 84532 | ✅ deployed | — |
| `mainnet` | 1 | — | — |
| `sepolia` | 11155111 | — | — |
| `localhost` | 31337 | configure locally | configure locally |
