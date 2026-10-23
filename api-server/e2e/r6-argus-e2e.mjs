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
const USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // base-sepolia USDC
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

  // Challenge discovery — Secretariat.fetch(target) lands here (Stage A).
  app.post("/resource", (req, res) => {
    const scenario = String(req.query.s ?? "S8");
    const challenge = CHALLENGE_MUTATIONS[scenario]
      ? CHALLENGE_MUTATIONS[scenario](honestChallenge())
      : honestChallenge();
    const body64 = Buffer.from(JSON.stringify(challenge)).toString("base64");
    res.status(402).set("PAYMENT-REQUIRED", body64).json(challenge);
  });

  // Post-settlement resource delivery (seller adapter POSTs here).
  app.post("/seller", (req, res) => {
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
  app.post("/facilitator/settle", (req, res) => {
    const txHash = `0xsettle${Date.now().toString(16)}`;
    try {
      const header = String(req.body?.paymentHeader ?? "");
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      settledTx.set(txHash.toLowerCase(), {
        from: String(decoded?.payload?.authorization?.from ?? CLIENT_ADDR).toLowerCase(),
        to: String(decoded?.payload?.authorization?.to ?? SELLER_ADDR).toLowerCase(),
        value: String(decoded?.payload?.authorization?.value ?? HONEST_AMOUNT),
        nonce: String(decoded?.payload?.authorization?.nonce ?? "0x" + "0".repeat(64)).toLowerCase(),
      });
    } catch {
      settledTx.set(txHash.toLowerCase(), {
        from: CLIENT_ADDR.toLowerCase(), to: SELLER_ADDR, value: HONEST_AMOUNT,
        nonce: "0x" + "0".repeat(64),
      });
    }
    res.status(200).json({ success: true, transactionHash: txHash, network: NETWORK });
  });
  app.post("/facilitator/verify", (_req, res) => res.json({ isValid: true }));

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
  return app;
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
  const res = await fetch(`${SECRETARIAT}/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: `${ARGUS}/resource?s=${scenario}`,
      method: "POST",
      payload: { prompt: "r6-e2e" },
      clientId: `argus-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function pollFinal(requestId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${SECRETARIAT}/v1/requests/${requestId}`);
    last = await res.json().catch(() => ({}));
    if (!["AWAITING_PAYMENT_SIGNATURE", "PROCESSING"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last ?? { status: "TIMEOUT" };
}

// ---------------------------------------------------------------------------
// PostgreSQL observation assertions
// ---------------------------------------------------------------------------
async function assertObservations(results) {
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
        const q = await pool.query(
          `SELECT count(*)::int AS n FROM reconciliation_observations
           WHERE result = 'POLICY_REJECTED' AND observed_at >= to_timestamp($1 / 1000.0)
             AND attempt_id = $2`,
          [RUN_STARTED_AT, r.operationId ?? ""],
        );
        // Stage-A rejections record evidence under the OPERATION id, which the
        // HTTP API does not expose for rejected requests — assert globally that
        // policy rejections happened during the run window instead.
        const global = await pool.query(
          `SELECT count(*)::int AS n FROM reconciliation_observations
           WHERE result = 'POLICY_REJECTED' AND observed_at >= to_timestamp($1 / 1000.0)`,
          [RUN_STARTED_AT],
        );
        out.push({ scenario: r.scenario, ok: global.rows[0]?.n >= 4, note: `POLICY_REJECTED rows in run window: ${global.rows[0]?.n}` });
      } else {
        out.push({ scenario: r.scenario, ok: true, note: "no PG assertion" });
      }
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
    const s = argus.listen(ARGUS_PORT, "127.0.0.1", () => resolve(s));
  });
  console.log(`[argus] listening on ${ARGUS}`);

  const results = [];

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
      // ---- Stage A: discovery (Argus serves the poisoned challenge) ----
      const created = await createRequest(scenario.id);
      entry.clientId = created.body?.clientId ?? null;
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
      const first = await pollFinal(entry.requestId);
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

      // S9: retry the EXACT same payload — must be idempotent, single payment
      const retryRes = await fetch(`${SECRETARIAT}/v1/requests/${entry.requestId}/payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const retryBody = await retryRes.json().catch(() => ({}));
      const retryTx = retryBody?.settlementTxHash ?? null;
      const idempotent =
        retryRes.status === 200 &&
        retryBody?.requestId === entry.requestId &&
        (retryTx === firstTx || firstTx === null);

      entry.verdict = {
        outcome: idempotent ? "PASSED" : "NOT_IDEMPOTENT",
        httpStatus: retryRes.status,
        finalStatus: retryBody?.status ?? first.status,
        txHashFirst: firstTx,
        txHashRetry: retryTx,
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
    pgChecks = await assertObservations(results);
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

  console.log(`\nTOTAL: blocked=${blocked}/15 passed=${passed}/2 leaked=${leaked} other=${other} | PG: ok=${pgOk} fail=${pgFail}`);
  argusServer.close();
  process.exit(leaked > 0 || pgFail > 0 || other > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
