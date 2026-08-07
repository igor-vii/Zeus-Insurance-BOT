# Zeus Insurance — API Server

Express v5 API server for the Zeus Insurance Protocol. Exposes REST endpoints for insurance/escrow operations, an x402 payment gateway, and an **MCP server** for AI agent integration.

- **Port:** `3001`
- **Stack:** TypeScript, Express v5, viem, ethers v6, Drizzle ORM, pino

---

## MCP Server

The Zeus API server implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) over **Streamable HTTP** (spec version 2025-03-26), allowing any MCP-compatible AI agent or tool to interact with the protocol without custom integration code.

### Endpoint
POST https://zeus-insurance-bot-api-production.up.railway.app/mcp

text

**Required headers:**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `application/json, text/event-stream` |
| `mcp-session-id` | Any unique string per logical session |

Responses arrive as SSE (`event: message\ndata: <json>`), which is standard for MCP Streamable HTTP. Parse the `data:` line to get the JSON-RPC response.

### Transport mode

The server runs in **stateless mode** — each `POST /mcp` creates a fresh server instance, handles the request, and disposes. No persistent session is required because all tools are pure API/chain calls.

---

## Tools

### 1. `insurance_quote`

Get a dynamic price quote for an insurance policy. Calculates a risk score based on the seller's history and returns the premium amount in USDC smallest units.

**Input:**

| Field | Type | Description |
|---|---|---|
| `seller` | `string` | Seller wallet address (`0x…`) |
| `amount` | `string` | Coverage amount in USDC smallest units (e.g. `"1000000"` = 1 USDC) |
| `maxRetries` | `integer` | Maximum delivery retries (1–10) |

**Output:**

```json
{
  "riskScore": 1.2500,
  "premiumAmount": "75000"
}
2. insurance_prepare_buy
Get the calldata required to call buyInsurance on-chain. The agent signs and broadcasts this transaction.

Input:

Field	Type	Description
seller	string	Seller wallet address (0x…)
amount	string	Coverage amount in USDC smallest units
timeoutSeconds	integer	Policy timeout in seconds (min 60)
maxRetries	integer	Maximum delivery retries (1–10)
Output:

json
{
  "to": "0x7483bB3C605f3187808b028d9e086AbCa2a34676",
  "data": "0x...",
  "riskScore": 1.2500,
  "premiumAmount": "75000"
}
3. insurance_claim
Get the calldata required to call claimPayout on-chain for an expired or failed policy. The buyer signs and broadcasts this transaction.

Input:

Field	Type	Description
policyId	string	Policy ID as a non-negative integer string
Output:

json
{
  "to": "0x7483bB3C605f3187808b028d9e086AbCa2a34676",
  "data": "0x..."
}
4. insurance_get_policies
List all insurance policies for a buyer address. Returns cached data when available; falls back to fetching directly from the chain.

Input:

Field	Type	Description
buyer	string	Buyer wallet address (0x…)
Output:

json
{
  "policies": [
    {
      "policyId": 42,
      "seller": "0x...",
      "amount": "5000000",
      "premium": "350000",
      "isActive": true,
      "isPaidOut": false,
      "isExpired": false
    }
  ],
  "source": "cache"
}
5. insurance_reserve_stats
Get the current reserve fund statistics directly from the chain.

Input: (none)

Output:

json
{
  "balance": "50000000000",
  "minThreshold": "10000000000",
  "maxDailyPayout": "5000000000",
  "remainingDailyPayout": "4750000000",
  "isAdequatelyFunded": true
}
6. escrow_prepare_deposit
Get the calldata required to deposit USDC and create an escrow agreement on-chain. The initiator signs and broadcasts this transaction.

Input:

Field	Type	Description
executor	string	Executor wallet address (0x…) — the party performing the work
amount	string	Escrow amount in USDC smallest units
timeoutSeconds	integer	Agreement timeout in seconds (min 60)
Output:

json
{
  "to": "0x6d250b4Eb62E7c8501C4C0319869fC1F1B68a6C2",
  "data": "0x..."
}
7. escrow_prepare_confirm
Get the calldata required to confirm successful execution of an escrow agreement and release funds to the executor.

Input:

Field	Type	Description
agreementId	string	Agreement ID as a non-negative integer string
proof	string	(optional) Execution proof — hex string (0x…) or plain UTF-8 text
Output:

json
{
  "to": "0x6d250b4Eb62E7c8501C4C0319869fC1F1B68a6C2",
  "data": "0x..."
}
Usage Examples
Discover available tools (curl)
bash
curl -X POST https://zeus-insurance-bot-api-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: my-session-1" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":"1"}'
Get a price quote (curl)
bash
curl -X POST https://zeus-insurance-bot-api-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: my-session-1" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "id": "2",
    "params": {
      "name": "insurance_quote",
      "arguments": {
        "seller": "0xSELLER_ADDRESS",
        "amount": "5000000",
        "maxRetries": 3
      }
    }
  }'
Use with Claude Desktop (mcp_servers config)
Add to your claude_desktop_config.json:

json
{
  "mcpServers": {
    "zeus-insurance": {
      "url": "https://zeus-insurance-bot-api-production.up.railway.app/mcp",
      "transport": "streamable-http"
    }
  }
}
Claude can then call Zeus tools directly during conversations, e.g.:

"Buy insurance from seller 0xABC… for 5 USDC with a 24-hour timeout and 3 retries."

Running Tests
bash
cd api-server
pnpm install
pnpm test
The test file is tests/mcp-server.test.ts. It calls the live server at http://localhost:3001 (override with API_URL env var). Requires the API server to be running.

Environment Variables
Variable	Description
SESSION_SECRET	Cookie signing secret (required)
ZEUS_NETWORK	Default network (bot-chain or x-layer)
ZEUS_INSURANCE_NETWORK	Override network for insurance contract only
SERVER_PRIVATE_KEY	Enables automatic mode — server signs transactions
BOT_CHAIN_RPC_URL	Custom RPC for BOT Chain
XLAYER_MAINNET_RPC_URL	Custom RPC for X Layer
ZEUS_TREASURY	Wallet receiving x402 API fees
DATABASE_URL	PostgreSQL connection string
PORT	Server port (default: 3001)
NODE_ENV	production / development
REST API
Base path: /api

Method	Path	Auth	Description
GET	/quote	—	Calculate premium for amount + retries
POST	/insurance/prepare-buy	x402	Prepare buyInsurance calldata
GET	/insurance/policies?buyer=	—	List policies for an address
GET	/insurance/policies/:id	—	Get single policy
POST	/insurance/claim	—	Prepare claimPayout calldata
GET	/insurance/reserve	—	Reserve fund status
POST	/escrow/prepare-deposit	—	Prepare escrow deposit calldata
POST	/escrow/prepare-confirm	—	Prepare escrow confirm calldata
GET	/x402/info	—	x402 payment terms discovery
POST	/mcp	—	MCP Streamable HTTP server (7 tools)
License
MIT © 2026 Igor Ivanov — Zeus
