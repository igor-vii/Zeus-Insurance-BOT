import { Router } from "express";

const router = Router();

const LLMS_TXT = `# Zeus Insurance Protocol API

> REST and MCP interface for decentralized insurance. Supports x402 payments. Live on X Layer (196) and BOT Chain (677).

## Endpoints

- GET /health - Health check
- POST /mcp - MCP server (JSON-RPC 2.0) for AI agents
- GET /api/quote - Calculate insurance premium
- POST /api/prepare-buy - Get buyPolicy calldata
- GET /api/policies - List policies by buyer address
- GET /api/reserve-stats - Reserve fund status

## MCP Tools

insurance_quote, insurance_prepare_buy, insurance_claim, insurance_get_policies, insurance_reserve_stats, escrow_prepare_deposit, escrow_prepare_confirm

## Authentication

Admin endpoints require JWT Bearer token. Public endpoints are open.

## Rate Limiting

100 requests per 15 minutes per IP.

## Full Documentation

https://zeus-insurance-bot.onrender.com/llms.txt
`;

router.get("/llms.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8");
  res.send(LLMS_TXT);
});

export default router;
