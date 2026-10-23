import { Router } from "express";
import { ZEUS_TREASURY, USDC_XLAYER, X402_FACILITATOR_URL, x402Routes } from "../config/x402.js";

const router = Router();

/**
 * GET /api/x402/info
 *
 * Public discovery endpoint so AI agents can learn payment terms
 * before hitting a protected route. No x402 payment required here.
 *
 * MUST advertise the SAME network/asset/facilitator the payment
 * middleware actually enforces (eip155:196 / USDC on X Layer / Zeus
 * facilitator). Advertising base-sepolia here while guarding routes
 * with eip155:196 would make every agent build an invalid payment.
 */
router.get("/info", (_req, res) => {
  const protectedEndpoints = Object.entries(x402Routes).map(([path, cfg]) => {
    const routeCfg = cfg as { price: string; network: string; config?: { description?: string } };
    return {
      method: "POST",
      path,
      price: routeCfg.price,
      network: routeCfg.network,
      description: routeCfg.config?.description ?? "",
    };
  });

  res.json({
    x402Supported: true,
    // CAIP-2 chain identifier — X Layer mainnet (chainId 196).
    network: "eip155:196",
    chainId: 196,
    asset: USDC_XLAYER,
    payTo: ZEUS_TREASURY || null,
    // Zeus-operated facilitator. The public default (x402.org) does not
    // support X Layer, so it is never advertised as a fallback here.
    facilitator: X402_FACILITATOR_URL || null,
    protectedEndpoints,
  });
});

export default router;
