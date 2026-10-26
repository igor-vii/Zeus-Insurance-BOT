/**
 * Zeus testnet rig — FULL live cycle on a base-sepolia fork (anvil @ 8545):
 *
 *   payer (viem EIP-3009 signature)
 *     → StandardX402Transport  (zeus-secretariat real code, PAYMENT-SIGNATURE)
 *       → OFFICIAL @x402/express seller (unpatched v2 middleware, port 4021)
 *         → OUR zeus-facilitator (real node:http server, port 3001)
 *           → anvil fork of sepolia.base.org: transferWithAuthorization ON-CHAIN
 *         ← {success, transaction}
 *       ← PAYMENT-RESPONSE (base64 receipt)
 *     ← SUBMITTED(txHash)
 *   → on-chain assertions: balances, AuthorizationUsed event, replay refused
 *
 * Every actor is the REAL production code path — no mocks anywhere.
 */
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import express from "express";
import { createPublicClient, createWalletClient, http, toFunctionSelector, toHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

// Reuse the REAL client transport from the repo.
import { StandardX402Transport } from "../../zeus-secretariat/src/core/standard-x402-transport.js";
import type { DurableEvidenceStore, DurablePaymentIntent } from "../../zeus-secretariat/src/core/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ANVIL = "http://127.0.0.1:8545";
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const; // Base Sepolia USDC
const DOMAIN = { name: "USDC", version: "2" } as const; // verified live (D1 follow-up)
const PRICE = "1000"; // $0.001 in atomic units
const FACILITATOR_PORT = 3001;
const SELLER_PORT = 4021;
const FACILITATOR_DIST = pathResolve(import.meta.dirname, "../../zeus-facilitator/dist/server.js");
const EVIDENCE_DIR = pathResolve(import.meta.dirname, "evidence");

// Fresh keys every run (no reliance on remembered anvil mnemonics).
const freshKey = () => ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
// Keep the RAW key strings: viem v2 account objects do not expose .privateKey.
const PAYER_KEY = freshKey();
const MINTER_KEY = freshKey();
const GAS_KEY = freshKey();
const payer = privateKeyToAccount(PAYER_KEY);
const minter = privateKeyToAccount(MINTER_KEY);
const gasPayer = privateKeyToAccount(GAS_KEY);
const treasury = privateKeyToAccount(freshKey()).address;

const logPath = `${EVIDENCE_DIR}/rig.log`;
mkdirSync(EVIDENCE_DIR, { recursive: true });
function log(...args: unknown[]) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  appendFileSync(logPath, line + "\n");
}
function fail(msg: string): never {
  log("FAIL:", msg);
  process.exit(1);
}

const publicClient = createPublicClient({ transport: http(ANVIL) });

// direct JSON-RPC helper for anvil_* cheatcodes
async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`rpc ${method}: ${json.error.message}`);
  return json.result;
}

const ERC20_ABI = [
  { name: "masterMinter", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "configureMinter", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "authorizationState", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "uint8" }] },
  { name: "isAuthorized", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

async function fundWallets(): Promise<void> {
  // ETH for the minter and facilitator gas payer (payer is gasless via EIP-3009).
  await rpc("anvil_setBalance", [minter.address, toHex(10n ** 18n)]);
  await rpc("anvil_setBalance", [gasPayer.address, toHex(10n ** 18n)]);

  // USDC via the FiatToken mint path: impersonate masterMinter, configureMinter, mint.
  const walletMinter = createWalletClient({ account: minter, transport: http(ANVIL) });
  const masterMinter = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "masterMinter" });
  await rpc("anvil_impersonateAccount", [masterMinter]);
  await rpc("anvil_setBalance", [masterMinter, toHex(10n ** 18n)]); // impersonated account still pays gas
  const mintAllowance = 10n ** 12n;
  const cfgHash = (await rpc("eth_sendTransaction", [
    {
      from: masterMinter,
      to: USDC,
      data: `${toFunctionSelector("configureMinter(address,uint256)")}${minter.address.slice(2).toLowerCase().padStart(64, "0")}${mintAllowance.toString(16).padStart(64, "0")}`,
    },
  ])) as `0x${string}`;
  let receipt = await publicClient.waitForTransactionReceipt({ hash: cfgHash });
  if (receipt.status !== "success") fail(`configureMinter reverted: ${cfgHash}`);

  const mintHash = await walletMinter.sendTransaction({
    chain: null,
    to: USDC,
    data: `${toFunctionSelector("mint(address,uint256)")}000000000000000000000000${payer.address.slice(2).toLowerCase()}${(10_000_000).toString(16).padStart(64, "0")}`,
  });
  receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  if (receipt.status !== "success") fail(`mint reverted: ${mintHash}`);

  const bal = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] });
  log(`[fund] payer=${payer.address} USDC=${bal} (10 USDC)`);
  if (bal < 10_000_000n) fail("payer USDC funding failed");
}

// ---------------------------------------------------------------------------
// zeus-facilitator (real server, child process)
// ---------------------------------------------------------------------------
let facilChild: ReturnType<typeof spawn> | null = null;
process.on("exit", () => { try { facilChild?.kill("SIGKILL"); } catch { /* already gone */ } });

async function startFacilitator(): Promise<ReturnType<typeof spawn>> {
  const child = spawn("node", [FACILITATOR_DIST], {
    env: {
      ...process.env,
      ZEUS_FACILITATOR_NETWORK: "eip155:84532",
      ZEUS_FACILITATOR_RPC_URLS: ANVIL,
      ZEUS_FACILITATOR_GAS_PRIVATE_KEY: GAS_KEY,
      PORT: String(FACILITATOR_PORT),
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  facilChild = child;
  child.stdout.on("data", (d) => appendFileSync(logPath, `[facilitator] ${d}`));
  child.stderr.on("data", (d) => appendFileSync(logPath, `[facilitator:err] ${d}`));
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${FACILITATOR_PORT}/health`);
      if (res.ok) {
        const h = (await res.json()) as { payer?: string };
        // Identity check: a STALE facilitator from a previous rig run could
        // still be listening on this port — refuse to proceed on a mismatch.
        if (h.payer?.toLowerCase() !== gasPayer.address.toLowerCase()) {
          fail(`port ${FACILITATOR_PORT} is held by a foreign facilitator (payer ${h.payer}) — kill it first`);
        }
        const sup = await fetch(`http://127.0.0.1:${FACILITATOR_PORT}/supported`);
        if (!sup.ok) fail(`facilitator /supported is not available (${sup.status}) — stale build?`);
        log(`[facilitator] up on :${FACILITATOR_PORT} (gas payer ${gasPayer.address})`);
        return child;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("facilitator did not boot — see rig.log");
}

// ---------------------------------------------------------------------------
// OFFICIAL seller (express + @x402/express, exactly as api-server wires it)
// ---------------------------------------------------------------------------
let paidExecutions = 0;

function startSeller(): Promise<unknown> {
  const app = express();
  app.use(express.json());
  const facilitatorClient = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${FACILITATOR_PORT}` });
  const resourceServer = new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        "POST /paid/data": {
          accepts: [
            {
              scheme: "exact",
              price: { amount: PRICE, asset: USDC, extra: { name: DOMAIN.name, version: DOMAIN.version } },
              network: "eip155:84532",
              payTo: treasury,
              maxTimeoutSeconds: 60,
            },
          ],
          description: "Zeus testnet probe resource",
        },
      },
      resourceServer,
    ),
  );
  app.post("/paid/data", (req, res) => {
    paidExecutions++;
    res.json({ ok: true, data: "top-secret-probe", sawBody: req.body ?? null });
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(SELLER_PORT, () => {
      log(`[seller] official @x402/express on :${SELLER_PORT}, payTo=${treasury}`);
      resolve(null);
    });
    server.on("error", (err) => reject(new Error(`seller listen failed: ${err.message} — stale process on ${SELLER_PORT}?`)));
  });
}

// ---------------------------------------------------------------------------
// Minimal in-memory durable store (the transport's bookkeeping contract)
// ---------------------------------------------------------------------------
function makeStore(): DurableEvidenceStore {
  const intents = new Map<string, { state: string; txHash?: string }>();
  return {
    async transitionToSubmitting(id: string) {
      const it = intents.get(id) ?? { state: "PENDING" };
      if (it.state !== "PENDING") return false;
      it.state = "SUBMITTING";
      intents.set(id, it);
      return true;
    },
    async compareAndSetState(id: string, from: string, to: string, extra: Record<string, unknown>) {
      const it = intents.get(id);
      if (!it || it.state !== from) return false;
      it.state = to;
      if (extra && typeof extra === "object" && "txHash" in extra && typeof extra.txHash === "string") it.txHash = extra.txHash;
      intents.set(id, it);
      return true;
    },
    async recordSubmissionResult(id: string, state: string, txHash?: string) {
      const it = intents.get(id) ?? { state: "PENDING" };
      it.state = state;
      if (txHash) it.txHash = txHash;
      intents.set(id, it);
      return true;
    },
    async markNonceSubmitted() { return true; },
  } as unknown as DurableEvidenceStore;
}

function makeIntent(id: string): DurablePaymentIntent {
  return { paymentIntentId: id, operationId: `rig-${id}`, nonce: ("0x" + randomBytes(32).toString("hex")) as `0x${string}` } as unknown as DurablePaymentIntent;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  process.env["ZEUS_EGRESS_ALLOWED_HOSTS"] = "127.0.0.1";
  const sellerUrl = `http://127.0.0.1:${SELLER_PORT}/paid/data`;

  log("== [1/7] funding wallets on the base-sepolia fork ==");
  await fundWallets();

  log("== [2/7] booting zeus-facilitator ==");
  const facil = await startFacilitator();

  log("== [3/7] booting OFFICIAL @x402/express seller ==");
  await startSeller();

  log("== [4/7] discovery: unpaid probe → 402 PAYMENT-REQUIRED ==");
  const probe = await fetch(sellerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ probe: "zeus-rig" }),
  });
  if (probe.status !== 402) fail(`expected 402 on discovery, got ${probe.status}`);
  const prHeader = probe.headers.get("PAYMENT-REQUIRED");
  if (!prHeader) fail("402 lacks PAYMENT-REQUIRED header");
  const pr = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8")) as {
    x402Version: number;
    accepts: Array<{ scheme: string; network: string; asset: string; amount?: string; payTo: string; maxTimeoutSeconds: number; extra?: { name?: string; version?: string } }>;
  };
  const req0 = pr.accepts[0];
  log(`[discovery] x402Version=${pr.x402Version} network=${req0.network} asset=${req0.asset} payTo=${req0.payTo} extra=${JSON.stringify(req0.extra)}`);
  if (pr.x402Version !== 2 || req0.network !== "eip155:84532") fail("discovery payload is not canonical v2 for eip155:84532");
  if (req0.extra?.name !== DOMAIN.name || req0.extra?.version !== DOMAIN.version) fail(`seller domain mismatch: ${JSON.stringify(req0.extra)}`);

  log("== [5/7] signing EIP-3009 authorization (payer) ==");
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: payer.address,
    to: req0.payTo,
    value: PRICE,
    validAfter: String(now - 600),
    validBefore: String(now + 3600),
    nonce: ("0x" + randomBytes(32).toString("hex")) as `0x${string}`,
  };
  const signature = await payer.signTypedData({
    domain: { name: DOMAIN.name, version: DOMAIN.version, chainId: CHAIN_ID, verifyingContract: USDC },
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
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  const payload = {
    x402Version: 2,
    resource: { url: sellerUrl, description: "Zeus testnet probe resource" },
    accepted: {
      scheme: req0.scheme,
      network: req0.network,
      amount: PRICE,
      asset: req0.asset,
      payTo: req0.payTo,
      maxTimeoutSeconds: req0.maxTimeoutSeconds,
      extra: { name: DOMAIN.name, version: DOMAIN.version },
    },
    payload: { signature, authorization },
  };
  log(`[sign] from=${authorization.from} value=${authorization.value} nonce=${authorization.nonce}`);

  log("== [6/7] paid call via StandardX402Transport (real repo code) ==");
  const balBeforePayer = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] });
  const balBeforeTreasury = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [treasury] });

  const transport = new StandardX402Transport({ timeoutMs: 20_000 }, makeStore());
  const result = await transport.submit(makeIntent("happy"), payload as never, {
    url: sellerUrl,
    method: "POST",
    body: JSON.stringify({ probe: "zeus-rig" }),
  });
  log("[transport]", { status: result.status, txHash: result.txHash });
  if (result.status !== "SUBMITTED") fail(`expected SUBMITTED, got ${result.status}: ${JSON.stringify(result)}`);
  const txHash = result.txHash as string;

  const paidBody = (result.rawResponse as { sellerBody?: { ok?: boolean; data?: string } }).sellerBody;
  if (paidBody?.ok !== true || paidBody.data !== "top-secret-probe") fail(`paid route body wrong: ${JSON.stringify(paidBody)}`);

  log("== [7/7] hostile replay: same signature again → must be refused ==");
  const replay = await transport.submit(makeIntent("replay"), payload as never, {
    url: sellerUrl,
    method: "POST",
    body: JSON.stringify({ probe: "zeus-rig-replay" }),
  });
  log("[replay]", { status: replay.status });
  if (replay.status === "SUBMITTED") fail("REPLAY WAS ACCEPTED — nonce guard failed");

  // --------------------------- on-chain truth ---------------------------
  log("== on-chain assertions ==");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  log(`[chain] settlement tx status=${receipt.status} block=${receipt.blockNumber}`);
  if (receipt.status !== "success") fail("settlement tx reverted on-chain");

  const authUsedTopic = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
  const hasAuthUsed = receipt.logs.some(
    (l) =>
      l.address.toLowerCase() === USDC.toLowerCase() &&
      l.topics[0] === authUsedTopic &&
      // topics are 32-byte left-padded — compare the last 20 bytes (= address)
      l.topics[1]?.toLowerCase().slice(-40) === authorization.from.toLowerCase().slice(-40) &&
      l.topics[2]?.toLowerCase() === authorization.nonce.toLowerCase(),
  );
  if (!hasAuthUsed) fail("AuthorizationUsed(from,nonce) event not found in settlement receipt");

  const balAfterPayer = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] });
  const balAfterTreasury = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [treasury] });
  log(`[chain] payer ${balBeforePayer} -> ${balAfterPayer}, treasury ${balBeforeTreasury} -> ${balAfterTreasury}`);
  if (balBeforePayer - balAfterPayer !== BigInt(PRICE)) fail("payer USDC did not decrease by exactly the price");
  if (balAfterTreasury - balBeforeTreasury !== BigInt(PRICE)) fail("treasury USDC did not increase by exactly the price");

  if (replay.status !== "REJECTED" && replay.status !== "UNKNOWN") fail(`replay classification unexpected: ${replay.status}`);
  if (paidExecutions !== 1) fail(`paid route executed ${paidExecutions} times (expected exactly 1)`);

  const evidence = {
    run: new Date().toISOString(),
    chain: `base-sepolia fork via anvil @ ${ANVIL}`,
    payer: payer.address,
    treasury,
    facilitatorGasPayer: gasPayer.address,
    facilitatorPort: FACILITATOR_PORT,
    sellerPort: SELLER_PORT,
    sellerStack: "@x402/core+express+evm 2.28.0 (official, unpatched)",
    clientTransport: "zeus-secretariat StandardX402Transport (repo source)",
    discovery: { x402Version: pr.x402Version, network: req0.network, asset: req0.asset, payTo: req0.payTo, domain: req0.extra },
    settlementTx: txHash,
    payerBalance: { before: String(balBeforePayer), after: String(balAfterPayer) },
    treasuryBalance: { before: String(balBeforeTreasury), after: String(balAfterTreasury) },
    authorizationUsedEvent: true,
    hostileReplay: { status: replay.status, paidExecutions },
    paidBody,
  };
  writeFileSync(`${EVIDENCE_DIR}/result.json`, JSON.stringify(evidence, null, 2));
  log("PASS: full live cycle — transport → official seller → zeus-facilitator → on-chain settle → PAYMENT-RESPONSE");
  log(`evidence: ${EVIDENCE_DIR}/result.json`);
  facil.kill("SIGTERM");
  process.exit(0);
}

main().catch((err) => {
  log("RIG CRASHED:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
