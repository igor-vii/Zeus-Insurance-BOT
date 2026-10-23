/**
 * B-BS-17-live canary — replay of a used EIP-3009 nonce against a LIVE stack.
 *
 * Attacker model: anyone who observed a settled payment payload (the seller,
 * a wire tap, a leaked log) re-presents it DIRECTLY to the facilitator hoping
 * for a second settlement. On a healthy stack EVERY replay must be rejected
 * (single-use authorization nonce — EIP-3009 authorizationState), and the
 * Secretariat ledger must keep exactly ONE settlement for the operation.
 * The Secretariat is deliberately NOT in the replay loop: a real double-spend
 * bypasses it.
 *
 * This is a LIVE-drill canary (not part of the CI gate — the gate proves the
 * same contract against the chain-faithful mock facilitator in B-BS-17).
 *
 * Usage (against the sandbox stack, lab topology):
 *   SECRETARIAT_URL=http://127.0.0.1:8080 \
 *   FACILITATOR_URL=http://127.0.0.1:9977/facilitator \
 *   DATABASE_URL=postgres://... \
 *   node api-server/e2e/canary-live-replay.mjs
 *
 * Exit codes: 0 = canary green (all replays rejected, ledger single-settle);
 *             2 = LEAK (a replay was accepted — double-spend!); 1 = setup error.
 */

import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";

const SECRETARIAT = process.env.SECRETARIAT_URL ?? "http://127.0.0.1:8080";
const FACILITATOR = (process.env.FACILITATOR_URL ?? "http://127.0.0.1:9977/facilitator").replace(/\/$/, "");
const REPLAYS = Number(process.env.REPLAY_ATTEMPTS ?? 3);

const CLIENT_KEY = process.env.CLIENT_KEY
  ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CLIENT_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SELLER_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc";
const USDC_NAME = "USD Coin";
const USDC_VERSION = "2";
const USDC_ASSET = process.env.USDC_ASSET ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
const NETWORK = process.env.NETWORK ?? "base-sepolia";
const AMOUNT = process.env.AMOUNT ?? "10000";
const TARGET = process.env.TARGET_URL ?? "https://resource.example.com/paid-content";

const nonce32 = () =>
  "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

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
    message: { from: CLIENT_ADDR, to: payTo, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: nonceHex },
  });
}

async function main() {
  const account = privateKeyToAccount(CLIENT_KEY);

  // ---- Stage A: discover the payment requirement through the Secretariat ----
  const create = await fetch(`${SECRETARIAT}/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: TARGET,
      method: "POST",
      payload: { prompt: "canary-live-replay" },
      clientId: `canary-replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      authorizer: CLIENT_ADDR,
      policy: {
        maxPrice: "100000",
        allowedNetworks: [NETWORK],
        allowedAssets: [USDC_ASSET],
        allowedSellers: [SELLER_ADDR],
        authorizationMode: "explicit",
      },
    }),
  });
  const created = await create.json().catch(() => ({}));
  if (create.status !== 201 || !created.paymentIntent) {
    console.error(`[canary] setup failed: create=${create.status} ${JSON.stringify(created).slice(0, 200)}`);
    process.exit(1);
  }
  const pi = created.paymentIntent;

  // ---- Stage B: honest settle (the only settlement this canary makes) ----
  const binding = { payTo: pi.payTo, value: pi.value, nonceHex: pi.nonce, validAfter: pi.validAfter, validBefore: pi.validBefore };
  const signature = await signEip3009(account, binding);
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "exact", network: NETWORK, amount: pi.value, asset: USDC_ASSET,
      payTo: pi.payTo, maxTimeoutSeconds: 300, extra: { name: USDC_NAME, version: USDC_VERSION },
    },
    payload: { signature, authorization: { from: CLIENT_ADDR, to: pi.payTo, value: pi.value, validAfter: String(pi.validAfter), validBefore: String(pi.validBefore), nonce: pi.nonce } },
  };
  const pay = await fetch(`${SECRETARIAT}/v1/requests/${created.requestId}/payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const payBody = await pay.json().catch(() => ({}));
  console.log(`[canary] settle: http=${pay.status} tx=${payBody?.settlementTxHash ?? "-"}`);
  if (pay.status !== 200) {
    console.error("[canary] the single honest settle failed — nothing to replay");
    process.exit(1);
  }

  // ---- Attack: replay the used authorization DIRECTLY to the facilitator ----
  const paymentHeader = Buffer.from(JSON.stringify(payload)).toString("base64");
  let accepted = 0;
  for (let i = 1; i <= REPLAYS; i++) {
    const res = await fetch(`${FACILITATOR}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentHeader, resource: TARGET, network: NETWORK }),
    });
    const body = await res.json().catch(() => ({}));
    const rejected = res.status >= 400 || body?.success === false;
    console.log(`[canary] replay ${i}/${REPLAYS}: http=${res.status} ${rejected ? "REJECTED" : "ACCEPTED"} ${body?.errorReason ?? body?.error ?? ""}`);
    if (!rejected) accepted++;
  }

  // ---- Ledger: the Secretariat must still hold exactly one settlement ----
  let ledgerNote = "PG check skipped (no DATABASE_URL)";
  let ledgerOk = true;
  if (process.env.DATABASE_URL) {
    try {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const q = await pool.query(
        `SELECT count(*)::int AS n FROM payment_intents WHERE request_id = $1 AND settlement_state = 'SETTLED'`,
        [created.requestId],
      );
      const tx = await pool.query(
        `SELECT count(DISTINCT tx_hash)::int AS n FROM payment_intents WHERE request_id = $1 AND tx_hash IS NOT NULL`,
        [created.requestId],
      );
      await pool.end();
      ledgerOk = q.rows[0].n === 1 && tx.rows[0].n === 1;
      ledgerNote = `settledIntents=${q.rows[0].n} distinctTx=${tx.rows[0].n}`;
    } catch (e) {
      ledgerOk = false;
      ledgerNote = `PG check failed: ${String(e).slice(0, 120)}`;
    }
  }

  console.log(`\n[canary] ledger: ${ledgerNote}`);
  if (accepted > 0) {
    console.error(`[canary] VERDICT: LEAK — ${accepted} replay(s) were ACCEPTED (double-spend!)`);
    process.exit(2);
  }
  if (!ledgerOk) {
    console.error("[canary] VERDICT: LEDGER_ANOMALY — replays rejected but the ledger is not single-settle");
    process.exit(2);
  }
  console.log("[canary] VERDICT: GREEN — every replay rejected, ledger single-settle");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
