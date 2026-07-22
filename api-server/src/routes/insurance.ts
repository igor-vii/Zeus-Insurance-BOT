import { Router } from "express";
import { z } from "zod";
import { encodeFunctionData, isAddress } from "viem";
import {
  isAutomaticModeAvailable,
  createPolicyFromServer,
} from "../services/insurance.js";
import { getSellerHistory } from "../services/sellerHistory.js";
import { calculateRiskScore, calculatePremium } from "../services/pricing.js";
import { publicClient } from "../lib/chain.js";
import {
  ZEUS_INSURANCE_ADDRESS,
  ZEUS_INSURANCE_ABI,
  ZEUS_RESERVE_ADDRESS,
  ZEUS_RESERVE_ABI,
} from "../lib/contracts-server.js";
import {
  getCachedPolicies,
  getCachedPolicy,
  invalidatePolicy,
} from "../lib/policy-cache.js";
import {
  fetchAndCachePolicies,
  fetchAndCachePolicy,
} from "../lib/chain-sync.js";
import { syncAllBuyers } from "../lib/background-sync.js";

const router = Router();

// ─── GET /api/quote ───────────────────────────────────────────────────────────
const quoteSchema = z.object({
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  maxRetries: z.coerce.number().int().min(1).max(10),
});

router.get("/quote", (req, res) => {
  const parsed = quoteSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { amount, maxRetries } = parsed.data;
  const premiumBps = 700 + (maxRetries - 1) * 200;
  const premiumAmount = (BigInt(amount) * BigInt(premiumBps)) / 10000n;
  res.json({ premiumBps, premiumAmount: premiumAmount.toString(), totalCost: premiumAmount.toString() });
});

// ─── POST /api/prepare-buy ────────────────────────────────────────────────────
const prepareBuySchema = z.object({
  seller: z.string().refine(isAddress, "Invalid seller address"),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  // Accept both "timeout" and "timeoutSeconds" for ergonomics
  timeoutSeconds: z.coerce.number().int().min(60).optional(),
  timeout: z.coerce.number().int().min(60).optional(),
  maxRetries: z.coerce.number().int().min(1).max(10),
  apiEndpoint: z.string().url().optional(),
}).transform(d => ({
  ...d,
  timeoutSeconds: d.timeoutSeconds ?? d.timeout ?? 3600,
}));

router.post("/prepare-buy", async (req, res) => {
  const parsed = prepareBuySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { seller, amount, timeoutSeconds, maxRetries } = parsed.data;
  const amountBigInt = BigInt(amount);

  // ── Dynamic pricing: Risk Score → premium ────────────────────────────────
  let riskScore: number;
  let premiumAmount: bigint;
  try {
    const history = await getSellerHistory(seller);
    riskScore = await calculateRiskScore(seller, amountBigInt, maxRetries, history);
    premiumAmount = await calculatePremium(amountBigInt, riskScore);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to calculate risk score", detail: msg });
    return;
  }

  // ── Automatic mode — server broadcasts the transaction on behalf of agent ──
  if (isAutomaticModeAvailable()) {
    try {
      const result = await createPolicyFromServer({
        seller,
        amount: amountBigInt,
        timeout: timeoutSeconds,
        retries: maxRetries,
      });
      res.json({
        mode: "automatic",
        policyId: result.policyId,
        txHash: result.txHash,
        riskScore,
        premiumAmount: premiumAmount.toString(),
      });
      return;
    } catch (err: unknown) {
      // If automatic mode fails, fall through to hybrid so the agent can retry
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Automatic mode failed", detail: msg });
      return;
    }
  }

  // ── Hybrid mode — return calldata for the agent to sign and broadcast ──
  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "buyInsurance",
    args: [seller as `0x${string}`, amountBigInt, BigInt(timeoutSeconds), BigInt(maxRetries)],
  });

  res.json({
    mode: "hybrid",
    to: ZEUS_INSURANCE_ADDRESS,
    data,
    riskScore,
    premiumAmount: premiumAmount.toString(),
  });
});

// ─── GET /api/policies/sync (manual trigger) ─────────────────────────────────
router.get("/policies/sync", async (_req, res) => {
  try {
    const result = await syncAllBuyers();
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Sync failed", detail: msg });
  }
});

// ─── GET /api/policies?buyer= ─────────────────────────────────────────────────
const policiesQuerySchema = z.object({
  buyer: z.string().refine(isAddress, "Invalid buyer address"),
});

router.get("/policies", async (req, res) => {
  const parsed = policiesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { buyer } = parsed.data;

  const cached = await getCachedPolicies(buyer);
  if (cached !== null) {
    res.json({ policies: cached, source: "cache" });
    return;
  }

  try {
    const policies = await fetchAndCachePolicies(buyer);
    res.json({ policies, source: "chain" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Failed to fetch policies from chain", detail: msg });
  }
});

// ─── GET /api/policies/:id ────────────────────────────────────────────────────
router.get("/policies/:id", async (req, res) => {
  const idStr = req.params.id;
  if (!/^\d+$/.test(idStr)) {
    res.status(400).json({ error: "Invalid policy ID" });
    return;
  }

  const cached = await getCachedPolicy(idStr);
  if (cached !== null) {
    res.json({ policy: cached, source: "cache" });
    return;
  }

  try {
    const policy = await fetchAndCachePolicy(idStr);
    if (!policy) {
      res.status(502).json({ error: "Failed to fetch policy from chain" });
      return;
    }
    res.json({ policy, source: "chain" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Failed to fetch policy from chain", detail: msg });
  }
});

// ─── POST /api/claim ──────────────────────────────────────────────────────────
const claimSchema = z.object({
  policyId: z.string().regex(/^\d+$/, "policyId must be a non-negative integer string"),
});

router.post("/claim", async (req, res) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { policyId } = parsed.data;

  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "claimPayout",
    args: [BigInt(policyId)],
  });

  // Stale the cache entry immediately — isPaidOut will change after the tx
  void invalidatePolicy(policyId);

  res.json({ to: ZEUS_INSURANCE_ADDRESS, data });
});

// ─── GET /api/reserve ─────────────────────────────────────────────────────────
router.get("/reserve", async (_req, res) => {
  try {
    const results = await publicClient.multicall({
      contracts: [
        { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "getReserveBalance" },
        { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "minReserveThreshold" },
        { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "maxDailyPayout" },
        { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "remainingDailyPayout" },
        { address: ZEUS_RESERVE_ADDRESS, abi: ZEUS_RESERVE_ABI, functionName: "isAdequatelyFunded" },
      ],
    });

    const [balance, minThreshold, maxDailyPayout, remainingDailyPayout, isAdequatelyFunded] = results;

    if (
      balance.status !== "success" ||
      minThreshold.status !== "success" ||
      maxDailyPayout.status !== "success" ||
      remainingDailyPayout.status !== "success" ||
      isAdequatelyFunded.status !== "success"
    ) {
      res.status(502).json({ error: "One or more reserve reads failed" });
      return;
    }

    res.json({
      balance: (balance.result as bigint).toString(),
      minThreshold: (minThreshold.result as bigint).toString(),
      maxDailyPayout: (maxDailyPayout.result as bigint).toString(),
      remainingDailyPayout: (remainingDailyPayout.result as bigint).toString(),
      isAdequatelyFunded: isAdequatelyFunded.result as boolean,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Failed to fetch reserve data from chain", detail: msg });
  }
});

// ─── POST /api/observation ────────────────────────────────────────────────────
// Relay a signed watcher observation to the ZeusInsuranceV2 oracle.
//
// Hybrid mode  (default): returns ABI-encoded calldata for the caller to broadcast.
// Automatic mode (SERVER_PRIVATE_KEY set): server relays the tx and returns txHash.
//
// The observation struct must be signed by a registered watcher using EIP-191
// personal_sign over keccak256(requestId, timestamp, status, metadataHash, nonce).
// Any EOA can relay — the contract verifies authenticity via ECDSA.

const SUBMIT_OBSERVATION_ABI = [
  {
    name: "submitObservation",
    type: "function",
    inputs: [
      { name: "policyId", type: "uint256" },
      {
        name: "obs",
        type: "tuple",
        components: [
          { name: "requestId",    type: "bytes32" },
          { name: "timestamp",    type: "uint256" },
          { name: "status",       type: "uint8"   },
          { name: "metadataHash", type: "bytes32" },
          { name: "nonce",        type: "uint256" },
          { name: "signature",    type: "bytes"   },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const bytes32Regex = /^0x[a-fA-F0-9]{64}$/;
const bytesHexRegex = /^0x[a-fA-F0-9]*$/;

const observationBodySchema = z.object({
  policyId: z.coerce.number().int().nonnegative(),
  observation: z.object({
    requestId:    z.string().regex(bytes32Regex,   "requestId must be a 32-byte hex string"),
    timestamp:    z.coerce.number().int().nonnegative(),
    status:       z.coerce.number().int().min(0).max(3),
    metadataHash: z.string().regex(bytes32Regex,   "metadataHash must be a 32-byte hex string"),
    nonce:        z.coerce.number().int().nonnegative(),
    signature:    z.string().regex(bytesHexRegex,  "signature must be a hex string"),
  }),
});

router.post("/observation", async (req, res) => {
  const parsed = observationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { policyId, observation: obs } = parsed.data;

  // ── Automatic mode — server relays the transaction ────────────────────────
  if (isAutomaticModeAvailable()) {
    try {
      const { ethers: ethersLib } = await import("ethers");
      const { ZeusSDK } = await import("@zeus/sdk");
      const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
      const provider = new ethersLib.JsonRpcProvider(rpcUrl);
      const signer = new ethersLib.Wallet(process.env["SERVER_PRIVATE_KEY"]!, provider);
      const sdk = new ZeusSDK();
      await sdk.connect(
        process.env["ZEUS_INSURANCE_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "base-sepolia",
        signer,
      );
      const result = await sdk.insurance.submitObservation(policyId, {
        requestId:    obs.requestId,
        timestamp:    obs.timestamp,
        status:       obs.status as 0 | 1 | 2 | 3,
        metadataHash: obs.metadataHash,
        nonce:        obs.nonce,
        signature:    obs.signature,
      });
      res.json({ mode: "automatic", txHash: result.hash, policyId });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Automatic relay failed", detail: msg });
      return;
    }
  }

  // ── Hybrid mode — return calldata for the caller to broadcast ─────────────
  try {
    const data = encodeFunctionData({
      abi: SUBMIT_OBSERVATION_ABI,
      functionName: "submitObservation",
      args: [
        BigInt(policyId),
        {
          requestId:    obs.requestId    as `0x${string}`,
          timestamp:    BigInt(obs.timestamp),
          status:       obs.status,
          metadataHash: obs.metadataHash as `0x${string}`,
          nonce:        BigInt(obs.nonce),
          signature:    obs.signature    as `0x${string}`,
        },
      ],
    });
    res.json({ mode: "hybrid", to: ZEUS_INSURANCE_ADDRESS, data, policyId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to encode calldata", detail: msg });
  }
});

export default router;
