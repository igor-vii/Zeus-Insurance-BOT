#!/usr/bin/env node
/**
 * argus-live-mock.mjs — the adversarial resource server ("Argus") for the
 * LIVE S1–S7 Secretariat matrix. Same topology as api-server/e2e/r6-argus-e2e.mjs
 * (challenge discovery /resource, seller /seller, mock facilitator /settle,
 * mock JSON-RPC /rpc) plus what the live fault semantics need:
 *
 *   - seller delivery modes keyed off the forwarded request body's `prompt`
 *     (Secretariat forwards the original request payload to ZEUS_SELLER_URL):
 *       prompt contains "S4" → seller NEVER responds (canonical hang)
 *       prompt contains "S7" → seller sends a partial HTTP response and the
 *                              socket is destroyed ("sent but never received")
 *       anything else        → honest 200 {result: "delivered"}
 *   - facilitator keeps a per-authorization-nonce settle counter and exposes
 *     GET /facilitator/stats — the double-spend probe (any nonce with
 *     settleCalls > 1 means the SUT attempted a second settlement for the
 *     same on-chain authorization)
 *   - facilitator is chain-faithful (Lab Block D finding F1): EIP-3009
 *     authorizationState is single-use — a second /settle with the same
 *     nonce is rejected 409 authorization_used (found by the B-BS-17-live
 *     replay canary on its first run; same contract as the r6 gate mock)
 */

import { createRequire } from "node:module";
// ESM resolution is relative to THIS file, not the cwd — pnpm only links
// deps where they are declared, so pull express (api-server) and viem
// (argus lab) through their owning package's require context.
const requireApi = createRequire("/home/z/my-project/audit-repo/api-server/package.json");
const requireArgus = createRequire("/home/z/my-project/audit-repo/tests/argus/package.json");
const express = requireApi("express");
const { keccak256, toBytes } = requireArgus("viem");

const PORT = Number(process.env.ARGUS_MOCK_PORT ?? 9977);

const SELLER_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc";
const USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // base-sepolia USDC
const CHAIN_ID = 84532;
const NETWORK = "base-sepolia";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
const CLIENT_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const HONEST_AMOUNT = "10000"; // 0.01 USDC

// ---------------------------------------------------------------------------
const settledTx = new Map(); // txHash → {from,to,value,nonce}
const settleCalls = [];      // {nonce, payTo, value, at}
const usedNonces = new Map(); // nonce → txHash (EIP-3009 single-use authorizationState)

function honestChallenge() {
  return {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      amount: HONEST_AMOUNT,
      asset: USDC_ASSET,
      payTo: SELLER_ADDR,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    }],
  };
}

const app = express();
app.use(express.json());

// --- challenge discovery (Secretariat fetches the poisoned-ish target) ------
app.post("/resource", (req, res) => {
  const challenge = honestChallenge();
  const body64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
  res.status(402).set("PAYMENT-REQUIRED", body64).json(challenge);
});
app.get("/resource", (req, res) => {
  const challenge = honestChallenge();
  const body64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
  res.status(402).set("PAYMENT-REQUIRED", body64).json(challenge);
});

// --- seller delivery (post-settlement forward lands here) -------------------
const sellerStats = { delivered: 0, hangs: 0, lostResponses: 0 };
// Seller behavior control — the Secretariat forwards an EMPTY body to the
// seller (requestBody is never provided by initiateExecution's caller), so
// per-scenario modes are set via this endpoint by the runner instead of the
// request content.
let sellerMode = "honest";
app.post("/__control", (req, res) => {
  sellerMode = String(req.body?.mode ?? "honest");
  console.log(`[control] sellerMode=${sellerMode}`);
  res.json({ ok: true, sellerMode });
});

app.post("/seller", (req, res) => {
  console.log(`[seller] hit: mode=${sellerMode} body=${JSON.stringify(req.body ?? null).slice(0, 120)}`);
  const prompt = sellerMode === "honest" ? "" : sellerMode;
  if (prompt.includes("S4")) {
    sellerStats.hangs += 1;
    // Canonical infinite hang: never respond. The response object is kept
    // open; Secretariat's seller timeout decides the outcome.
    return;
  }
  if (prompt.includes("S7")) {
    sellerStats.lostResponses += 1;
    // Seller DID send (bytes left the seller), but the edge destroys the
    // response before the client can parse it.
    res.status(200);
    res.set("content-type", "application/json");
    res.write('{"result":"deli');
    // flush bytes, then kill the connection
    setTimeout(() => {
      try { res.socket?.destroy(); } catch { /* already gone */ }
    }, 50);
    return;
  }
  sellerStats.delivered += 1;
  res.status(200).json({ result: "delivered", echo: req.body ?? null });
});

// --- mock facilitator --------------------------------------------------------
// F-112/C-1 (external audit 2026-10-26): canonical x402 v2 remote-facilitator
// wire — { x402Version, paymentPayload, paymentRequirements }. The legacy
// {paymentHeader, resource, network} envelope is gone.
app.post("/facilitator/settle", (req, res) => {
  const txHash = `0xsettle${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
  let authz = {
    from: CLIENT_ADDR.toLowerCase(),
    to: SELLER_ADDR,
    value: HONEST_AMOUNT,
    nonce: "0x" + "0".repeat(64),
  };
  try {
    const pp = req.body?.paymentPayload;
    const reqs = req.body?.paymentRequirements;
    if (!pp || !reqs || typeof req.body?.x402Version !== "number") {
      res.status(400).json({ success: false, errorReason: "malformed_settle_request" });
      return;
    }
    authz = {
      from: String(pp?.payload?.authorization?.from ?? authz.from).toLowerCase(),
      to: String(pp?.payload?.authorization?.to ?? authz.to).toLowerCase(),
      value: String(pp?.payload?.authorization?.value ?? authz.value),
      nonce: String(pp?.payload?.authorization?.nonce ?? authz.nonce).toLowerCase(),
    };
  } catch {
    res.status(400).json({ success: false, errorReason: "malformed_settle_request" });
    return;
  }
  settleCalls.push({ nonce: authz.nonce, payTo: authz.to, value: authz.value, at: Date.now() });
  // Chain-faithful replay guard (Lab Block D finding F1 — the mock must
  // mirror the rail's real contract): EIP-3009 authorizationState is
  // single-use, so a second /settle with the same nonce MUST be rejected.
  // Found by the B-BS-17-live canary on its first sandbox run: the r6 gate
  // mock had the guard, this live driver did not.
  if (usedNonces.has(authz.nonce)) {
    res.status(409).json({
      success: false,
      errorReason: "authorization_used",
      error: `authorization nonce already used by tx ${usedNonces.get(authz.nonce)}`,
    });
    return;
  }
  settledTx.set(txHash.toLowerCase(), authz);
  usedNonces.set(authz.nonce, txHash);
  res.status(200).json({ success: true, transactionHash: txHash, network: NETWORK });
});
app.post("/facilitator/verify", (_req, res) => res.json({ isValid: true }));
app.get("/facilitator/stats", (_req, res) => {
  const perNonce = new Map();
  for (const c of settleCalls) perNonce.set(c.nonce, (perNonce.get(c.nonce) ?? 0) + 1);
  res.json({
    totalSettleCalls: settleCalls.length,
    distinctNonces: perNonce.size,
    doubleSettleAttempts: Array.from(perNonce.entries()).filter(([, n]) => n > 1).length,
    perNonce: Array.from(perNonce.entries()).map(([nonce, calls]) => ({ nonce, calls })),
    settleCalls,
    sellerStats,
  });
});

// --- mock JSON-RPC -----------------------------------------------------------
const rpc = (method, params) => {
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_blockNumber") return "0x110";
  if (method === "eth_getBlockByNumber") return { number: "0x110" };
  if (method === "eth_getLogs") return [];
  if (method === "eth_getTransactionReceipt") {
    const txHash = String(params?.[0] ?? "").toLowerCase();
    const authz = settledTx.get(txHash);
    if (!authz) return null;
    const pad = (addr) => "0x" + "0".repeat(24) + addr.replace(/^0x/, "");
    return {
      blockNumber: "0x100",
      status: "0x1",
      logs: [
        {
          address: USDC_ASSET.toLowerCase(),
          topics: [TRANSFER_TOPIC, pad(authz.from), pad(authz.to)],
          data: "0x" + BigInt(authz.value).toString(16).padStart(64, "0"),
          logIndex: "0x0",
        },
        {
          address: USDC_ASSET.toLowerCase(),
          topics: [AUTHORIZATION_USED_TOPIC, pad(authz.from), authz.nonce],
          data: "0x",
          logIndex: "0x1",
        },
      ],
    };
  }
  return null;
};
app.post("/rpc", (req, res) => {
  const { id, method, params } = req.body ?? {};
  res.status(200).json({ jsonrpc: "2.0", id: id ?? 1, result: rpc(method, params) });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "127.0.0.1", () => console.log(`[argus-live-mock] listening on 127.0.0.1:${PORT}`));
