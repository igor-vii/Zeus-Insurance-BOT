/**
 * Zeus facilitator — HTTP server (node:http, zero framework deps).
 *
 * Routes (canonical x402 v2 remote-facilitator contract, identical to the
 * F-112 mock enforcement and the Secretariat client; official x402 v1
 * envelopes (x402@1.x / x402-express@1.x — what api-server pins) are
 * normalized into the canonical shape before verification):
 *   POST /verify  {x402Version, paymentPayload, paymentRequirements}
 *               → 200 {isValid:true, payer} | {isValid:false, invalidReason}
 *   POST /settle  same body
 *               → 200 {success:true, transaction, transactionHash, network, payer}
 *               | 200 {success:false, errorReason, transaction:""}        (definitive)
 *               | 409 {success:false, errorReason:duplicate_*}            (nonce guard)
 *               | 503 {success:false, errorReason:broadcast_unavailable}  (ambiguous)
 *               | 504 {success:false, errorReason:receipt_timeout}        (ambiguous)
 *   GET  /supported → {kinds:[{x402Version:2, scheme:"exact", network}], extensions:[]}
 *   GET  /health → {ok:true, network, testnet}
 *
 * When ZEUS_FACILITATOR_API_KEY is set, /verify and /settle require
 * `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { defineChain } from "viem";
import type { FacilitatorConfig } from "./config.js";
import type { ChainRpc } from "./rpc.js";
import { createViemRpc, SettleExecutor } from "./settle.js";
import { verifyRequest } from "./verify.js";
import type { FacilitatorRequest, SettleFailure, SettleSuccess, VerifyResponse } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;

export interface FacilitatorDeps {
  readonly config: FacilitatorConfig;
  readonly rpc: ChainRpc;
  readonly account: PrivateKeyAccount;
}

export class ZeusFacilitator {
  private readonly executor: SettleExecutor;

  constructor(private readonly deps: FacilitatorDeps) {
    this.executor = new SettleExecutor(
      deps.rpc,
      deps.account,
      defineChain({
        id: deps.config.network.chainId,
        name: deps.config.network.id,
        nativeCurrency: { name: deps.config.network.gasSymbol, symbol: deps.config.network.gasSymbol, decimals: 18 },
        rpcUrls: { default: { http: [...deps.config.rpcUrls] } },
      }),
      deps.config.network,
      deps.config.receiptTimeoutMs,
    );
  }

  get accountAddress(): string {
    return this.deps.account.address;
  }

  private authorized(req: IncomingMessage): boolean {
    const apiKey = this.deps.config.apiKey;
    if (!apiKey) return true;
    const auth = req.headers["authorization"] ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const header = req.headers["x-api-key"];
    const xApiKey = Array.isArray(header) ? header[0] : header;
    return bearer === apiKey || (xApiKey ?? "") === apiKey;
  }

  private static readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new BodyTooLargeError());
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private async handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) return this.sendJson(res, 401, { error: "unauthorized" });
    let request: FacilitatorRequest;
    try {
      request = JSON.parse(await ZeusFacilitator.readBody(req)) as FacilitatorRequest;
    } catch {
      return this.sendJson(res, 400, { error: "invalid_json" });
    }
    try {
      const outcome = await verifyRequest(request, this.deps.config.network, this.deps.rpc, {
        checkPayerBalance: this.deps.config.checkPayerBalance,
      });
      const body: VerifyResponse = outcome.ok
        ? { isValid: true, payer: outcome.payer }
        : { isValid: false, invalidReason: `${outcome.reason}: ${outcome.detail}` };
      return this.sendJson(res, 200, body);
    } catch (err) {
      if (err instanceof Error && err.name === "RpcUnavailableError") {
        return this.sendJson(res, 503, { error: "rpc_unavailable", detail: err.message });
      }
      return this.sendJson(res, 500, { error: "internal", detail: err instanceof Error ? err.message : "unknown" });
    }
  }

  private async handleSettle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) return this.sendJson(res, 401, { error: "unauthorized" });
    let request: FacilitatorRequest;
    try {
      request = JSON.parse(await ZeusFacilitator.readBody(req)) as FacilitatorRequest;
    } catch {
      return this.sendJson(res, 400, { error: "invalid_json" });
    }
    try {
      const outcome = await verifyRequest(request, this.deps.config.network, this.deps.rpc, {
        checkPayerBalance: this.deps.config.checkPayerBalance,
      });
      if (!outcome.ok) {
        const body: SettleFailure = {
          success: false,
          errorReason: `${outcome.reason}: ${outcome.detail}`,
          network: this.deps.config.network.id,
          // R8-A4: canonical v2 requires `transaction` on every 2xx settle
          // body — nothing was broadcast here, hence the empty hash.
          transaction: "",
        };
        return this.sendJson(res, 200, body);
      }
      const signature = request.paymentPayload.payload.signature;
      const settle = await this.executor.settle(outcome.payer, outcome.authorization, signature as `0x${string}`);
      return this.sendJson(res, settle.httpStatus, settle.body);
    } catch (err) {
      if (err instanceof Error && err.name === "RpcUnavailableError") {
        return this.sendJson(res, 503, { error: "rpc_unavailable", detail: err.message });
      }
      return this.sendJson(res, 500, { error: "internal", detail: err instanceof Error ? err.message : "unknown" });
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  /** Build the request handler (exposed for tests). */
  handler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      try {
        if (req.method === "GET" && (url === "/health" || url === "/")) {
          return this.sendJson(res, 200, {
            ok: true,
            network: this.deps.config.network.id,
            testnet: this.deps.config.network.testnet,
            payer: this.deps.account.address,
          });
        }
        if (req.method === "GET" && url === "/supported") {
          // R8-A4: canonical v2 discovery endpoint. The @x402/* resource
          // server (api-server seller middleware) refuses to build payment
          // requirements until it has fetched supported kinds from the
          // facilitator (x402ResourceServer.initialize → GET /supported).
          // Public on purpose: it advertises capabilities, nothing secret.
          return this.sendJson(res, 200, {
            kinds: [
              {
                x402Version: 2,
                scheme: "exact",
                network: this.deps.config.network.id,
                extra: {},
              },
            ],
            extensions: [],
            signers: {},
          });
        }
        if (req.method === "POST" && url === "/verify") return await this.handleVerify(req, res);
        if (req.method === "POST" && url === "/settle") return await this.handleSettle(req, res);
        return this.sendJson(res, 404, { error: "not_found" });
      } catch (err) {
        if (err instanceof BodyTooLargeError) return this.sendJson(res, 413, { error: "body_too_large" });
        return this.sendJson(res, 500, { error: "internal", detail: err instanceof Error ? err.message : "unknown" });
      }
    };
  }

  /** Convenience boot for `node dist/server.js`. */
  listen(port = this.deps.config.port): Server {
    const server = createServer(this.handler());
    server.listen(port);
    return server;
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

/** Production boot entry (node dist/server.js). */
export function main(): void {
  // Late imports keep unit tests hermetic: env loading + viem RPC construction
  // only happen on a real boot.
  void (async () => {
    const { loadConfigFromEnv } = await import("./config.js");
    const { createViemRpc: buildRpc } = await import("./settle.js");
    const config = loadConfigFromEnv();
    const rpc = buildRpc(config.rpcUrls, defineChain({
      id: config.network.chainId,
      name: config.network.id,
      nativeCurrency: { name: config.network.gasSymbol, symbol: config.network.gasSymbol, decimals: 18 },
      rpcUrls: { default: { http: [...config.rpcUrls] } },
    }));
    const account = privateKeyToAccount(config.gasPrivateKey);
    const facilitator = new ZeusFacilitator({ config, rpc, account });
    const server = facilitator.listen();
    console.log(
      `[zeus-facilitator] listening on :${config.port} network=${config.network.id} gasPayer=${account.address} auth=${config.apiKey ? "bearer" : "none"}`,
    );
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })().catch((err) => {
    console.error(`[zeus-facilitator] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

// ESM entrypoint: run directly -> boot.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  main();
}
