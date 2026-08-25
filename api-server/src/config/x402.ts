import type { RoutesConfig } from "x402/types";
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
 * USDC contract on Base Sepolia (legacy, kept for reference)
 */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Routes protected by x402.
 *
 * NOTE: API fee is DISABLED for now (price set to $0).
 * When ready to enable, change price to "$0.001" and ensure
 * ZEUS_TREASURY env var is set on Railway.
 *
 * - /api/insurance/prepare-buy  → prepare policy calldata for AI agents.
 *   The insurance premium itself is collected on-chain when the agent
 *   submits the transaction. This fee covers API infrastructure costs.
 *
 * - /api/escrow/create  → create an escrow agreement.
 */
export const x402Routes: RoutesConfig = {
  "/api/insurance/prepare-buy": {
    price: "$0",
    network: "eip155:196",
    config: {
      description: "Zeus Insurance — prepare policy calldata for AI agents",
    },
  },
  "/api/escrow/create": {
    price: "$0",
    network: "eip155:196",
    config: {
      description: "Zeus Escrow — create an escrow agreement on X Layer",
    },
  },
};
