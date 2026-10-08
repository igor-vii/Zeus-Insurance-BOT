/**
 * Secretariat external-client sandbox driver.
 * Runs one client (ClawRouter | Franklin | BlockRun) through one scenario (S0..S5)
 * strictly via the public Secretariat API: POST /v1/requests (+ Stage-B payment).
 *
 * Clients sign EIP-3009 TransferWithAuthorization locally with viem (test keys only).
 * No Insurance API is used anywhere in this flow.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";


const SECRETARIAT = process.env.SECRETARIAT_URL || "http://127.0.0.1:18791";
const RESOURCE = process.env.RESOURCE_URL || "http://127.0.0.1:18700";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || "/workspace/evidence/secretariat-test";
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c942c0a9d39f23520231D3dF71be4";
const AMOUNT = 100000n; // 0.1 USDC — matches controlled resource challenge

// --- test identities (sandbox-only throwaway keys; NOT secrets to protect beyond commit hygiene) ---
const CLIENT_KEYS = {
  ClawRouter: "0x" + crypto.createHash("sha256").update("clawrouter-sandbox-key-v1").digest("hex"),
  Franklin:   "0x" + crypto.createHash("sha256").update("franklin-sandbox-key-v1").digest("hex"),
  BlockRun:   "0x" + crypto.createHash("sha256").update("blockrun-sandbox-key-v1").digest("hex"),
};

const SCENARIOS = {
  S0: { mode: "HAPPY",         desc: "happy path: policy accepted -> 402 -> payment -> execution -> delivery" },
  S1: { mode: "TIMEOUT",       desc: "execution starts, response never arrives" },
  S2: { mode: "RESPONSE_LOST", desc: "execution completes, response destroyed" },
  S3: { mode: "EXEC_FAILURE",  desc: "execution explicitly fails" },
  S4: { mode: "RETRY",         desc: "first execution unknown, client retries" },
  S5: { mode: "IDEMPOTENT",    desc: "same economic operation retried with same idempotency identity" },
};

function now() { return new Date().toISOString(); }
function appendJsonl(file, entry) {
  fs.mkdirSync(EVIDENCE_DIR + "/secretariat", { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

async function fetchJson(url, opts = {}, timeoutMs = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
  } finally { clearTimeout(t); }
}

function eip3009Payload(account, requirement, nonceHex) {
  const auth = {
    from: account.address,
    to: requirement.payTo,
    value: String(requirement.amount ?? requirement.maxAmountRequired),
    validAfter: "0",
    validBefore: String(BigInt(Math.floor(Date.now()/1000)) + 3600n),
    nonce: nonceHex,
  };
  return { auth };
}

async function signPaymentPayload(account, accepted, auth) {
  const sig = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from, to: auth.to, value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  return {
    x402Version: 2,
    scheme: "exact",
    network: "base-sepolia",
    payload: { signature: sig, authorization: auth },
  };
}

function extractRequirement(pr) {
  // pr may be PaymentRequirement object persisted by Secretariat
  return pr;
}

async function runScenario(client, scenario, { noPolicyId = true } = {}) {
  const cfg = SCENARIOS[scenario];
  const account = privateKeyToAccount(CLIENT_KEYS[client]);
  const runLog = [];
  const nonceHex = "0x" + crypto.randomBytes(32).toString("hex");

  const target = `${RESOURCE}/resource?mode=${cfg.mode}`;
  const body = {
    target,
    method: "POST",
    clientId: `sandbox-${client.toLowerCase()}`,
    requestId: `sbx-${client}-${scenario}-${Date.now()}`,
    policy: {
      maxPrice: "100000",
      allowedNetworks: ["base-sepolia"],
      allowedAssets: [USDC],
      authorizationMode: "policy-bound",
    },
    authorizer: account.address,
  };
  if (!noPolicyId) body.policy.policyId = "should-be-ignored-or-rejected";

  const reqEntry = { ts: now(), client, scenario, step: "stage-a-request", method: "POST", url: `${SECRETARIAT}/v1/requests`, body };
  appendJsonl(`${EVIDENCE_DIR}/secretariat/requests.jsonl`, reqEntry);

  const stageA = await fetchJson(`${SECRETARIAT}/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const respEntry = { ts: now(), client, scenario, step: "stage-a-response", status: stageA.status, headers: stageA.headers, body: stageA.body };
  appendJsonl(`${EVIDENCE_DIR}/secretariat/responses.jsonl`, respEntry);
  runLog.push(respEntry);

  if (stageA.status !== 201 || stageA.body?.status !== "AWAITING_PAYMENT_SIGNATURE") {
    return { client, scenario, stoppedAt: "STAGE_A", stageA, runLog, verdict: "SCENARIO NOT REACHED" };
  }
  const requestId = stageA.body.requestId;
  const requirement = extractRequirement(stageA.body.paymentRequired);

  // Stage B: submit signed payment
  const accepted = requirement.accepted?.[0] ?? requirement;
  const { auth } = eip3009Payload(account, accepted, nonceHex);
  const payment = await signPaymentPayload(account, accepted, auth);
  const payReq = { ts: now(), client, scenario, step: "stage-b-payment", method: "POST", url: `${SECRETARIAT}/v1/requests/${requestId}/payment`, body: payment };
  appendJsonl(`${EVIDENCE_DIR}/secretariat/requests.jsonl`, payReq);

  const stageB = await fetchJson(`${SECRETARIAT}/v1/requests/${requestId}/payment`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payment),
  }, 60000);
  const payResp = { ts: now(), client, scenario, step: "stage-b-response", status: stageB.status, headers: stageB.headers, body: stageB.body };
  appendJsonl(`${EVIDENCE_DIR}/secretariat/responses.jsonl`, payResp);
  runLog.push(payResp);

  // Poll final state (observable evidence via GET status endpoint)
  let finalState = null;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await fetchJson(`${SECRETARIAT}/v1/requests/${requestId}`, {});
    finalState = st;
    appendJsonl(`${EVIDENCE_DIR}/secretariat/responses.jsonl`, { ts: now(), client, scenario, step: "poll-status", iteration: i, status: st.status, body: st.body });
    if (["COMPLETED","FAILED","UNRESOLVABLE","UNKNOWN"].includes(st.body?.status)) break;
  }
  return { client, scenario, requestId, stageA: respEntry, stageB: payResp, finalState, runLog,
           verdict: classify(scenario, respEntry, payResp, finalState) };
}

function classify(scenario, a, b, f) {
  const s = f?.body?.status;
  if (b.status >= 400) return `POLICY/PAYMENT GATE REJECTION (${b.body?.error?.code ?? b.status})`;
  if (s === "COMPLETED") return "DELIVERED";
  if (s === "FAILED") return "EXECUTION FAILED (evidenced)";
  if (s === "UNRESOLVABLE") return "PAYMENT UNRESOLVABLE";
  if (s === "UNKNOWN") return "DELIVERY / RESPONSE UNKNOWN";
  if (s === "PROCESSING") return "STILL PROCESSING AT POLL END (outcome unknown)";
  return `STATE ${s ?? "?"}`;
}

// ---- main ----
const [client, scenario] = process.argv.slice(2);
if (!CLIENT_KEYS[client] || !SCENARIOS[scenario]) { console.error("usage: client-driver.mjs <ClawRouter|Franklin|BlockRun> <S0..S5> [--with-policy-id]"); process.exit(2); }
const withPolicyId = process.argv.includes("--with-policy-id");
console.log(`[${now()}] START client=${client} scenario=${scenario} mode=${SCENARIOS[scenario].mode}`);
const result = await runScenario(client, scenario, { noPolicyId: !withPolicyId });
fs.mkdirSync(`${EVIDENCE_DIR}/runs`, { recursive: true });
fs.writeFileSync(`${EVIDENCE_DIR}/runs/${client.toLowerCase()}-${scenario}-run.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ client, scenario, verdict: result.verdict, stoppedAt: result.stoppedAt, requestId: result.requestId, finalStatus: result.finalState?.body?.status }, null, 2));
