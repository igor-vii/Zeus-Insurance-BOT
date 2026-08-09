import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { encodeFunctionData, isAddress } from "viem";
import {
  isAutomaticModeAvailable,
  createPolicyFromServer,
  createSlashingProtectionFromServer,
} from "../services/insurance.js";
import { getSellerHistory } from "../services/sellerHistory.js";
import {
  calculateRiskScore,
  calculateSellerPremium,
  getAgentMultiplier,
  resetAgentStatus,
  type AgentStatus,
  type ErrorHistory,
  DAILY_ERROR_HARD_THRESHOLD,
} from "../services/pricing.js";
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
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import {
  getAgentStatus as getAgentStatusFromStore,
  setAgentStatus,
  deleteAgentStatus,
  recordDailyError as recordDailyErrorInStore,
  getDailyErrorCount as getDailyErrorCountFromStore,
  clearAgentErrors as clearAgentErrorsInStore,
} from "../lib/agent-store.js";
import { getRedis } from "../lib/redis.js";


const chainLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-ignore - known compat issue with v4
    sendCommand: async (...args: string[]) => {
      const r = await getRedis();
      if (!r) return 0;
      return (r as any).sendCommand(args);
    },
  }),
  message: { error: "Too many on-chain requests, try again later" },
  skip: () => !process.env.REDIS_URL,
});

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
// 1. AGENT STATUS + ROLLING DAILY ERROR STORE
// ──────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_EXTRA_MS = 24 * 60 * 60 * 1000;

async function getAgentStatus(address: string): Promise<AgentStatus> {
  return await getAgentStatusFromStore(address);
}

async function getDailyErrorCount(address: string): Promise<number> {
  return await getDailyErrorCountFromStore(address, DAY_MS);
}

async function recordDailyError(address: string): Promise<{ count: number; blockedUntil: number | null }> {
  const key = address.toLowerCase();
  const now = Date.now();
  const { count } = await recordDailyErrorInStore(address, DAY_MS);

  let blockedUntil: number | null = null;
  if (count > DAILY_ERROR_HARD_THRESHOLD) {
    blockedUntil = now + DAY_MS;
    await setAgentStatus(key, {
      blockedUntil,
      cooldownEnd: now + DAY_MS + COOLDOWN_EXTRA_MS,
      currentMultiplier: 2.0,
    }, DAY_MS + COOLDOWN_EXTRA_MS);
  }
  return { count, blockedUntil };
}

async function clearAgentErrors(address: string): Promise<void> {
  await clearAgentErrorsInStore(address);
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. GET /api/quote
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// 3. POST /api/prepare-buy
// ──────────────────────────────────────────────────────────────────────────────

const prepareBuySchema = z.object({
  seller: z.string().refine(isAddress, "Invalid seller address"),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  timeoutSeconds: z.coerce.number().int().min(60).optional(),
  timeout: z.coerce.number().int().min(60).optional(),
  maxRetries: z.coerce.number().int().min(1).max(10),
  apiEndpoint: z.string().url().optional(),
}).transform(d => ({
  ...d,
  timeoutSeconds: d.timeoutSeconds ?? d.timeout ?? 3600,
}));

router.post("/prepare-buy", chainLimiter, async (req, res) => {
  const parsed = prepareBuySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { seller, amount, timeoutSeconds, maxRetries, apiEndpoint } = parsed.data;
  const amountBigInt = BigInt(amount);

  let riskScore: number;
  let premiumAmount: bigint;
  try {
    const history = await getSellerHistory(seller);
    const dailyErrors = await getDailyErrorCount(seller);

    const errorHistory: ErrorHistory = {
      total: history.totalPolicies,
      errors: dailyErrors,
      windowHours: 24,
    };

    if (dailyErrors > DAILY_ERROR_HARD_THRESHOLD) {
      res.status(429).json({
        error: "Agent temporarily blocked",
        detail: `Daily error count ${dailyErrors} exceeds limit of ${DAILY_ERROR_HARD_THRESHOLD}`
      });
      return;
    }

    const agentStatus = await getAgentStatus(seller);
    const agentMultiplier = getAgentMultiplier(seller, agentStatus, errorHistory);

    if (agentMultiplier === null) {
      res.status(403).json({
        error: "Agent is currently blocked",
        detail: `Blocked until ${new Date(agentStatus.blockedUntil).toISOString()}`
      });
      return;
    }

    // Автоматическая очистка при полной реабилитации
    if (agentStatus.cooldownEnd > 0 && agentStatus.cooldownEnd < Date.now() && agentMultiplier === 100n) {
      await clearAgentErrors(seller);
    }

    riskScore = await calculateRiskScore(seller, amountBigInt, maxRetries, history);
    const basePremium = await calculateSellerPremium(amountBigInt, riskScore);
    premiumAmount = (basePremium * agentMultiplier) / 100n;

    if (apiEndpoint) {
      console.log(`[Agent ${seller}] Using custom endpoint: ${apiEndpoint}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordDailyError(seller);
    res.status(500).json({ error: "Failed to calculate risk score", detail: msg });
    return;
  }

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
      const msg = err instanceof Error ? err.message : String(err);
      await recordDailyError(seller);
      res.status(502).json({ error: "Automatic mode failed", detail: msg });
      return;
    }
  }

  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "buyInsurance" as never,
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

// ──────────────────────────────────────────────────────────────────────────────
// 4. GET /api/policies/sync
// ──────────────────────────────────────────────────────────────────────────────

router.get("/policies/sync", async (_req, res) => {
  try {
    const result = await syncAllBuyers();
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Sync failed", detail: msg });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. GET /api/policies?buyer=
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// 6. GET /api/policies/:id
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// 7. POST /api/claim
// ──────────────────────────────────────────────────────────────────────────────

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

  void invalidatePolicy(policyId);
  res.json({ to: ZEUS_INSURANCE_ADDRESS, data });
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. GET /api/reserve
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// 8b. GET /api/reserve/status (alias for frontend compatibility)
// ──────────────────────────────────────────────────────────────────────────────

router.get("/reserve/status", async (_req, res) => {
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

// ──────────────────────────────────────────────────────────────────────────────

// 9. POST /api/observation
// ──────────────────────────────────────────────────────────────────────────────

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
          { name: "requestId", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "metadataHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "signature", type: "bytes" },
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
    requestId: z.string().regex(bytes32Regex, "requestId must be a 32-byte hex string"),
    timestamp: z.coerce.number().int().nonnegative(),
    status: z.coerce.number().int().min(0).max(3),
    metadataHash: z.string().regex(bytes32Regex, "metadataHash must be a 32-byte hex string"),
    nonce: z.coerce.number().int().nonnegative(),
    signature: z.string().regex(bytesHexRegex, "signature must be a hex string"),
  }),
});

router.post("/observation", chainLimiter, async (req, res) => {
  const parsed = observationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { policyId, observation: obs } = parsed.data;

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
        requestId: obs.requestId,
        timestamp: obs.timestamp,
        status: obs.status as 0 | 1 | 2 | 3,
        metadataHash: obs.metadataHash,
        nonce: obs.nonce,
        signature: obs.signature,
      });
      res.json({ mode: "automatic", txHash: result.hash, policyId });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Automatic relay failed", detail: msg });
      return;
    }
  }

  try {
    const data = encodeFunctionData({
      abi: SUBMIT_OBSERVATION_ABI,
      functionName: "submitObservation",
      args: [
        BigInt(policyId),
        {
          requestId: obs.requestId as `0x${string}`,
          timestamp: BigInt(obs.timestamp),
          status: obs.status,
          metadataHash: obs.metadataHash as `0x${string}`,
          nonce: BigInt(obs.nonce),
          signature: obs.signature as `0x${string}`,
        },
      ],
    });
    res.json({ mode: "hybrid", to: ZEUS_INSURANCE_ADDRESS, data, policyId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to encode calldata", detail: msg });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 10. POST /api/slashing-protection
// ──────────────────────────────────────────────────────────────────────────────

const slashingBuySchema = z.object({
  validator: z.string().refine(isAddress, "Invalid validator address"),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  timeoutSeconds: z.coerce.number().int().min(60).optional().default(86400),
});

router.post("/slashing-protection", chainLimiter, async (req, res) => {
  const parsed = slashingBuySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { validator, amount, timeoutSeconds } = parsed.data;
  const amountBigInt = BigInt(amount);
  const premiumAmount = (amountBigInt * 500n) / 10_000n;

  if (isAutomaticModeAvailable()) {
    try {
      const result = await createSlashingProtectionFromServer({
        validator,
        amount: amountBigInt,
        timeout: timeoutSeconds,
      });
      res.json({
        mode: "automatic",
        policyId: result.policyId,
        txHash: result.txHash,
        coverageType: "SlashingProtection",
        premiumAmount: premiumAmount.toString(),
      });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Automatic mode failed", detail: msg });
      return;
    }
  }

  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "buySlashingProtection",
    args: [validator as `0x${string}`, amountBigInt, BigInt(timeoutSeconds)] as never,
  });

  res.json({
    mode: "hybrid",
    to: ZEUS_INSURANCE_ADDRESS,
    data,
    coverageType: "SlashingProtection",
    premiumAmount: premiumAmount.toString(),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 11. POST /api/slashing/premium
// ──────────────────────────────────────────────────────────────────────────────

const slashingPremiumSchema = z.object({
  validator: z.string().refine(isAddress, "Invalid validator address"),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  chainId: z.coerce.number().int().positive(),
});

router.post("/slashing/premium", async (req, res) => {
  const parsed = slashingPremiumSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { validator, amount, chainId } = parsed.data;
  const amountBigInt = BigInt(amount);

  let rate = chainId === 677 ? 15 : 15;

  try {
    const history = await getSellerHistory(validator);
    const isNew = !history || history.totalPolicies === 0;
    const hasSlash = history && history.failedPolicies > 0;

    if (hasSlash) rate = 20;
    else if (isNew) rate = 18;
    else rate = 15;
  } catch {
    rate = 18;
  }

  const premiumAmount = (amountBigInt * BigInt(rate)) / 100n;
  res.json({
    premiumAmount: premiumAmount.toString(),
    rate,
    amount,
    validator,
    chainId,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 12. POST /api/report-slashing
// ──────────────────────────────────────────────────────────────────────────────

const reportSlashingSchema = z.object({
  policyId: z.coerce.number().int().nonnegative(),
  evidenceHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "evidenceHash must be a 0x-prefixed 32-byte hex string"),
});

const REPORT_SLASHING_ABI = [
  {
    name: "reportSlashing",
    type: "function",
    inputs: [
      { name: "policyId", type: "uint256" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

router.post("/report-slashing", chainLimiter, async (req, res) => {
  const parsed = reportSlashingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { policyId, evidenceHash } = parsed.data;

  if (isAutomaticModeAvailable()) {
    try {
      const { ethers: ethersLib } = await import("ethers");
      const { ZeusSDK } = await import("@zeus/sdk");
      const rpcUrl = process.env["BOT_CHAIN_MAINNET_RPC_URL"] ??
        process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
      const provider = new ethersLib.JsonRpcProvider(rpcUrl);
      const signer = new ethersLib.Wallet(process.env["SERVER_PRIVATE_KEY"]!, provider);
      const sdk = new ZeusSDK();
      await sdk.connect(
        process.env["ZEUS_INSURANCE_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "base-sepolia",
        signer,
      );
      const result = await sdk.insurance.reportSlashing(policyId, evidenceHash);
      res.json({ mode: "automatic", txHash: result.hash, policyId });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Automatic relay failed", detail: msg });
      return;
    }
  }

  const data = encodeFunctionData({
    abi: REPORT_SLASHING_ABI,
    functionName: "reportSlashing",
    args: [BigInt(policyId), evidenceHash as `0x${string}`],
  });

  res.json({ mode: "hybrid", to: ZEUS_INSURANCE_ADDRESS, data, policyId });
});

// ──────────────────────────────────────────────────────────────────────────────
// 13. POST /api/agent-error
// ──────────────────────────────────────────────────────────────────────────────

const seenEventIds = new Set<string>();
const MAX_SEEN_EVENT_IDS = 10_000;

const agentErrorSchema = z.object({
  agent: z.string().refine(isAddress, "Invalid agent address"),
  eventId: z.string().min(1).max(128).optional(),
});

router.post("/agent-error", (req, res) => {
  const secret = process.env["AGENT_ERROR_SECRET"];
  if (!secret) {
    res.status(503).json({ error: "agent-error endpoint not configured (AGENT_ERROR_SECRET not set)" });
    return;
  }

  const authHeader = req.headers["authorization"];
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!provided || provided !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = agentErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { agent, eventId } = parsed.data;

  if (eventId) {
    if (seenEventIds.has(eventId)) {
      res.json({ agent, duplicate: true });
      return;
    }
    if (seenEventIds.size >= MAX_SEEN_EVENT_IDS) {
      const first = seenEventIds.values().next().value;
      if (first !== undefined) seenEventIds.delete(first);
    }
    seenEventIds.add(eventId);
  }

  const { count, blockedUntil } = await recordDailyError(agent);
  const blocked = count > DAILY_ERROR_HARD_THRESHOLD;

  res.json({
    agent,
    dailyErrors: count,
    blocked,
    blockedUntil: blockedUntil ?? null,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 14. POST /api/admin/reset-agent
// ──────────────────────────────────────────────────────────────────────────────

const resetAgentSchema = z.object({
  agent: z.string().refine(isAddress, "Invalid agent address"),
});

router.post("/admin/reset-agent", (req, res) => {
  const jwtSecret = process.env["ADMIN_JWT_SECRET"];
  if (!jwtSecret) {
    res.status(503).json({ error: "Admin endpoint not configured (ADMIN_JWT_SECRET not set)" });
    return;
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Unauthorized: missing Bearer token" });
    return;
  }

  try {
    jwt.verify(token, jwtSecret);
  } catch {
    res.status(401).json({ error: "Unauthorized: invalid or expired token" });
    return;
  }

  const parsed = resetAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { agent } = parsed.data;
  const agentLower = agent.toLowerCase();

  try {
    resetAgentStatus(agent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to reset agent status in pricing service", detail: msg });
    return;
  }

  dailyErrorTimestamps.delete(agentLower);
  agentStatusMap.delete(agentLower);

  res.json({
    success: true,
    agent,
    message: "Agent status reset successfully",
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 15. GET /api/agent-status/:agent
// ──────────────────────────────────────────────────────────────────────────────

router.get("/agent-status/:agent", (req, res) => {
  const { agent } = req.params;

  if (!agent || !isAddress(agent)) {
    res.status(400).json({ error: "Invalid agent address" });
    return;
  }

  const status = await getAgentStatus(agent);
  const dailyErrors = await getDailyErrorCount(agent);
  const now = Date.now();
  const isBlocked = status.blockedUntil > now || dailyErrors > DAILY_ERROR_HARD_THRESHOLD;

  res.json({
    address: agent,
    blockedUntil: status.blockedUntil,
    cooldownEnd: status.cooldownEnd,
    currentMultiplier: status.currentMultiplier,
    dailyErrors,
    isBlocked,
    threshold: DAILY_ERROR_HARD_THRESHOLD,
    isInCooldown: status.cooldownEnd > now && status.blockedUntil <= now,
  });
});

export default router;
