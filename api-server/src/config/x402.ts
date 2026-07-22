import type { RoutesConfig } from "x402/types";
import type { Address } from "viem";

/**
 * Treasury wallet that receives x402 API-fee payments (USDC on Base Sepolia).
 * Set ZEUS_TREASURY in env vars — if missing, middleware is disabled.
 */
export const ZEUS_TREASURY = (process.env["ZEUS_TREASURY"] ?? "") as Address;

/**
 * USDC contract on Base Sepolia
 */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Routes protected by x402.
 *
 * - /api/insurance/prepare-buy  → 0.001 USDC API fee per calldata request.
 *   Agents pay this once to receive signed calldata; the insurance premium
 *   itself is collected on-chain when the agent submits the transaction.
 */
export const x402Routes: RoutesConfig = {
  "/api/insurance/prepare-buy": {
    price: "$0.001",
    network: "base-sepolia",
    config: {
      description: "Zeus Insurance — prepare policy calldata for AI agents",
    },
  },
  "/api/escrow/create": {
    price: "$0.001",
    network: "base-sepolia",
    config: {
      description: "Zeus Escrow — automatically create an escrow agreement on Base Mainnet",
    },
  },
};
