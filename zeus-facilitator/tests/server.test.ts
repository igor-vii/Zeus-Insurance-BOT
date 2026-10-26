/**
 * HTTP layer tests: canonical routes, auth, status mapping, boot config.
 * Hermetic: fake RPC, ephemeral port, real node:http server + fetch.
 */
import { ZeusFacilitator } from "../src/server.js";
import { ConfigError, loadConfigFromEnv } from "../src/config.js";
import { toFunctionSelector } from "viem";
import {
  NETWORK,
  TEST_GAS_KEY,
  buildSignedRequest,
  fakeRpc,
} from "./helpers.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Server } from "node:http";

/** RPC fake that passes the balance check: balanceOf -> 1e6, others -> 0. */
function fundedRpc() {
  return fakeRpc({
    async call(_to: string, data: string) {
      if (data.startsWith(toFunctionSelector("balanceOf(address)"))) {
        return "0x" + "00".repeat(30) + "0f4240"; // 1_000_000 atomic units
      }
      return "0x" + "00".repeat(64);
    },
  });
}

const BASE_ENV: NodeJS.ProcessEnv = {
  ZEUS_FACILITATOR_NETWORK: "eip155:196",
  ZEUS_FACILITATOR_RPC_URLS: "https://rpc1.example,https://rpc2.example",
  ZEUS_FACILITATOR_GAS_PRIVATE_KEY: TEST_GAS_KEY,
  NODE_ENV: "development",
  PORT: "3001",
};

async function boot(opts: { apiKey?: string } = {}): Promise<{ url: string; server: Server }> {
  const config = {
    network: NETWORK,
    rpcUrls: ["http://127.0.0.1:1"],
    gasPrivateKey: TEST_GAS_KEY,
    apiKey: opts.apiKey ?? "",
    port: 0,
    nodeEnv: "test",
    receiptTimeoutMs: 5000,
    checkPayerBalance: true,
  };
  const facilitator = new ZeusFacilitator({ config, rpc: fundedRpc(), account: privateKeyToAccount(TEST_GAS_KEY) });
  const server = facilitator.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

afterEach(() => {
  // no global state
});

describe("ZeusFacilitator HTTP contract", () => {
  it("GET /health reports the served network and gas payer", async () => {
    const { url, server } = await boot();
    try {
      const res = await fetch(`${url}/health`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ ok: true, network: "eip155:196", testnet: false });
      expect(typeof body.payer).toBe("string");
    } finally {
      server.close();
    }
  });

  it("POST /verify accepts a canonical v2 request", async () => {
    const { url, server } = await boot();
    try {
      const { request, payer } = await buildSignedRequest();
      const res = await fetch(`${url}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.isValid).toBe(true);
      // viem returns EIP-55 checksummed — compare case-insensitively.
      expect(String(body.payer).toLowerCase()).toBe(payer.toLowerCase());
    } finally {
      server.close();
    }
  });

  it("POST /verify returns isValid:false with an invalidReason for a bad domain", async () => {
    const { url, server } = await boot();
    try {
      const { request } = await buildSignedRequest({ extraName: "Bridged USDC" });
      const res = await fetch(`${url}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await res.json()) as { isValid: boolean; invalidReason?: string };
      expect(res.status).toBe(200);
      expect(body.isValid).toBe(false);
      expect(body.invalidReason).toContain("domain_mismatch");
    } finally {
      server.close();
    }
  });

  it("POST /settle maps a verification refusal to 200 {success:false} (definitive, pre-broadcast)", async () => {
    const { url, server } = await boot();
    try {
      const { request } = await buildSignedRequest({ extraVersion: "1" });
      const res = await fetch(`${url}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await res.json()) as { success: boolean; errorReason?: string; transaction?: string };
      expect(res.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.errorReason).toContain("domain_mismatch");
      // R8-A4: canonical v2 (@x402/core HTTPFacilitatorClient) schema-parses
      // every 2xx settle body — `transaction` is REQUIRED even when nothing
      // was broadcast. Empty string = pre-flight refusal.
      expect(body.transaction).toBe("");
    } finally {
      server.close();
    }
  });

  it("GET /supported advertises the canonical v2 exact kind for the served network", async () => {
    const { url, server } = await boot();
    try {
      const res = await fetch(`${url}/supported`);
      const body = (await res.json()) as {
        kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: unknown }>;
        extensions: string[];
        signers: Record<string, string[]>;
      };
      expect(res.status).toBe(200);
      expect(body.kinds).toHaveLength(1);
      expect(body.kinds[0]).toMatchObject({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:196",
      });
      expect(body.extensions).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("POST /settle settles a valid request end-to-end against the fake RPC", async () => {
    const { url, server } = await boot();
    try {
      const { request } = await buildSignedRequest();
      const res = await fetch(`${url}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await res.json()) as { success: boolean; transaction?: string; transactionHash?: string };
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.transaction).toBe(body.transactionHash);
    } finally {
      server.close();
    }
  });

  it("requires the bearer key when ZEUS_FACILITATOR_API_KEY is configured", async () => {
    const { url, server } = await boot({ apiKey: "s3cr3t" });
    try {
      const { request } = await buildSignedRequest();

      const denied = await fetch(`${url}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${url}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer s3cr3t" },
        body: JSON.stringify(request),
      });
      expect(allowed.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("answers 400 on invalid JSON and 404 on unknown routes", async () => {
    const { url, server } = await boot();
    try {
      const bad = await fetch(`${url}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);

      const missing = await fetch(`${url}/nope`, { method: "GET" });
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("loadConfigFromEnv (fail-fast boot contract)", () => {
  it("loads the happy path with defaults", () => {
    const config = loadConfigFromEnv(BASE_ENV);
    expect(config.network.id).toBe("eip155:196");
    expect(config.rpcUrls).toHaveLength(2);
    expect(config.port).toBe(3001);
    expect(config.checkPayerBalance).toBe(true);
  });

  it("fails without RPC urls", () => {
    expect(() => loadConfigFromEnv({ ...BASE_ENV, ZEUS_FACILITATOR_RPC_URLS: "" })).toThrow(ConfigError);
  });

  it("fails on a malformed gas key", () => {
    expect(() =>
      loadConfigFromEnv({ ...BASE_ENV, ZEUS_FACILITATOR_GAS_PRIVATE_KEY: "0x1234" }),
    ).toThrow(/32-byte/);
  });

  it("refuses a testnet network under NODE_ENV=production (F-113/C-4 lesson)", () => {
    expect(() =>
      loadConfigFromEnv({
        ...BASE_ENV,
        ZEUS_FACILITATOR_NETWORK: "eip155:84532",
        NODE_ENV: "production",
      }),
    ).toThrow(/testnet/);
  });

  it("fails on an unregistered network id", () => {
    expect(() =>
      loadConfigFromEnv({ ...BASE_ENV, ZEUS_FACILITATOR_NETWORK: "eip155:1" }),
    ).toThrow(/registry/);
  });

  it("defaults rpcHeaders to undefined when the env is absent/empty", () => {
    expect(loadConfigFromEnv(BASE_ENV).rpcHeaders).toBeUndefined();
    expect(loadConfigFromEnv({ ...BASE_ENV, ZEUS_FACILITATOR_RPC_HEADERS: "  " }).rpcHeaders).toBeUndefined();
  });

  it("parses ZEUS_FACILITATOR_RPC_HEADERS as a string->string map", () => {
    const config = loadConfigFromEnv({
      ...BASE_ENV,
      ZEUS_FACILITATOR_RPC_HEADERS: JSON.stringify({ "User-Agent": "Mozilla/5.0 Zeus" }),
    });
    expect(config.rpcHeaders).toEqual({ "User-Agent": "Mozilla/5.0 Zeus" });
  });

  it.each([
    ["not-json"],
    ['{"User-Agent": 42}'],
    ['["User-Agent"]'],
  ])("fails fast on a malformed ZEUS_FACILITATOR_RPC_HEADERS (%s)", (raw) => {
    expect(() => loadConfigFromEnv({ ...BASE_ENV, ZEUS_FACILITATOR_RPC_HEADERS: raw })).toThrow(ConfigError);
  });
});
