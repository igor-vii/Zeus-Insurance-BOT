import type { Resource, RoutesConfig } from "x402/types";
import type { Address } from "viem";

/**
 * Treasury wallet that receives x402 API-fee payments (USDC on X Layer).
 * Set ZEUS_TREASURY in env vars — if missing, middleware is disabled.
 */
export const ZEUS_TREASURY = (process.env["ZEUS_TREASURY"] ?? "") as Address;

/**
 * USDC contract on X Layer Mainnet (chainId 196)
 */
export const USDC_XLAYER = "0x74b7f16337b8972027f6196a17a631ac6de26d22";

/**
 * x402 facilitator used by BOTH the x402-express payment middleware (below)
 * and the Secretariat settlement adapter.
 *
 * The default public facilitator (x402.org) does NOT support X Layer, so on
 * mainnet this MUST point at a Zeus-operated facilitator. Accepts either env
 * name; empty string = fall back to the library default (fine for base-sepolia
 * testing, NOT for eip155:196 production traffic).
 */
export const X402_FACILITATOR_URL: Resource | "" =
  (process.env["X402_FACILITATOR_URL"] ?? process.env["ZEUS_FACILITATOR_URL"] ?? "").trim() as
    Resource | "";

/**
 * USDC contract on Base Sepolia (legacy, kept for reference)
 */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Routes protected by x402.
 *
 * API fee is ENABLED at the documented starter price ($0.001).
 * Requires ZEUS_TREASURY to be set; when it is missing the middleware
 * stays disabled entirely (see app.ts).
 *
 * IMPORTANT (R3/A7): the price MUST be >= $0.0001 — x402's moneySchema
 * rejects "$0", and a rejected price makes the middleware throw on EVERY
 * request to a protected route (HTTP 500). Do not set price back to "$0".
 *
 * - /api/insurance/prepare-buy  → prepare policy calldata for AI agents.
 *   The insurance premium itself is collected on-chain when the agent
 *   submits the transaction. This fee covers API infrastructure costs.
 *
 * - /api/escrow/create  → create an escrow agreement.
 */
export const x402Routes: RoutesConfig = {
  "/api/insurance/prepare-buy": {
    price: "$0.001",
    network: "eip155:196",
    config: {
      description: "Zeus Insurance — prepare policy calldata for AI agents",
    },
  },
  "/api/escrow/create": {
    price: "$0.001",
    network: "eip155:196",
    config: {
      description: "Zeus Escrow — create an escrow agreement on X Layer",
    },
  },
};
