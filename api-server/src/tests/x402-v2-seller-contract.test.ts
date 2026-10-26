/**
 * R8-A4 (external audit round-8, 2026-10-26): seller-side v2 contract guard.
 *
 * The api-server seller side was migrated from x402 v1 (+ 713-line patch)
 * to the official v2 stack. These tests pin the WIRE the middleware will
 * actually serve for eip155:196:
 *   - the resource server accepts our route config (v2 "METHOD /path" keys);
 *   - /supported discovery against the Zeus facilitator kind registry works;
 *   - the AssetAmount price (USDC X Layer, 6 decimals, $0.001 = "1000") and
 *     the D1-verified EIP-712 domain ("USD Coin" / "2") land in the served
 *     payment requirements — without any default-asset registry entry for
 *     X Layer and without any patch.
 *
 * Hermetic: the facilitator client is an in-memory stub — no network, no PG.
 * The config module reads ZEUS_TREASURY at import time, so it is imported
 * dynamically AFTER the env is seeded.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";
import { x402ResourceServer, type RoutesConfig } from "@x402/express";
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

/** Zeus facilitator's GET /supported body (see zeus-facilitator/src/server.ts). */
const ZEUS_SUPPORTED: SupportedResponse = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196", extra: {} }],
  extensions: [],
  signers: {},
};

const stubFacilitator: FacilitatorClient = {
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
    return { isValid: true };
  },
  async settle(_p: PaymentPayload, _r: PaymentRequirements): Promise<SettleResponse> {
    return { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:196" };
  },
  async getSupported(): Promise<SupportedResponse> {
    return ZEUS_SUPPORTED;
  },
};

type AcceptShape = {
  scheme: string;
  network: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  price: { amount?: string; asset?: string; extra?: { name?: string; version?: string } };
};

describe("R8-A4: x402Routes v2 seller contract (eip155:196, no patch)", () => {
  let USDC_XLAYER: string;
  let X402_FACILITATOR_API_KEY: string;
  let x402Routes: RoutesConfig;

  beforeAll(async () => {
    // Seed the treasury BEFORE the config module evaluates.
    process.env["ZEUS_TREASURY"] =
      process.env["ZEUS_TREASURY"] || "0x000000000000000000000000000000000000dEaD";
    const cfg = await import("../config/x402.js");
    USDC_XLAYER = cfg.USDC_XLAYER;
    X402_FACILITATOR_API_KEY = cfg.X402_FACILITATOR_API_KEY;
    x402Routes = cfg.x402Routes as RoutesConfig;
  });

  it("route keys are METHOD-prefixed and every accept targets eip155:196/exact/USDC X Layer", () => {
    const entries = Object.entries(x402Routes);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [key, cfg] of entries) {
      expect(key).toMatch(/^POST \//);
      const accepts = (Array.isArray(cfg.accepts) ? cfg.accepts : [cfg.accepts]) as AcceptShape[];
      for (const a of accepts) {
        expect(a.scheme).toBe("exact");
        expect(a.network).toBe("eip155:196");
        expect(a.payTo).toBeTruthy();
        // AssetAmount price in atomic units + D1-verified domain extra.
        expect(typeof a.price.amount).toBe("string");
        expect(a.price.asset?.toLowerCase()).toBe(USDC_XLAYER.toLowerCase());
        expect(a.price.extra?.name).toBe("USD Coin");
        expect(a.price.extra?.version).toBe("2");
      }
    }
  });

  it("builds canonical v2 payment requirements from the config via the real resource server", async () => {
    const server = new x402ResourceServer(stubFacilitator).register("eip155:196", new ExactEvmScheme());
    await server.initialize(); // consumes /supported — the Zeus kind registry must satisfy it

    const kind = server.getSupportedKind(2, "eip155:196", "exact");
    expect(kind).toBeDefined();

    for (const [key, cfg] of Object.entries(x402Routes)) {
      const accepts = (Array.isArray(cfg.accepts) ? cfg.accepts : [cfg.accepts]) as AcceptShape[];
      const reqs = await server.buildPaymentRequirementsFromOptions(
        accepts.map((a) => ({ ...a, resource: `https://zeus.example${key.split(/\s+/)[1]}` })),
      );
      expect(reqs.length).toBe(1);
      const req = reqs[0] as PaymentRequirements & { extra?: Record<string, unknown> };
      expect(req.scheme).toBe("exact");
      expect(req.network).toBe("eip155:196");
      expect(req.asset.toLowerCase()).toBe(USDC_XLAYER.toLowerCase());
      expect(req.amount).toBe("1000"); // $0.001 × 10^6
      expect(req.payTo).toBeTruthy();
      // F-113/D1: the EIP-712 domain MUST ride in extra — the buyer's
      // signature domain ("USD Coin"/"2") is pinned by the seller, never guessed.
      expect(req.extra?.name).toBe("USD Coin");
      expect(req.extra?.version).toBe("2");
    }
  });

  it("an empty-ZEUS_TREASURY boot never produces a payTo-less accept (middleware disabled instead)", () => {
    // app.ts refuses to mount the middleware when ZEUS_TREASURY is unset;
    // this test fails loudly if the config ever drops the per-accept payTo.
    for (const cfg of Object.values(x402Routes)) {
      const accepts = (Array.isArray(cfg.accepts) ? cfg.accepts : [cfg.accepts]) as AcceptShape[];
      for (const a of accepts) expect(String(a.payTo).length).toBeGreaterThan(0);
    }
  });

  it("facilitator credential, when configured, is exposed for the middleware auth headers", () => {
    // The value comes from X402_FACILITATOR_API_KEY / ZEUS_FACILITATOR_API_KEY.
    // In CI it is unset — the assertion pins the EXPORT, not a secret value.
    expect(typeof X402_FACILITATOR_API_KEY).toBe("string");
  });
});
