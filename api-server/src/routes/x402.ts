import { Router } from "express";
import { ZEUS_TREASURY, USDC_BASE_SEPOLIA, x402Routes } from "../config/x402.js";

const router = Router();

/**
 * GET /api/x402/info
 *
 * Public discovery endpoint so AI agents can learn payment terms
 * before hitting a protected route. No x402 payment required here.
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
    network: "base-sepolia",
    asset: USDC_BASE_SEPOLIA,
    payTo: ZEUS_TREASURY,
    facilitator: "https://x402.org/facilitator",
    protectedEndpoints,
  });
});

export default router;
