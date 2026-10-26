/**
 * R6: Adversarial E2E — real signing client vs Argus (adversarial resource
 * server), driven through the LIVE Secretariat (/v1 API on :8080) with
 * PostgreSQL observation assertions at the end.
 *
 * Topology:
 *   Client (viem EOA, EIP-3009 signing — the x402 foundation primitive)
 *     → Secretariat :8080  /v1/requests, /v1/requests/:id/payment
 *        → Argus :9977  (challenge discovery — poisoned per scenario)
 *        → Argus /facilitator/settle (mock settlement)
 *        → Argus /seller (resource delivery after settlement)
 *        → Argus /rpc (mock JSON-RPC: confirms the settlement tx — 12 confs)
 *        → PostgreSQL  (evidence: reconciliation_observations + payment_intents JSONB)
 *
 * Scenario catalog (canonical set assembled for R6 — the repo docs contain no
 * B-BS/S8/S9 catalog, so the mapping below IS the canonical definition):
 *
 *   S8        honest end-to-end pass            → COMPLETED, settlement recorded
 *   S9        idempotent retry (same payload)   → 200, same txHash, no double payment
 *   ---- Stage A: poisoned challenge (policy layer must reject → 422 REQUEST_REJECTED)
 *   B-BS-01   payTo swap to attacker            → allowedSellers guard
 *   B-BS-02   amount inflation above maxPrice   → maxPrice guard
 *   B-BS-03   asset swap to foreign token       → allowedAssets guard
 *   B-BS-04   network swap                      → allowedNetworks guard
 *   ---- Stage B: poisoned payment payload (verifier layer must reject → 422 + code)
 *   B-BS-05   x402Version != 2                  → X402_VERSION_MISMATCH
 *   B-BS-06   accepted.network mismatch         → NETWORK_MISMATCH
 *   B-BS-07   accepted.asset mismatch           → ASSET_MISMATCH
 *   B-BS-08   accepted.payTo mismatch           → PAY_TO_MISMATCH
 *   B-BS-09   accepted.amount mismatch          → VALUE_MISMATCH
 *   B-BS-10   authorization.from mismatch       → AUTHORIZER_MISMATCH
 *   B-BS-11   authorization.to mismatch         → PAY_TO_MISMATCH
 *   B-BS-12   authorization.value mismatch      → VALUE_MISMATCH
 *   B-BS-13   authorization.nonce mismatch      → NONCE_MISMATCH
 *   B-BS-14   authorization.validBefore drift   → VALID_BEFORE_MISMATCH
 *   B-BS-15   forged signature (zero bytes)     → INVALID_SIGNATURE
 *   ---- Stage C: post-money adversarial — money ALREADY settled. The guard
 *   here is honest classification + recovery + ledger integrity, NOT a policy
 *   rejection. Numbering continues the B-BS block (adversarial seller);
 *   B-BS-18 adapts the Argus Lab Block D S11 "Over Budget" fiat scenario to
 *   x402 rails (the Lab's own S10 "Delivery Uncertain" maps to the recover
 *   leg of B-BS-16 and to the live-matrix S4/S7 evidence).
 *   B-BS-16   paid but not delivered            → two legs:
 *             refuse:  seller 500 on every attempt → R7-B2: outcome UNKNOWN,
 *                      bounded same-key retries (≤3), job UNRESOLVABLE, never
 *                      a fake COMPLETED, exactly 1 settlement (no re-charge)
 *             recover: response lost mid-flight → DELIVERY_UNKNOWN →
 *                      recovery retry with the SAME idempotency key →
 *                      delivered, exactly 1 settlement across 2 attempts
 *                      (recovery must never re-charge)
 *   B-BS-17   replay of a used EIP-3009 nonce   → chain-faithful facilitator
 *             rejects the second settle (single-use nonce); ledger keeps
 *             exactly one settlement; the Secretariat is deliberately NOT in
 *             the replay loop (a real double-spend bypasses it)
 *   B-BS-18   over budget (client policy probe) → two legs:
 *             over:     HONEST challenge priced above policy.maxPrice →
 *                       422 REQUEST_REJECTED pre-money, ZERO settle
 *                       dispatches (rail-side counter proof)
 *             boundary: challenge priced EXACTLY maxPrice → inclusive
 *                       boundary completes with one settle + one delivery
 */

import express from "express";
import pg from "pg";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SECRETARIAT = process.env.SECRETARIAT_URL ?? "http://127.0.0.1:8080";
const ARGUS_PORT = 9977;
const ARGUS = `http://127.0.0.1:${ARGUS_PORT}`;

const CLIENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CLIENT_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SELLER_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc";
const ATTACKER_ADDR = "0xdddddddddddddddddddddddddddddddddddddddd";

const USDC_NAME = "USD Coin";
const USDC_VERSION = "2";
// F-12 fix (external audit 2026-10-25): 0x833589fC…A02913 is USDC on Base
// MAINNET. On Base Sepolia (chain 84532) the canonical test-token address is
// 0x036CbD53842c5426634e7929541eC2318f3dCF7e. The mock rail stays internally
// consistent either way, but the fixture must not teach mainnet-vs-testnet
// confusion — override with USDC_ASSET when a different test token is used.
const USDC_ASSET = process.env.USDC_ASSET ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const CHAIN_ID = 84532;
const NETWORK = "base-sepolia";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
const HONEST_AMOUNT = "10000"; // 0.01 USDC — well under maxPrice
const MAX_PRICE = "100000";
const RUN_STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Scenario catalog
// ---------------------------------------------------------------------------
const CATALOG = [
  { id: "S8", kind: "canonical" },
  { id: "S9", kind: "canonical" },
  { id: "B-BS-01", kind: "stage-a" },
  { id: "B-BS-02", kind: "stage-a" },
  { id: "B-BS-03", kind: "stage-a" },
  { id: "B-BS-04", kind: "stage-a" },
  { id: "B-BS-05", kind: "stage-b", code: "X402_VERSION_MISMATCH" },
  { id: "B-BS-06", kind: "stage-b", code: "NETWORK_MISMATCH" },
  { id: "B-BS-07", kind: "stage-b", code: "ASSET_MISMATCH" },
  { id: "B-BS-08", kind: "stage-b", code: "PAY_TO_MISMATCH" },
  { id: "B-BS-09", kind: "stage-b", code: "VALUE_MISMATCH" },
  { id: "B-BS-10", kind: "stage-b", code: "AUTHORIZER_MISMATCH" },
  { id: "B-BS-11", kind: "stage-b", code: "PAY_TO_MISMATCH" },
  { id: "B-BS-12", kind: "stage-b", code: "VALUE_MISMATCH" },
  { id: "B-BS-13", kind: "stage-b", code: "NONCE_MISMATCH" },
  { id: "B-BS-14", kind: "stage-b", code: "VALID_BEFORE_MISMATCH" },
  { id: "B-BS-15", kind: "stage-b", code: "INVALID_SIGNATURE" },
  { id: "B-BS-16", kind: "post-money" },
  { id: "B-BS-17", kind: "replay" },
  { id: "B-BS-18", kind: "over-budget" },
];

// Honest challenge served by an Argus that behaves this run.
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
      extra: { name: USDC_NAME, version: USDC_VERSION },
    }],
  };
}

// Argus-side challenge poisoning (Stage A scenarios). `q` = parsed query.
const CHALLENGE_MUTATIONS = {
  "B-BS-01": (c) => { c.accepts[0].payTo = ATTACKER_ADDR; return c; },
  "B-BS-02": (c) => { c.accepts[0].amount = "990000"; return c; },
  "B-BS-03": (c) => { c.accepts[0].asset = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; return c; },
  "B-BS-04": (c) => { c.accepts[0].network = "base"; return c; },
};

// B-BS-18: the seller is HONEST (the challenge is self-consistent, nothing
// tampered — that angle is B-BS-02) but prices the resource above the
// client's configured budget. Budget enforcement must refuse PRE-MONEY.
const CHALLENGE_MUTATIONS_BUDGET = {
  "B-BS-18": (c) => { c.accepts[0].amount = "200000"; return c; }, // 2× maxPrice
  // Boundary probe: EXACTLY at the cap. Lab Block D S11 contract: "boundary
  // at cap == price is inclusive and completes with exactly one debit and
  // one capture."
  "B-BS-18B": (c) => { c.accepts[0].amount = MAX_PRICE; return c; },
};

// Client-side payload poisoning AFTER honest signing (Stage B scenarios).
const PAYLOAD_MUTATIONS = {
  "B-BS-05": (p) => { p.x402Version = 99; return p; },
  "B-BS-06": (p) => { p.accepted.network = "base"; return p; },
  "B-BS-07": (p) => { p.accepted.asset = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; return p; },
  "B-BS-08": (p) => { p.accepted.payTo = ATTACKER_ADDR; return p; },
  "B-BS-09": (p) => { p.accepted.amount = "999000"; return p; },
  "B-BS-10": (p) => { p.payload.authorization.from = ATTACKER_ADDR; return p; },
  "B-BS-11": (p) => { p.payload.authorization.to = ATTACKER_ADDR; return p; },
  "B-BS-12": (p) => { p.payload.authorization.value = "999000"; return p; },
  "B-BS-13": (p) => { p.payload.authorization.nonce = "0x" + "ee".repeat(32); return p; },
  "B-BS-14": (p) => { p.payload.authorization.validBefore = String(Number(p.payload.authorization.validBefore) - 1); return p; },
  "B-BS-15": (p) => { p.payload.signature = "0x" + "00".repeat(65); return p; },
};

// ---------------------------------------------------------------------------
// Argus: adversarial resource server + mock facilitator + mock JSON-RPC
// ---------------------------------------------------------------------------
function buildArgus() {
  const app = express();
  app.use(express.json());

  // Post-money adversarial state (B-BS-16). Seller behavior is keyed by the
  // Idempotency-Key header, which the Secretariat sets to the stable
  // executionId (= operationId). The runner registers the mode BEFORE the
  // payment settles, so the very first delivery attempt already sees it.
  const sellerModes = new Map();    // operationId → "refuse" | "recover"
  const sellerAttempts = new Map(); // operationId → delivery attempt count

  // Challenge discovery — Secretariat.fetch(target) lands here (Stage A).
  app.post("/resource", (req, res) => {
    const scenario = String(req.query.s ?? "S8");
    const mutate = CHALLENGE_MUTATIONS[scenario] ?? CHALLENGE_MUTATIONS_BUDGET[scenario];
    const challenge = mutate ? mutate(honestChallenge()) : honestChallenge();
    const body64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
    res.status(402).set("PAYMENT-REQUIRED", body64).json(challenge);
  });

  // Post-settlement resource delivery (seller adapter POSTs here).
  // Default: honest 200. B-BS-16 legs override behavior per operationId.
  app.post("/seller", (req, res) => {
    const opId = String(req.headers["idempotency-key"] ?? "");
    const mode = sellerModes.get(opId);
    if (mode === "refuse") {
      // B-BS-16/refuse: the seller took the payment and refuses to serve the
      // resource. A definitive 5xx — the pipeline must record HTTP_FAILURE
      // and FAIL honestly; it must never fabricate a COMPLETED and must not
      // blind-retry a definitive answer.
      res.status(500).json({ error: "seller_refused_delivery" });
      return;
    }
    if (mode === "recover") {
      // B-BS-16/recover: the FIRST delivery attempt loses its response
      // mid-flight — status line + partial body, then the socket dies. This
      // is the fiat Block D "lost response" fault adapted to the seller
      // edge. Recovery retries (SAME idempotency key) hit a seller that
      // has since recovered and get the resource.
      const n = (sellerAttempts.get(opId) ?? 0) + 1;
      sellerAttempts.set(opId, n);
      if (n === 1) {
        res.status(200);
        res.set("content-type", "application/json");
        res.write('{"result":"deliv');
        // Destroy AFTER the partial body flushes → the client sees a 2xx
        // with a broken body stream → DELIVERY_UNKNOWN/RESPONSE_STREAM_FAILED
        // (the classification fixed in the S7 live-matrix repair).
        setTimeout(() => res.socket?.destroy(), 5);
        return;
      }
      res.status(200).json({ result: "delivered", attempt: n });
      return;
    }
    res.status(200).json({ result: "delivered", echo: req.body ?? null });
  });
  app.get("/seller/result/:executionId", (_req, res) => {
    res.status(200).json({ result: "delivered" });
  });

  // Mock x402 facilitator — Secretariat's X402FacilitatorClient POSTs /settle.
  // The settlement "lands on chain": the authorization fields are extracted
  // from the paymentHeader so the mock RPC can emit the matching Transfer +
  // AuthorizationUsed logs for that txHash (§7 proof bundle).
  const settledTx = new Map();
  // B-BS-17: chain-faithful replay guard. On a real EIP-3009 rail a nonce is
  // single-use (authorizationState[nonce] becomes Used once the transfer
  // lands). The mock must mirror that contract — re-presenting an
  // already-used authorization is a REPLAY and must be rejected. Lab Block D
  // finding F1 lesson: the mock must mirror the rail's real contract,
  // otherwise the SUT is punished for the mock's fidelity, not its own.
  const usedNonces = new Map(); // nonce → txHash of the first settle
  const facilitatorStats = { settlesAccepted: 0, replaysRejected: 0, malformedRejected: 0 };
  // F-112/C-1 (external audit 2026-10-26): the mock rail MUST mirror the real
  // x402 v2 remote-facilitator contract (CDP v2 / Radius / docs.x402.org):
  //   POST /settle { x402Version, paymentPayload, paymentRequirements }
  // The legacy `{paymentHeader, resource, network}` envelope is no longer
  // accepted — a request without paymentRequirements cannot settle (the rail
  // would not know payTo/asset/amount).
  app.post("/facilitator/settle", (req, res) => {
    try {
      const pp = req.body?.paymentPayload;
      const reqs = req.body?.paymentRequirements;
      if (!pp || !reqs || typeof req.body?.x402Version !== "number") {
        facilitatorStats.malformedRejected++;
        res.status(400).json({ success: false, errorReason: "malformed_settle_request" });
        return;
      }
      const authz = {
        from: String(pp?.payload?.authorization?.from ?? CLIENT_ADDR).toLowerCase(),
        to: String(pp?.payload?.authorization?.to ?? SELLER_ADDR).toLowerCase(),
        value: String(pp?.payload?.authorization?.value ?? HONEST_AMOUNT),
        nonce: String(pp?.payload?.authorization?.nonce ?? "0x" + "0".repeat(64)).toLowerCase(),
      };
      // Requirements sanity — the rail must agree on where the money goes.
      if (String(reqs?.payTo ?? "").toLowerCase() !== authz.to ||
          String(reqs?.amount ?? authz.value) !== authz.value ||
          String(reqs?.network ?? NETWORK) === "") {
        facilitatorStats.malformedRejected++;
        res.status(400).json({ success: false, errorReason: "requirements_mismatch" });
        return;
      }
      if (usedNonces.has(authz.nonce)) {
        facilitatorStats.replaysRejected++;
        res.status(409).json({
          success: false,
          errorReason: "authorization_used",
          error: `authorization nonce already used by tx ${usedNonces.get(authz.nonce)}`,
        });
        return;
      }
      const txHash = `0xsettle${Date.now().toString(16)}`;
      settledTx.set(txHash.toLowerCase(), authz);
      usedNonces.set(authz.nonce, txHash);
      facilitatorStats.settlesAccepted++;
      res.status(200).json({ success: true, transactionHash: txHash, network: NETWORK });
    } catch {
      // F-10 fix (external audit 2026-10-25): a malformed payment header is a
      // REJECTION, not a settlement. The previous catch branch minted a fake
      // tx, incremented settlesAccepted and answered 200 success:true — the
      // mock rail violated its own verification contract and could bless a
      // corrupted payload as a settled payment.
      facilitatorStats.malformedRejected++;
      res.status(400).json({ success: false, errorReason: "malformed_settle_request" });
    }
  });
  app.post("/facilitator/verify", (_req, res) => res.json({ isValid: true }));

  // Test-harness observability: B-BS-18 uses the settle counters as the
  // RAIL-SIDE proof that an over-budget probe dispatched nothing (the Lab's
  // Block D evidence rule — passive absence of SUT logs must not produce
  // PASS by itself; here the rail itself reports the count).
  app.get("/facilitator/stats", (_req, res) => res.json(facilitatorStats));

  // Mock JSON-RPC (§14: two providers, same endpoint is fine for the mock).
  const rpc = (method, params) => {
    if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
    if (method === "eth_blockNumber") return "0x110"; // 272
    if (method === "eth_getBlockByNumber") return { number: "0x110" };
    if (method === "eth_getLogs") return [];
    if (method === "eth_getTransactionReceipt") {
      const txHash = String(params?.[0] ?? "").toLowerCase();
      const authz = settledTx.get(txHash);
      if (!authz) return null;
      const pad = (addr) => "0x" + "0".repeat(24) + addr.replace(/^0x/, "");
      return {
        blockNumber: "0x100", // 256 → 22 confirmations (>= 12 required)
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
  return {
    app,
    registerSellerMode: (operationId, mode) => sellerModes.set(operationId, mode),
  };
}

// ---------------------------------------------------------------------------
// Client — EIP-3009 signing (x402 foundation primitive)
// ---------------------------------------------------------------------------
function nonce32() {
  return "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signEip3009(account, { payTo, value, nonceHex, validAfter, validBefore }) {
  return await account.signTypedData({
    domain: { name: USDC_NAME, version: USDC_VERSION, chainId: CHAIN_ID, verifyingContract: USDC_ASSET },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: CLIENT_ADDR,
      to: payTo,
      value: BigInt(value),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: nonceHex,
    },
  });
}

function buildV2Payload({ payTo, value, nonceHex, validAfter, validBefore, signature }) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      amount: value,
      asset: USDC_ASSET,
      payTo,
      maxTimeoutSeconds: 300,
      extra: { name: USDC_NAME, version: USDC_VERSION },
    },
    payload: {
      signature,
      authorization: {
        from: CLIENT_ADDR,
        to: payTo,
        value,
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce: nonceHex,
      },
    },
  };
}

async function createRequest(scenario) {
  // R7-B5c: the clientId is generated here and echoed to callers so status
  // polls can present the X-Client-Id header (the status route is now
  // client-scoped for operations that carry a clientId).
  const clientId = `argus-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${SECRETARIAT}/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: `${ARGUS}/resource?s=${scenario}`,
      method: "POST",
      payload: { prompt: "r6-e2e" },
      clientId,
      authorizer: CLIENT_ADDR,
      policy: {
        maxPrice: MAX_PRICE,
        allowedNetworks: [NETWORK],
        allowedAssets: [USDC_ASSET],
        allowedSellers: [SELLER_ADDR],
        authorizationMode: "explicit",
      },
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), clientId };
}

async function pollFinal(requestId, timeoutMs = 30_000, clientId = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${SECRETARIAT}/v1/requests/${requestId}`, {
      headers: clientId ? { "X-Client-Id": clientId } : {},
    });
    last = await res.json().catch(() => ({}));
    if (!["AWAITING_PAYMENT_SIGNATURE", "PROCESSING"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last ?? { status: "TIMEOUT" };
}

// ---------------------------------------------------------------------------
// B-BS-16/17/18 — post-money adversarial helpers
// ---------------------------------------------------------------------------
function bindingOf(paymentIntent) {
  return {
    payTo: paymentIntent.payTo,
    value: paymentIntent.value,
    nonceHex: paymentIntent.nonce,
    validAfter: paymentIntent.validAfter,
    validBefore: paymentIntent.validBefore,
  };
}

async function getFacilitatorStats() {
  const res = await fetch(`${ARGUS}/facilitator/stats`);
  return res.json();
}

// One honest end-to-end pass (create → optional seller-mode registration →
// sign the persisted intent binding → pay → poll to terminal status).
async function honestFlow(argus, account, tag, { pollMs = 30_000, sellerMode = null } = {}) {
  const created = await createRequest(tag);
  const out = {
    created,
    clientId: created.clientId ?? null,
    requestId: created.body?.requestId ?? null,
    operationId: created.body?.operationId ?? null,
    payload: null,
    final: null,
  };
  if (created.status === 201 && out.operationId && sellerMode) {
    argus.registerSellerMode(out.operationId, sellerMode);
  }
  if (created.status !== 201) return out;
  const signature = await signEip3009(account, bindingOf(created.body.paymentIntent));
  out.payload = buildV2Payload({ ...bindingOf(created.body.paymentIntent), signature });
  out.pay = await fetch(`${SECRETARIAT}/v1/requests/${out.requestId}/payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(out.payload),
  });
  out.final = await pollFinal(out.requestId, pollMs, out.clientId);
  return out;
}

// B-BS-16 — paid but not delivered, both adversarial variants in one entry.
//   refuse  — seller 500 on every attempt. R7-B2 (external audit 2026-10-26):
//             a bare 500 is NOT a definitive failure — the backend may or may
//             not have processed the paid call. With the IDEMPOTENT
//             capability the engine takes BOUNDED, same-key retries (no
//             re-charge: exactly one settlement), then closes honestly as
//             UNRESOLVABLE — NEVER a fake COMPLETED, never an infinite retry.
//   recover — lost response: DELIVERY_UNKNOWN, then a recovery retry with
//             the SAME idempotency key completes the delivery with exactly
//             ONE settlement across both attempts (no re-charge). The
//             operation-level FSM may honestly rest at UNKNOWN (durable
//             truth is asserted in PG — same semantics as live-matrix S3).
async function runPostMoney(argus, entry, account) {
  const refuse = await honestFlow(argus, account, "B-BS-16", { pollMs: 45_000, sellerMode: "refuse" });
  const recover = await honestFlow(argus, account, "B-BS-16", { pollMs: 60_000, sellerMode: "recover" });
  entry.requestId = refuse.requestId;
  entry.operationId = refuse.operationId;
  entry.legs = {
    refuse: { requestId: refuse.requestId, operationId: refuse.operationId, finalStatus: refuse.final?.status ?? null },
    recover: { requestId: recover.requestId, operationId: recover.operationId, finalStatus: recover.final?.status ?? null },
  };
  // R7-B2: the honest terminal for a permanently-500ing seller is any
  // non-COMPLETED resolution (UNRESOLVABLE/UNKNOWN/FAILED) — the lie that is
  // forbidden is COMPLETED, not UNRESOLVABLE.
  const refuseOk = !["COMPLETED"].includes(refuse.final?.status ?? "") && refuse.final?.status != null;
  const recoverOk = ["UNKNOWN", "COMPLETED"].includes(recover.final?.status ?? "");
  return {
    outcome: refuseOk && recoverOk ? "PASSED" : "LEAKED",
    refuse: { status: refuse.final?.status ?? "-", tx: refuse.final?.settlementTxHash ?? null },
    recover: { status: recover.final?.status ?? "-", tx: recover.final?.settlementTxHash ?? null },
  };
}

// B-BS-17 — replay of a used EIP-3009 nonce. Attacker model: anyone who
// observed the settled payment payload (the seller, a wire tap) re-presents
// it DIRECTLY to the facilitator hoping for a second settlement. The
// chain-faithful mock must reject the replay, and the ledger must keep
// exactly one settlement. The Secretariat is deliberately NOT in this loop —
// a real double-spend attempt bypasses it.
async function runReplay(argus, entry, account) {
  const flow = await honestFlow(argus, account, "B-BS-17");
  entry.requestId = flow.requestId;
  entry.operationId = flow.operationId;
  if (flow.created.status !== 201 || flow.final?.status !== "COMPLETED") {
    return { outcome: "ERROR", detail: `setup: create=${flow.created.status} final=${flow.final?.status ?? "-"}` };
  }
  // F-112/C-1: the replay probe now speaks the canonical v2 settle wire
  // (paymentPayload + paymentRequirements) — same contract as the
  // Secretariat's X402FacilitatorClient.
  const paymentPayload = flow.payload;
  const replayRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_ASSET,
    amount: HONEST_AMOUNT,
    payTo: SELLER_ADDR,
    maxTimeoutSeconds: 300,
  };
  const replay = await fetch(`${ARGUS}/facilitator/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements: replayRequirements,
    }),
  });
  const replayBody = await replay.json().catch(() => ({}));
  const rejected = replay.status === 409 && replayBody?.success === false;
  return {
    outcome: rejected ? "BLOCKED" : "LEAKED",
    settleTx: flow.final.settlementTxHash ?? null,
    replayStatus: replay.status,
    replayCode: replayBody?.errorReason ?? "-",
  };
}

// B-BS-18 — over budget (client policy probe; adapted from Argus Lab Block D
// S11 "Over Budget", fiat rails → x402 rails). The refusal must be PRE-MONEY
// with ZERO settle dispatches (the facilitator counters are the rail-side
// proof). The boundary probe at EXACTLY the cap is inclusive: it completes
// with one settlement + one delivery.
async function runOverBudget(argus, entry, account) {
  const statsBefore = await getFacilitatorStats();
  const over = await createRequest("B-BS-18");
  const statsAfter = await getFacilitatorStats();
  const zeroDispatch = statsAfter.settlesAccepted === statsBefore.settlesAccepted;
  const overOk = over.status === 422 && over.body?.error?.code === "REQUEST_REJECTED" && zeroDispatch;

  const boundary = await honestFlow(argus, account, "B-BS-18B");
  const boundaryOk = boundary.final?.status === "COMPLETED";
  entry.requestId = boundary.requestId;
  entry.operationId = boundary.operationId;
  entry.legs = {
    over: { httpStatus: over.status, code: over.body?.error?.code ?? "-", zeroDispatch },
    boundary: { requestId: boundary.requestId, finalStatus: boundary.final?.status ?? null },
  };
  return {
    outcome: overOk && boundaryOk ? "PASSED" : "LEAKED",
    over: { status: over.status, code: over.body?.error?.code ?? "-", zeroDispatch },
    boundary: { status: boundary.final?.status ?? "-" },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL observation assertions
// ---------------------------------------------------------------------------
// F-19 fix (external audit 2026-10-25): run-scoped evidence baseline. The
// stage-a/over-budget PG checks must prove THIS run produced rejections —
// compare against the pre-run POLICY_REJECTED count (delta), not an all-time
// aggregate that foreign rows could satisfy.
async function policyRejectedBaseline() {
  try {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://zeus@localhost:5432/zeus" });
    // R7-fix: the baseline MUST use the SAME run-window predicate as the
    // post-run delta query. The previous all-time count worked only because
    // CI provisions a FRESH database per run (baseline 0 by accident); on a
    // persistent database the all-time baseline was subtracted from a
    // run-window count, forcing delta=0 on every second run.
    const b = await pool.query(
      `SELECT count(*)::int AS n FROM reconciliation_observations
       WHERE result = 'POLICY_REJECTED' AND observed_at >= to_timestamp($1 / 1000.0)`,
      [RUN_STARTED_AT],
    );
    await pool.end();
    return b.rows[0]?.n ?? 0;
  } catch {
    return -1; // PG unreachable — assertObservations will surface it
  }
}

async function assertObservations(results, policyBaseline) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://zeus@localhost:5432/zeus" });
  const out = [];
  try {
    for (const r of results) {
      if (r.verdict.outcome === "ERROR") { out.push({ scenario: r.scenario, ok: false, note: "scenario errored" }); continue; }

      if (r.kind === "stage-b") {
        const q = await pool.query(
          `SELECT reconciliation_observations FROM payment_intents WHERE request_id = $1 LIMIT 1`,
          [r.requestId],
        );
        const obs = q.rows[0]?.reconciliation_observations ?? [];
        const rejected = obs.find(
          (o) => o.event === "PAYMENT_VERIFICATION_REJECTED" && o.payload?.code === r.expectedCode,
        );
        out.push({ scenario: r.scenario, ok: !!rejected, note: rejected ? "rejection recorded in PG" : `missing PAYMENT_VERIFICATION_REJECTED/${r.expectedCode}` });
      } else if (r.kind === "post-money") {
        const legs = r.legs ?? {};
        const checks = [];
        if (legs.refuse?.operationId) {
          const att = await pool.query(
            `SELECT attempt_number, status, response_status_code FROM execution_attempts WHERE operation_id = $1 ORDER BY attempt_number`,
            [legs.refuse.operationId],
          );
          const job = await pool.query(
            `SELECT status FROM recovery_jobs WHERE operation_id = $1 AND job_type = 'EXECUTION' LIMIT 1`,
            [legs.refuse.operationId],
          );
          const obs = await pool.query(
            `SELECT reconciliation_observations FROM payment_intents WHERE request_id = $1 LIMIT 1`,
            [legs.refuse.requestId],
          );
          // Ledger integrity: exactly ONE intent for the request, settled,
          // with a single tx. PAYMENT_VERIFIED observation COUNT is not an
          // invariant — the reconciliation worker re-verifies settled intents
          // over time, so observations accumulate; the single tx is the
          // no-re-charge proof.
          const ints = await pool.query(
            `SELECT tx_hash FROM payment_intents WHERE request_id = $1`,
            [legs.refuse.requestId],
          );
          const singleSettle = ints.rows.length === 1 && !!ints.rows[0].tx_hash;
          const events = (obs.rows[0]?.reconciliation_observations ?? []).map((o) => o.event);
          const a = att.rows;
          // R7-B2 (external audit 2026-10-26): a permanent 500 is outcome-
          // UNKNOWN, not definitive failure. Honest behavior: BOUNDED retries
          // (max 3 attempts, same idempotency key), attempt rows recorded as
          // DELIVERY_UNKNOWN with the real HTTP 500 preserved, job closes
          // UNRESOLVABLE, exactly one settlement (no re-charge), never a
          // success event.
          const bounded = a.length >= 1 && a.length <= 3;
          const allUnknown500 = a.every((x) => x.status === "DELIVERY_UNKNOWN" && x.response_status_code === 500);
          checks.push({
            leg: "refuse",
            ok: bounded && allUnknown500 && job.rows[0]?.status === "UNRESOLVABLE" && singleSettle
              && events.includes("EXECUTION_RETRY_CREATED") && !events.includes("EXECUTION_SUCCESS"),
            note: `attempts=${a.length}[${a.map((x) => `${x.status}:${x.response_status_code ?? "-"}`).join(",")}] job=${job.rows[0]?.status ?? "-"} intents=${ints.rows.length} tx=${ints.rows[0]?.tx_hash ? "single" : "none"}`,
          });
        }
        if (legs.recover?.operationId) {
          // Attempt 2 is driven by the background worker poll — give it a
          // bounded window to land before asserting.
          let a = [];
          for (let i = 0; i < 30; i++) {
            const q = await pool.query(
              `SELECT attempt_number, status, response_status_code, error_reason FROM execution_attempts WHERE operation_id = $1 ORDER BY attempt_number`,
              [legs.recover.operationId],
            );
            a = q.rows;
            if (a.length >= 2 && a[a.length - 1].status === "SUCCESS") break;
            await new Promise((res) => setTimeout(res, 1000));
          }
          const job = await pool.query(
            `SELECT status FROM recovery_jobs WHERE operation_id = $1 AND job_type = 'EXECUTION' LIMIT 1`,
            [legs.recover.operationId],
          );
          const obs = await pool.query(
            `SELECT reconciliation_observations FROM payment_intents WHERE request_id = $1 LIMIT 1`,
            [legs.recover.requestId],
          );
          const ints = await pool.query(
            `SELECT tx_hash FROM payment_intents WHERE request_id = $1`,
            [legs.recover.requestId],
          );
          const singleSettle = ints.rows.length === 1 && !!ints.rows[0].tx_hash;
          const events = (obs.rows[0]?.reconciliation_observations ?? []).map((o) => o.event);
          const firstUnknown = a[0]?.status === "DELIVERY_UNKNOWN"
            && ["RESPONSE_STREAM_FAILED", "CONNECTION_RESET"].includes(a[0]?.error_reason ?? "");
          const secondSuccess = a.length >= 2 && a[a.length - 1].status === "SUCCESS" && a[a.length - 1].response_status_code === 200;
          checks.push({
            leg: "recover",
            ok: a.length === 2 && firstUnknown && secondSuccess
              && job.rows[0]?.status === "COMPLETED" && singleSettle
              && events.includes("EXECUTION_RETRY_CREATED") && events.includes("EXECUTION_SUCCESS"),
            note: `attempts=${a.length}[${a.map((x) => `${x.status}:${x.error_reason ?? x.response_status_code ?? "-"}`).join(",")}] job=${job.rows[0]?.status ?? "-"} intents=${ints.rows.length} tx=${ints.rows[0]?.tx_hash ? "single" : "none"}`,
          });
        }
        const ok = checks.length > 0 && checks.every((c) => c.ok);
        out.push({ scenario: r.scenario, ok, note: checks.map((c) => `${c.leg}:${c.ok ? "ok" : "FAIL"}(${c.note})`).join(" ") || "no legs" });
      } else if (r.kind === "replay") {
        const q = await pool.query(
          `SELECT settlement_state, tx_hash, reconciliation_observations FROM payment_intents WHERE request_id = $1`,
          [r.requestId],
        );
        const rows = q.rows;
        const verified = rows.flatMap((x) => x.reconciliation_observations ?? [])
          .filter((o) => o.event === "PAYMENT_VERIFIED").length;
        const att = await pool.query(
          `SELECT count(*)::int AS n FROM execution_attempts WHERE operation_id = $1`,
          [r.operationId],
        );
        // Replay proof lives at the facilitator (409, single-use nonce); the
        // ledger must show ONE settled intent with ONE tx and ONE delivery.
        const ok = rows.length === 1 && rows[0].settlement_state === "SETTLED" && !!rows[0].tx_hash
          && verified >= 1 && att.rows[0]?.n === 1;
        out.push({
          scenario: r.scenario,
          ok,
          note: `intents=${rows.length} settled=${rows.filter((x) => x.settlement_state === "SETTLED").length} tx=${rows[0]?.tx_hash ? "single" : "none"} verified>=${verified >= 1 ? 1 : 0} attempts=${att.rows[0]?.n}`,
        });
      } else if (r.kind === "over-budget") {
        // Over leg: THIS run's refusals — pre-money refusal adds one
        // POLICY_REJECTED row to the run-window DELTA over the pre-run
        // baseline (F-19: 4 stage-a + B-BS-18 => delta >= 5).
        const g = await pool.query(
          `SELECT count(*)::int AS n FROM reconciliation_observations
           WHERE result = 'POLICY_REJECTED' AND observed_at >= to_timestamp($1 / 1000.0)`,
          [RUN_STARTED_AT],
        );
        const runDelta = policyBaseline >= 0 ? (g.rows[0]?.n ?? 0) - policyBaseline : null;
        // Boundary leg: priced EXACTLY at the cap, settled exactly once.
        const q = await pool.query(
          `SELECT value, settlement_state, tx_hash, reconciliation_observations FROM payment_intents WHERE request_id = $1 LIMIT 1`,
          [r.requestId],
        );
        const row = q.rows[0];
        const verified = (row?.reconciliation_observations ?? []).filter((o) => o.event === "PAYMENT_VERIFIED").length;
        const att = await pool.query(
          `SELECT count(*)::int AS n FROM execution_attempts WHERE operation_id = $1 AND status = 'SUCCESS'`,
          [r.operationId],
        );
        // value is decimal(38,6) — compare numerically, not as a string.
        const boundaryOk = !!row && Number(row.value) === Number(MAX_PRICE)
          && row.settlement_state === "SETTLED" && !!row.tx_hash && verified >= 1 && att.rows[0]?.n === 1;
        out.push({
          scenario: r.scenario,
          ok: runDelta !== null && runDelta >= 5 && boundaryOk,
          note: `policyRejectDelta=${runDelta ?? "PG-unreachable"} boundaryValue=${row?.value ?? "-"} state=${row?.settlement_state ?? "-"} tx=${row?.tx_hash ? "single" : "none"} successAttempts=${att.rows[0]?.n}`,
        });
      } else if (r.scenario === "S8") {
        const q = await pool.query(
          `SELECT settlement_state, reconciliation_observations FROM payment_intents WHERE request_id = $1 LIMIT 1`,
          [r.requestId],
        );
        const row = q.rows[0];
        const obs = row?.reconciliation_observations ?? [];
        const verified = obs.some((o) => o.event === "PAYMENT_VERIFIED");
        const discovery = obs.some((o) => o.event === "PAYMENT_REQUIREMENT_RECEIVED");
        out.push({
          scenario: "S8",
          ok: !!row && verified && discovery,
          note: `state=${row?.settlement_state ?? "MISSING"} verified=${verified} discovery=${discovery}`,
        });
      } else if (r.scenario === "S9") {
        const q = await pool.query(
          `SELECT count(*)::int AS n FROM payment_intents WHERE request_id = $1`,
          [r.requestId],
        );
        out.push({ scenario: "S9", ok: q.rows[0]?.n === 1, note: `intents for retried requestId = ${q.rows[0]?.n} (must be 1)` });
      } else if (r.kind === "stage-a") {
        // F-19 fix: the SPECIFIC per-scenario proof is the HTTP verdict of
        // THIS probe (422 REQUEST_REJECTED). The global run-window count is
        // no longer a substitute for per-scenario evidence — it is checked
        // once as an aggregate row below (POLICY-REJECT-AGGREGATE).
        const specific = r.verdict?.outcome === "BLOCKED" && r.verdict?.code === "REQUEST_REJECTED";
        out.push({
          scenario: r.scenario,
          ok: specific,
          note: `http=${r.verdict?.httpStatus ?? "-"} code=${r.verdict?.code ?? "-"} (specific, per-probe)`,
        });
      } else {
        out.push({ scenario: r.scenario, ok: true, note: "no PG assertion" });
      }
    }

    // F-19: run-window aggregate — THIS run must have produced at least one
    // POLICY_REJECTED row per BLOCKED stage-a/over-budget probe.
    const blockedProbes = results.filter(
      (r) => ["stage-a", "over-budget"].includes(r.kind) && r.verdict?.outcome === "BLOCKED",
    ).length;
    if (blockedProbes > 0 && policyBaseline >= 0) {
      const total = await pool.query(
        `SELECT count(*)::int AS n FROM reconciliation_observations
         WHERE result = 'POLICY_REJECTED' AND observed_at >= to_timestamp($1 / 1000.0)`,
        [RUN_STARTED_AT],
      );
      const delta = (total.rows[0]?.n ?? 0) - policyBaseline;
      out.push({
        scenario: "POLICY-REJECT-AGGREGATE",
        ok: delta >= blockedProbes,
        note: `run-window delta=${delta} >= blocked probes=${blockedProbes} (baseline=${policyBaseline})`,
      });
    }
  } finally {
    await pool.end();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const account = privateKeyToAccount(CLIENT_KEY);
  const argus = buildArgus();
  const argusServer = await new Promise((resolve) => {
    const s = argus.app.listen(ARGUS_PORT, "127.0.0.1", () => resolve(s));
  });
  console.log(`[argus] listening on ${ARGUS}`);

  const results = [];

  // F-19: the POLICY_REJECTED baseline must be captured BEFORE the first
  // probe. The previous implementation read it AFTER the scenario loop,
  // which made the baseline include this run's own rejections and the
  // run-window delta structurally zero — the aggregate/over-budget PG
  // assertions were unsatisfiable by construction (CI first red on
  // 2d936afe1 with delta=0, baseline=5 = this run's own rows).
  const policyBaseline = await policyRejectedBaseline();

  for (const scenario of CATALOG) {
    const entry = {
      scenario: scenario.id,
      kind: scenario.kind,
      expectedCode: scenario.code ?? null,
      requestId: null,
      clientId: null,
      operationId: null,
      verdict: { outcome: "ERROR" },
    };
    try {
      // ---- Post-money adversarial: B-BS-16/17/18 drive their own flows ----
      if (scenario.kind === "post-money" || scenario.kind === "replay" || scenario.kind === "over-budget") {
        entry.verdict = scenario.kind === "post-money"
          ? await runPostMoney(argus, entry, account)
          : scenario.kind === "replay"
            ? await runReplay(argus, entry, account)
            : await runOverBudget(argus, entry, account);
        results.push(entry);
        continue;
      }

      // ---- Stage A: discovery (Argus serves the poisoned challenge) ----
      const created = await createRequest(scenario.id);
      entry.clientId = created.clientId ?? null;
      entry.requestId = created.body?.requestId ?? null;
      entry.operationId = created.body?.operationId ?? null;

      if (scenario.kind === "stage-a") {
        const rejected =
          created.status === 422 &&
          created.body?.error?.code === "REQUEST_REJECTED";
        entry.verdict = {
          outcome: rejected ? "BLOCKED" : "LEAKED",
          httpStatus: created.status,
          code: created.body?.error?.code ?? "-",
        };
        results.push(entry);
        continue;
      }

      if (created.status !== 201) {
        entry.verdict = { outcome: "ERROR", httpStatus: created.status, detail: JSON.stringify(created.body).slice(0, 140) };
        results.push(entry);
        continue;
      }

      // ---- Honest client signs EXACTLY the persisted intent binding ----
      const pr = created.body.paymentRequired;
      const pi = created.body.paymentIntent;
      const binding = {
        payTo: pi.payTo,
        value: pi.value,
        nonceHex: pi.nonce,
        validAfter: pi.validAfter,
        validBefore: pi.validBefore,
      };
      const signature = await signEip3009(account, binding);
      let payload = buildV2Payload({ ...binding, signature });

      // S9 first pass behaves like S8 (honest); retry happens after S8-style flow
      if (PAYLOAD_MUTATIONS[scenario.id]) {
        payload = PAYLOAD_MUTATIONS[scenario.id](payload);
      }

      // ---- Stage B: submit signed payment ----
      const payRes = await fetch(`${SECRETARIAT}/v1/requests/${entry.requestId}/payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const payBody = await payRes.json().catch(() => ({}));

      if (scenario.kind === "stage-b") {
        const blocked =
          payRes.status === 422 &&
          payBody?.error?.code === scenario.code;
        entry.verdict = {
          outcome: blocked ? "BLOCKED" : "LEAKED",
          httpStatus: payRes.status,
          code: payBody?.error?.code ?? "-",
        };
        results.push(entry);
        continue;
      }

      // ---- Canonical scenarios: S8 honest pass, S9 idempotent retry ----
      const first = await pollFinal(entry.requestId, undefined, entry.clientId);
      const firstTx = first.settlementTxHash ?? null;

      if (scenario.id === "S8") {
        entry.verdict = {
          outcome: first.status === "COMPLETED" ? "PASSED" : "NOT_COMPLETED",
          httpStatus: payRes.status,
          finalStatus: first.status,
          txHash: firstTx,
          outcomeData: first.outcome ?? null,
        };
        results.push(entry);
        continue;
      }

      // S9: retry the EXACT same payload — must be idempotent, single payment.
      // F-11 fix (external audit 2026-10-25): the verdict requires PROOF, not
      // plausibility: (1) a CONFIRMED first txHash exists, (2) the retry
      // returns the SAME txHash, (3) the rail-side settle counter did not
      // move across the retry. A missing firstTx makes the scenario
      // INCONCLUSIVE — never PASSED.
      const statsBeforeRetry = await getFacilitatorStats();
      const retryRes = await fetch(`${SECRETARIAT}/v1/requests/${entry.requestId}/payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const retryBody = await retryRes.json().catch(() => ({}));
      const retryTx = retryBody?.settlementTxHash ?? null;
      const statsAfterRetry = await getFacilitatorStats();
      const settlesDelta = (statsAfterRetry?.settlesAccepted ?? 0) - (statsBeforeRetry?.settlesAccepted ?? 0);
      const idempotent =
        retryRes.status === 200 &&
        retryBody?.requestId === entry.requestId &&
        firstTx !== null &&
        retryTx === firstTx &&
        settlesDelta === 0;
      const s9Outcome = idempotent ? "PASSED" : firstTx === null ? "INCONCLUSIVE" : "NOT_IDEMPOTENT";

      entry.verdict = {
        outcome: s9Outcome,
        httpStatus: retryRes.status,
        finalStatus: retryBody?.status ?? first.status,
        txHashFirst: firstTx,
        txHashRetry: retryTx,
        settlesDelta,
      };
      results.push(entry);
    } catch (e) {
      entry.verdict = { outcome: "ERROR", detail: String(e).slice(0, 160) };
      results.push(entry);
    }
  }

  // ---- PostgreSQL observation assertions ----
  let pgChecks;
  try {
    // policyBaseline was captured pre-run (above); reading it here instead
    // would fold this run's own POLICY_REJECTED rows into the baseline.
    pgChecks = await assertObservations(results, policyBaseline);
  } catch (e) {
    pgChecks = [{ scenario: "PG", ok: false, note: String(e).slice(0, 200) }];
  }

  console.log("\n===== R6 ADVERSARIAL E2E VERDICT =====");
  let blocked = 0, passed = 0, leaked = 0, other = 0;
  for (const r of results) {
    const v = r.verdict;
    console.log(
      `${r.kind.padEnd(10)} ${r.scenario.padEnd(9)} → ${String(v.outcome).padEnd(16)} http=${v.httpStatus ?? "-"} final=${v.finalStatus ?? "-"} code=${v.code ?? ""}${v.detail ? " " + v.detail : ""}`,
    );
    if (v.outcome === "BLOCKED") blocked++;
    else if (v.outcome === "PASSED") passed++;
    else if (v.outcome === "LEAKED" || v.outcome === "NOT_IDEMPOTENT") leaked++;
    else other++;
  }

  console.log("\n----- PostgreSQL observation checks -----");
  let pgOk = 0, pgFail = 0;
  for (const c of pgChecks) {
    console.log(`${c.ok ? "OK " : "FAIL"} ${c.scenario.padEnd(9)} ${c.note}`);
    c.ok ? pgOk++ : pgFail++;
  }

  console.log(`\nTOTAL: blocked=${blocked}/16 passed=${passed}/4 leaked=${leaked} other=${other} | PG: ok=${pgOk} fail=${pgFail}`);
  // Gate semantics: stage-a/stage-b/replay entries must BLOCK; every
  // post-money/canonical entry must PASS; PG must confirm every verdict.
  const mismatch = [];
  for (const r of results) {
    const expected = ["stage-a", "stage-b", "replay"].includes(r.kind) ? "BLOCKED" : "PASSED";
    if (r.verdict.outcome !== expected) mismatch.push(`${r.scenario}=${r.verdict.outcome}(!=${expected})`);
  }
  const gate = leaked === 0 && other === 0 && pgFail === 0
    && blocked === 16 && passed === 4;
  console.log(`GATE: ${gate ? "GREEN" : "RED"}${mismatch.length > 0 ? ` — ${mismatch.join(", ")}` : ""}`);
  argusServer.close();
  process.exit(gate ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
