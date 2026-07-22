/**
 * Zeus Insurance MCP Server — 7 tools over Streamable HTTP transport.
 *
 * Runs in stateless mode: each POST to /mcp creates a fresh server+transport,
 * handles the JSON-RPC request, and disposes. No session state is needed
 * because every tool is a pure API call against the chain or DB.
 *
 * Mount by calling connectMCPServer(app) after Express is configured.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { encodeFunctionData, isAddress } from "viem";
import type { Express, Request, Response } from "express";

import { logger } from "../lib/logger.js";
import { publicClient } from "../lib/chain.js";
import {
  ZEUS_INSURANCE_ADDRESS,
  ZEUS_INSURANCE_ABI,
  ZEUS_RESERVE_ADDRESS,
  ZEUS_RESERVE_ABI,
} from "../lib/contracts-server.js";
import { ZEUS_ESCROW_BOT_ADDRESS, ZEUS_ESCROW_BOT_ABI } from "../lib/escrow-contracts.js";
import { getCachedPolicies } from "../lib/policy-cache.js";
import { fetchAndCachePolicies } from "../lib/chain-sync.js";
import { getSellerHistory } from "../services/sellerHistory.js";
import { calculateRiskScore, calculatePremium } from "../services/pricing.js";
import { prepareClaimCalldata } from "../services/insurance.js";

// ─── Tool result helper ───────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string, detail?: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, detail: String(detail ?? "") }) }],
    isError: true,
  };
}

// ─── Server factory ───────────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "zeus-insurance", version: "1.0.0" });

  // ── Tool 1: insurance_quote ──────────────────────────────────────────────────
  server.tool(
    "insurance_quote",
    "Get a dynamic price quote for an insurance policy. Returns the risk score for the seller and the premium amount in USDC (smallest units).",
    {
      seller: z.string().describe("Seller wallet address (0x…)"),
      amount: z.string().describe("Coverage amount in USDC smallest units (e.g. '1000000' = 1 USDC)"),
      maxRetries: z.number().int().min(1).max(10).describe("Maximum number of delivery retries (1–10)"),
    },
    async ({ seller, amount, maxRetries }) => {
      if (!isAddress(seller)) return err("Invalid seller address");
      const amountBigInt = BigInt(amount);
      try {
        const history = await getSellerHistory(seller);
        const riskScore = await calculateRiskScore(seller, amountBigInt, maxRetries, history);
        const premiumAmount = await calculatePremium(amountBigInt, riskScore);
        return ok({ riskScore: parseFloat(riskScore.toFixed(4)), premiumAmount: premiumAmount.toString() });
      } catch (e) {
        return err("Failed to calculate quote", e);
      }
    },
  );

  // ── Tool 2: insurance_prepare_buy ────────────────────────────────────────────
  server.tool(
    "insurance_prepare_buy",
    "Get the calldata required to buy an insurance policy on-chain. The agent must sign and broadcast the returned transaction.",
    {
      seller: z.string().describe("Seller wallet address (0x…)"),
      amount: z.string().describe("Coverage amount in USDC smallest units"),
      timeoutSeconds: z.number().int().min(60).describe("Policy timeout in seconds (minimum 60)"),
      maxRetries: z.number().int().min(1).max(10).describe("Maximum delivery retries"),
    },
    async ({ seller, amount, timeoutSeconds, maxRetries }) => {
      if (!isAddress(seller)) return err("Invalid seller address");
      try {
        const amountBigInt = BigInt(amount);
        const history = await getSellerHistory(seller);
        const riskScore = await calculateRiskScore(seller, amountBigInt, maxRetries, history);
        const premiumAmount = await calculatePremium(amountBigInt, riskScore);
        const data = encodeFunctionData({
          abi: ZEUS_INSURANCE_ABI,
          functionName: "buyInsurance",
          args: [seller as `0x${string}`, amountBigInt, BigInt(timeoutSeconds), BigInt(maxRetries)],
        });
        return ok({
          to: ZEUS_INSURANCE_ADDRESS,
          data,
          riskScore: parseFloat(riskScore.toFixed(4)),
          premiumAmount: premiumAmount.toString(),
        });
      } catch (e) {
        return err("Failed to prepare buy calldata", e);
      }
    },
  );

  // ── Tool 3: insurance_claim ──────────────────────────────────────────────────
  server.tool(
    "insurance_claim",
    "Get the calldata required to claim a payout for an expired or failed insurance policy. The buyer must sign and broadcast the returned transaction.",
    {
      policyId: z.string().describe("Policy ID (non-negative integer string)"),
    },
    async ({ policyId }) => {
      if (!/^\d+$/.test(policyId)) return err("policyId must be a non-negative integer string");
      try {
        const result = prepareClaimCalldata(BigInt(policyId));
        return ok(result);
      } catch (e) {
        return err("Failed to prepare claim calldata", e);
      }
    },
  );

  // ── Tool 4: insurance_get_policies ───────────────────────────────────────────
  server.tool(
    "insurance_get_policies",
    "List all insurance policies for a buyer address. Returns cached data when fresh; falls back to fetching from the chain.",
    {
      buyer: z.string().describe("Buyer wallet address (0x…)"),
    },
    async ({ buyer }) => {
      if (!isAddress(buyer)) return err("Invalid buyer address");
      try {
        const cached = await getCachedPolicies(buyer);
        if (cached !== null) return ok({ policies: cached, source: "cache" });
        const policies = await fetchAndCachePolicies(buyer);
        return ok({ policies, source: "chain" });
      } catch (e) {
        return err("Failed to fetch policies", e);
      }
    },
  );

  // ── Tool 5: insurance_reserve_stats ─────────────────────────────────────────
  server.tool(
    "insurance_reserve_stats",
    "Get the current reserve fund statistics: balance, minimum threshold, daily payout limits, and funding adequacy.",
    {},
    async () => {
      try {
        const results = await publicClient.multicall({
          contracts: [
            { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "getReserveBalance" },
            { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "minReserveThreshold" },
            { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "maxDailyPayout" },
            { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "remainingDailyPayout" },
            { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "isAdequatelyFunded" },
          ],
        });
        const [balance, minThreshold, maxDailyPayout, remainingDailyPayout, isAdequatelyFunded] = results;
        if ([balance, minThreshold, maxDailyPayout, remainingDailyPayout, isAdequatelyFunded].some(r => r.status !== "success")) {
          return err("One or more reserve reads failed from chain");
        }
        return ok({
          balance: (balance.result as bigint).toString(),
          minThreshold: (minThreshold.result as bigint).toString(),
          maxDailyPayout: (maxDailyPayout.result as bigint).toString(),
          remainingDailyPayout: (remainingDailyPayout.result as bigint).toString(),
          isAdequatelyFunded: isAdequatelyFunded.result as boolean,
        });
      } catch (e) {
        return err("Failed to fetch reserve stats from chain", e);
      }
    },
  );

  // ── Tool 6: escrow_prepare_deposit ───────────────────────────────────────────
  server.tool(
    "escrow_prepare_deposit",
    "Get the calldata required to deposit USDC and create an escrow agreement on-chain. The initiator must sign and broadcast the returned transaction.",
    {
      executor: z.string().describe("Executor wallet address (0x…) — the party that will perform the work"),
      amount: z.string().describe("Escrow amount in USDC smallest units"),
      timeoutSeconds: z.number().int().min(60).describe("Agreement timeout in seconds (minimum 60)"),
    },
    async ({ executor, amount, timeoutSeconds }) => {
      if (!ZEUS_ESCROW_BOT_ADDRESS) return err("Escrow contract not deployed — set ZEUS_ESCROW_BOT_ADDRESS");
      if (!isAddress(executor)) return err("Invalid executor address");
      try {
        const data = encodeFunctionData({
          abi: ZEUS_ESCROW_BOT_ABI,
          functionName: "depositAndCreateAgreement",
          args: [executor as `0x${string}`, BigInt(amount), BigInt(timeoutSeconds)],
        });
        return ok({ to: ZEUS_ESCROW_BOT_ADDRESS, data });
      } catch (e) {
        return err("Failed to prepare deposit calldata", e);
      }
    },
  );

  // ── Tool 7: escrow_prepare_confirm ───────────────────────────────────────────
  server.tool(
    "escrow_prepare_confirm",
    "Get the calldata required to confirm successful execution of an escrow agreement and release funds to the executor.",
    {
      agreementId: z.string().describe("Agreement ID (non-negative integer string)"),
      proof: z.string().optional().describe("Optional execution proof — hex string (0x…) or UTF-8 text"),
    },
    async ({ agreementId, proof = "" }) => {
      if (!ZEUS_ESCROW_BOT_ADDRESS) return err("Escrow contract not deployed — set ZEUS_ESCROW_BOT_ADDRESS");
      if (!/^\d+$/.test(agreementId)) return err("agreementId must be a non-negative integer string");
      try {
        const proofBytes: `0x${string}` = proof
          ? proof.startsWith("0x")
            ? (proof as `0x${string}`)
            : `0x${Buffer.from(proof, "utf8").toString("hex")}`
          : "0x";
        const data = encodeFunctionData({
          abi: ZEUS_ESCROW_BOT_ABI,
          functionName: "confirmExecution",
          args: [BigInt(agreementId), proofBytes],
        });
        return ok({ to: ZEUS_ESCROW_BOT_ADDRESS, data });
      } catch (e) {
        return err("Failed to prepare confirm calldata", e);
      }
    },
  );

  return server;
}

// ─── Express integration ──────────────────────────────────────────────────────

/**
 * Mounts the Zeus MCP server at POST /mcp on the given Express app.
 *
 * Uses stateless mode — every request gets a fresh McpServer + transport pair
 * that is disposed after the response. This is correct for pure API-call tools
 * and avoids session-management complexity.
 */
export function connectMCPServer(app: Express): void {
  app.post("/mcp", async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logger.error({ err: e }, "[mcp] unhandled error");
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP server error", detail: String(e) });
      }
    } finally {
      await server.close();
    }
  });

  logger.info("[mcp] server mounted at POST /mcp (stateless, 7 tools)");
}
