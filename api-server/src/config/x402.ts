import type { RoutesConfig } from "@x402/core/server";
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
 * x402 facilitator used by BOTH the @x402/express payment middleware (below)
 * and the Secretariat settlement adapter.
 *
 * The default public facilitator (x402.org) does NOT support X Layer, so on
 * mainnet this MUST point at a Zeus-operated facilitator. Accepts either env
 * name; empty string = fall back to the library default (fine for base-sepolia
 * testing, NOT for eip155:196 production traffic).
 */
export const X402_FACILITATOR_URL: string =
  (process.env["X402_FACILITATOR_URL"] ?? process.env["ZEUS_FACILITATOR_URL"] ?? "").trim();

/**
 * Bearer credential the @x402/express middleware sends to the Zeus-operated
 * facilitator when it enforces ZEUS_FACILITATOR_API_KEY on /verify, /settle
 * and /supported. Accepts either env name; empty = send no auth header
 * (valid when the facilitator runs without an API key, e.g. dev rigs).
 */
export const X402_FACILITATOR_API_KEY: string =
  (process.env["X402_FACILITATOR_API_KEY"] ?? process.env["ZEUS_FACILITATOR_API_KEY"] ?? "").trim();

/**
 * USDC contract on Base Sepolia (legacy, kept for reference)
 */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * R8-A4 (external audit round-8, 2026-10-26): the seller side was migrated
 * from x402 v1 (`x402@1.2.0` + a 713-line patch that injected "eip155:196"
 * into the v1 network enum) to the official v2 stack (`@x402/core` +
 * `@x402/express` + `@x402/evm`). v2 is CAIP-2-native, so `eip155:196`
 * needs NO patch — and since the v2 default-asset registry has no entry for
 * X Layer, the USDC asset, amount and EIP-712 domain are declared EXPLICITLY
 * per route as an AssetAmount. This also pins the domain ("USD Coin" / "2")
 * that was verified ON-CHAIN against the X Layer USDC DOMAIN_SEPARATOR()
 * (D1 = FACT, see zeus-secretariat/docs/UNVERIFIED_ASSUMPTIONS.md).
 *
 * v2 route keys are "METHOD /path" (a bare "/path" would match any method).
 * Price: the documented starter fee $0.001 with USDC's 6 decimals
 * = "1000" atomic units. The price MUST stay >= $0.0001 — a zero price is
 * rejected by x402's money schema and makes the middleware throw on EVERY
 * request to a protected route (HTTP 500). Do not set it back to "$0".
 *
 * - /api/insurance/prepare-buy  → prepare policy calldata for AI agents.
 *   The insurance premium itself is collected on-chain when the agent
 *   submits the transaction. This fee covers API infrastructure costs.
 *
 * - /api/escrow/create  → create an escrow agreement.
 */
export const X402_USDC_XLAYER_PRICE = {
  amount: "1000",
  asset: USDC_XLAYER,
  extra: { name: "USD Coin", version: "2" },
} as const;

export const X402_MAX_TIMEOUT_SECONDS = 60;

export const x402Routes: RoutesConfig = {
  "POST /api/insurance/prepare-buy": {
    accepts: [
      {
        scheme: "exact",
        price: X402_USDC_XLAYER_PRICE,
        network: "eip155:196",
        payTo: ZEUS_TREASURY,
        maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
      },
    ],
    description: "Zeus Insurance — prepare policy calldata for AI agents",
  },
  "POST /api/escrow/create": {
    accepts: [
      {
        scheme: "exact",
        price: X402_USDC_XLAYER_PRICE,
        network: "eip155:196",
        payTo: ZEUS_TREASURY,
        maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
      },
    ],
    description: "Zeus Escrow — create an escrow agreement on X Layer",
  },
};
