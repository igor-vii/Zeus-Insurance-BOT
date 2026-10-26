import { Router } from "express";
import type { RouteConfig } from "@x402/core/server";
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
 *
 * R8-A4: routes are canonical x402 v2 ("METHOD /path" keys, accepts[]
 * with AssetAmount prices) — advertised verbatim so a client can build
 * the EIP-712 payload from this response without re-deriving anything.
 */
router.get("/info", (_req, res) => {
  const protectedEndpoints = Object.entries(x402Routes).map(([key, cfg]) => {
    const route = cfg as RouteConfig;
    const [method, path] = key.includes(" ") ? key.split(/\s+/) : ["*", key];
    const accept = Array.isArray(route.accepts) ? route.accepts[0] : route.accepts;
    return {
      method: method === "*" ? "ANY" : method,
      path,
      scheme: accept.scheme,
      network: accept.network,
      // AssetAmount in atomic units + the EIP-712 domain extra — the exact
      // paymentRequirements shape the middleware will serve in its 402.
      price: accept.price,
      payTo: accept.payTo || ZEUS_TREASURY || null,
      maxTimeoutSeconds: accept.maxTimeoutSeconds ?? null,
      description: route.description ?? "",
    };
  });

  res.json({
    x402Supported: true,
    x402Version: 2,
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
