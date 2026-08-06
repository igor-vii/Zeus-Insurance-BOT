# Zeus Insurance Protocol

**Decentralized Trust Layer for Autonomous AI Commerce**

---

## Overview

Zeus is a modular protocol for trust infrastructure in autonomous AI economies.

It provides:
- **Insurance** — protects against API failures, validator slashing, and oracle downtime
- **Escrow** — secures agent-to-agent transactions with 0.7% + $0.02 fee
- **Slashing Protection** — validator coverage with flexible rates (10–20%)
- **Reserve Management** — liquidity pool with daily payout caps and threshold protection

---

## Contract Addresses

**Version:** v2.4  
**Deployed:** 2026-08-05

### BOT Chain (chainId 677)

| Contract | Address | Decimals |
|----------|---------|----------|
| **ZeusInsuranceV2** | `0x6D84aa31073D4C51b579e468bdb02cc11343296E` | — |
| **ZeusReserveV2** | `0x6d250b4Eb62E7c8501C4C0319869fC1F1B68a6C2` | — |
| **ZeusEscrowBOT** | `0x04DbB961817B94EE99e1eAa7cc5c07E1BD042364` | — |
| **USDT** | `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` | 6 |

**Explorer:** [https://scan.botchain.ai](https://scan.botchain.ai)

---

### X Layer (chainId 196)

| Contract | Address | Decimals |
|----------|---------|----------|
| **ZeusInsuranceV2** | `0x7483bB3C605f3187808b028d9e086AbCa2a34676` | — |
| **ZeusReserveV2** | `0xc931c85EDeeb4949DE752c57bf768fe865554b56` | — |
| **ZeusEscrowBOT** | `0x6d250b4Eb62E7c8501C4C0319869fC1F1B68a6C2` | — |
| **USDC** | `0x74b7f16337b8972027f6196a17a631ac6de26d22` | 6 |

**Explorer:** [https://www.oklink.com/xlayer](https://www.oklink.com/xlayer)

---

## RPC Endpoints

| Network | Primary RPC | Fallback RPC |
|---------|-------------|--------------|
| **BOT Chain** | `https://rpc.botchain.ai` | — |
| **X Layer** | `https://rpc.xlayer.tech` | `https://xlayerrpc.okx.com` |

---

## Quick Start

### Buy Policy via API (AI Agent)

```bash
curl -X POST https://zeus-insurance-bot-api-production.up.railway.app/api/prepare-buy \
  -H "Content-Type: application/json" \
  -d '{
    "seller": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "amount": "1000000",
    "timeoutSeconds": 86400,
    "maxRetries": 3,
    "premium": "25000",
    "chainId": 196
  }'
Send the returned data to to via your wallet or eth_sendRawTransaction.

Deployment Status
Component	Status	URL / Note
Frontend	✅ Live	https://zeus-insurance-frontend.onrender.com
API	✅ Live	https://zeus-insurance-bot-api-production.up.railway.app
Watcher	✅ Live	Internal service (Railway). Signs observations every 2 min.
All contracts are verified on-chain.

Quick Links
What	Where
Technical Docs	/docs
Library of Olympus	/docs/README.md — Institutional architecture
API Reference	Swagger UI
OKX AI Marketplace	Agent Store (Listing #7202)
Verified ABI & Source
Contract source code and ABI are verified on the respective chain explorers (links above).
For local development, ABI files are available in the repository under packages/contracts/abi/.

Contact
Igor Ivanov — Founder
GitHub: @igor-vii
Telegram: @IvanovVII
Email: zeusinsurance@mail.ru

License
MIT © 2026 Igor Ivanov — Zeus
