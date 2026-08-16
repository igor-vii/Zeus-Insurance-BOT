# Zeus Insurance Protocol

**Decentralized insurance for autonomous AI agents.** Live on X Layer (196) and BOT Chain (677).

AI agents buy delivery-failure and slashing protection policies via MCP or REST API. Premiums are priced dynamically using HUMI/WAMI trust scores. Claims are paid automatically from on-chain reserves.

---

## For AI Agents

### Quick Start (MCP)

Connect to the MCP endpoint and call tools directly:

    POST https://zeus-insurance-bot-api-production.up.railway.app/mcp
    Content-Type: application/json

    {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "tools/call",
      "params": {
        "name": "insurance_quote",
        "arguments": {
          "amount": "1000",
          "timeoutSeconds": 86400,
          "maxRetries": 3,
          "chainId": 196
        }
      }
    }

### Available MCP Tools

| Tool | Description | Read/Write |
|------|-------------|------------|
| insurance_quote | Calculate premium for a policy | Read |
| insurance_prepare_buy | Get signed calldata for buyPolicy() | Write |
| insurance_get_policies | List active policies by buyer address | Read |
| insurance_claim | File a claim for a failed delivery | Write |
| insurance_reserve_stats | Check reserve fund health | Read |
| escrow_prepare_deposit | Prepare escrow deposit calldata | Write |
| escrow_prepare_confirm | Confirm execution and release funds | Write |

### Example: Buy a Policy in 3 Steps

**Step 1 - Get a quote:**

    {
      "jsonrpc": "2.0", "id": 1,
      "method": "tools/call",
      "params": {
        "name": "insurance_quote",
        "arguments": { "amount": "500", "timeoutSeconds": 86400, "maxRetries": 2, "chainId": 196 }
      }
    }

Response: { "premium": "35.00", "totalCost": "535.00", "token": "USDC" }

**Step 2 - Prepare calldata:**

    {
      "jsonrpc": "2.0", "id": 2,
      "method": "tools/call",
      "params": {
        "name": "insurance_prepare_buy",
        "arguments": {
          "seller": "0xExecutorAddress...",
          "amount": "500",
          "timeoutSeconds": 86400,
          "maxRetries": 2,
          "chainId": 196,
          "buyerPrivateKey": "0x..."
        }
      }
    }

Response: { "to": "0xa540...", "data": "0x...", "value": "0" }

**Step 3 - Submit on-chain:**
Send the returned to + data as a transaction on X Layer (chain 196). The agent must have approved USDC spending to the insurance contract first.

### Discovery

- llms.txt (API): https://zeus-insurance-bot-api-production.up.railway.app/llms.txt
- llms.txt (Frontend): https://zeus-insurance-bot.onrender.com/llms.txt
- MCP Endpoint: POST /mcp (JSON-RPC 2.0, stateless)
- Health Check: GET /health

### Supported Networks

| Network | Chain ID | Token | Insurance Contract |
|---------|----------|-------|--------------------|
| X Layer Mainnet | 196 | USDC (0x74b7...6d22) | 0xed65...D908 |
| BOT Chain Mainnet | 677 | USDT (0xaBab...7a3C) | 0x2E59...69ef |

### Rate Limiting

100 requests per 15 minutes per IP. No API key required for public endpoints.

### SDK

    npm install @zeus/sdk

    import { ZeusClient } from "@zeus/sdk";
    const client = new ZeusClient({ chainId: 196 });
    const quote = await client.getQuote({ amount: "1000", timeoutSeconds: 86400, maxRetries: 3 });
    console.log("Premium: " + quote.premium + " USDC");

---

## Architecture

    AI Agent
      |
      +-- MCP (JSON-RPC 2.0) --> api-server --> X Layer / BOT Chain
      +-- REST API -----------> api-server --> Smart Contracts
      +-- SDK (@zeus/sdk) -----> ethers.js ---> On-chain directly

### Smart Contracts (X Layer)

| Contract | Address | Verified |
|----------|---------|----------|
| ZeusReserveV2 (delivery) | 0xeB6A...591c | done |
| ZeusInsuranceV2 | 0xed65...D908 | done |
| ZeusEscrowBOT | 0x882c...1546 | done |
| WatcherRegistry | 0xC175...b3c1 | done |
| ZeusReserveV2 (staking) | 0x9d3D...19dE | done |
| ZeusStakingInsurance | 0xe734...590b | done |

### Trust Layer (HUMI/WAMI)

Agent trust scores influence premium pricing:
- Elite agents (HUMI >= 800) -> base premium
- Standard agents (HUMI 400-799) -> base + 3%
- New/unknown agents (HUMI < 400) -> base + 5%

---

## License

MIT
