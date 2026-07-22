# ⚡ Zeus Insurance BOT — Decentralized Insurance Protocol for AI Agents (BOT Chain)

**Zeus Insurance BOT** is the BOT Chain (Botanix) deployment of the Zeus Insurance Protocol.
Uses **USDT** as the settlement token. Protects AI agents and Web3 projects from financial
losses caused by API failures, technical downtime, and oracle risks.

> 🔗 **Source:** [github.com/igor-vii/Zeus-Insurance-Escrow](https://github.com/igor-vii/Zeus-Insurance-Escrow)
> 📦 **Network:** BOT Chain (Botanix Mainnet · Chain 3637)

---

## 🎯 Key Differences from Main Repo

| Parameter | Zeus-Insurance-Escrow | Zeus-Insurance-BOT |
|---|---|---|
| Network | X Layer Mainnet (Chain 196) | BOT Chain / Botanix (Chain 3637) |
| Settlement token | USDC | **USDT** |
| Compiler | 0.8.27 | 0.8.24 (BOT Chain compatible) |

---

## 💡 How It Works

1. **AI agent** purchases an insurance policy with USDT via `buyInsurance(seller, amount, timeout, retries)`.
2. **Oracle** monitors the seller's service for failures.
3. **On failure**, Zeus automatically pays out `amount - premium` USDT to the agent from the reserve.

---

## 🏗 Architecture

```
ZeusInsuranceV2  ←→  ZeusReserveV2  (USDT reserve pool)
ZeusEscrowBOT                        (escrow for direct agreements)
ZeusArbitrationRisk                  (arbitration insurance layer)
```

---

## 🚀 Deploy to BOT Chain

```bash
cd contracts
cp .env.example .env  # set PRIVATE_KEY, BOT_CHAIN_RPC_URL
pnpm install
pnpm deploy:bot-chain
```

---

## 🔗 BOT Chain (Botanix) Info

| Parameter | Value |
|---|---|
| Chain ID | 3637 |
| RPC | https://rpc.botanixlabs.com |
| Explorer | https://blockscout.botanixlabs.com |
| Testnet Chain ID | 3636 |
| Testnet RPC | https://node.botanixlabs.dev |

---

## 📄 License

MIT © 2025 Igor Ivanov
