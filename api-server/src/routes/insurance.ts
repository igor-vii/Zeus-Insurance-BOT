import { Router } from "express";
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
  calculatePremium,
  getAgentMultiplier,
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

const router = Router();

// ── Agent status + rolling daily error store ──────────────────────────────────

const DAY_MS            = 24 * 60 * 60 * 1000;
const COOLDOWN_EXTRA_MS = 24 * 60 * 60 * 1000; // additional cooldown after the block period

const agentStatusMap = new Map<string, AgentStatus>();

// Per-agent sorted list of error timestamps (Unix ms).
// Entries older than DAY_MS are pruned on every read/write, giving a true
// rolling 24-hour window instead of a fixed/tumbling bucket.
const dailyErrorTimestamps = new Map<string, number[]>();

function getAgentStatus(address: string): AgentStatus {
  return agentStatusMap.get(address.toLowerCase()) ?? {
    blockedUntil: 0,
    cooldownEnd: 0,
    currentMultiplier: 1.0,
  };
}

/**
 * Return the number of errors recorded for this agent in the last 24 hours.
 * Prunes stale timestamps as a side-effect to keep memory bounded.
 */
function getDailyErrorCount(address: string): number {
  const key    = address.toLowerCase();
  const cutoff = Date.now() - DAY_MS;
  const ts     = dailyErrorTimestamps.get(key);
  if (!ts) return 0;
  const pruned = ts.filter(t => t > cutoff);
  dailyErrorTimestamps.set(key, pruned);
  return pruned.length;
}

/**
 * Record one error for an agent in the rolling 24-hour window.
 * Automatically writes block + cooldown to agentStatusMap when the count
 * exceeds DAILY_ERROR_HARD_THRESHOLD — this is the state-transition write
 * path for the getAgentMultiplier 403 / cooldown logic.
 */
function recordDailyError(address: string): number {
  const key    = address.toLowerCase();
  const now    = Date.now();
  const cutoff = now - DAY_MS;
  const existing = dailyErrorTimestamps.get(key) ?? [];
  const pruned   = existing.filter(t => t > cutoff);
  pruned.push(now);
  dailyErrorTimestamps.set(key, pruned);
  const count = pruned.length;
  // Auto-block when threshold is exceeded; cooldown starts when block ends
  if (count > DAILY_ERROR_HARD_THRESHOLD) {
    agentStatusMap.set(key, {
      blockedUntil:      now + DAY_MS,
      cooldownEnd:       now + DAY_MS + COOLDOWN_EXTRA_MS,
      currentMultiplier: 2.0,
    });
  }
  return count;
}

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

    // Hard block: too many errors in the rolling 24-hour window → 429
    const dailyErrors = getDailyErrorCount(seller);
    const errorHistory: ErrorHistory = { errors: dailyErrors };
    if (dailyErrors > DAILY_ERROR_HARD_THRESHOLD) {
      res.status(429).json({ error: "Agent blocked", detail: `Daily error count ${dailyErrors} exceeds limit of ${DAILY_ERROR_HARD_THRESHOLD}` });
      return;
    }

    // Agent status multiplier check
    const agentStatus: AgentStatus = getAgentStatus(seller);
    const agentMultiplier = getAgentMultiplier(agentStatus, errorHistory);
    if (agentMultiplier === null) {
      res.status(403).json({ error: "Agent is currently blocked", detail: `Blocked until ${new Date(agentStatus.blockedUntil).toISOString()}` });
      return;
    }

    riskScore = await calculateRiskScore(seller, amountBigInt, maxRetries, history);
    const basePremium = await calculatePremium(amountBigInt, riskScore);
    // Apply agent multiplier using fixed-point bigint arithmetic (scale ×100, no Number conversion)
    premiumAmount = (basePremium * BigInt(Math.round(agentMultiplier * 100))) / 100n;
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

// ─── POST /api/slashing-protection ───────────────────────────────────────────
// Purchase a SlashingProtection policy for a BOT Chain validator.
// Premium = 5% (500 bps) of coverage amount.
const slashingBuySchema = z.object({
  validator:      z.string().refine(isAddress, "Invalid validator address"),
  amount:         z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
  timeoutSeconds: z.coerce.number().int().min(60).optional().default(86400),
});

router.post("/slashing-protection", async (req, res) => {
  const parsed = slashingBuySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { validator, amount, timeoutSeconds } = parsed.data;
  const amountBigInt = BigInt(amount);
  // Premium: 5% of coverage
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

  // Hybrid mode: return calldata for the caller to sign and broadcast
  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "buySlashingProtection",
    args: [validator as `0x${string}`, amountBigInt, BigInt(timeoutSeconds)],
  });

  res.json({
    mode: "hybrid",
    to: ZEUS_INSURANCE_ADDRESS,
    data,
    coverageType: "SlashingProtection",
    premiumAmount: premiumAmount.toString(),
  });
});

// ─── POST /api/slashing/premium ──────────────────────────────────────────────
// Calculate slashing protection premium for a validator.
// Rate logic:
//   chainId 677 (BOT Chain) → base 15 %
//   validator history clean  → 15 %
//   validator new (no data)  → 18 %
//   validator had slashes    → 20 %
const slashingPremiumSchema = z.object({
  validator: z.string().refine(isAddress, "Invalid validator address"),
  amount:    z.coerce.number().positive("amount must be positive"),
  chainId:   z.coerce.number().int().positive(),
});

router.post("/slashing/premium", async (req, res) => {
  const parsed = slashingPremiumSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { validator, amount, chainId } = parsed.data;

  // Start from BOT Chain base or generic default
  let rate = chainId === 677 ? 15 : 15;

  try {
    const history = await getSellerHistory(validator);
    const isNew     = !history || history.totalPolicies === 0;
    const hasSlash  = history && history.failedPolicies > 0;

    if (hasSlash)  rate = 20;
    else if (isNew) rate = 18;
    else            rate = 15; // clean history
  } catch {
    // Cannot fetch history → treat as new validator
    rate = 18;
  }

  const premium = (amount * rate) / 100;
  res.json({ premium, rate });
});

// ─── POST /api/report-slashing ────────────────────────────────────────────────
// Watcher reports a confirmed slashing event for a SlashingProtection policy.
// In automatic mode the server broadcasts the tx; in hybrid mode returns calldata.
const reportSlashingSchema = z.object({
  policyId:     z.coerce.number().int().nonnegative(),
  evidenceHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "evidenceHash must be a 0x-prefixed 32-byte hex string"),
});

const REPORT_SLASHING_ABI = [
  {
    name: "reportSlashing",
    type: "function",
    inputs: [
      { name: "policyId",     type: "uint256" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

router.post("/report-slashing", async (req, res) => {
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

// ─── POST /api/agent-error ────────────────────────────────────────────────────
// Record a daily error for an agent address.
// Trusted watcher / oracle services call this when they confirm an agent failure.
// Requires Authorization: Bearer <AGENT_ERROR_SECRET>.
//
// Idempotency: supply an `eventId` string to prevent double-counting replayed
// events. Duplicate eventIds are acknowledged but do not mutate state.
//
// Automatically blocks the agent (via agentStatusMap) when daily errors exceed
// DAILY_ERROR_HARD_THRESHOLD — this is the write path that makes the
// getAgentMultiplier 403 / cooldown checks operational.

// Bounded idempotency store — max 10 000 event IDs to cap memory usage.
const seenEventIds = new Set<string>();
const MAX_SEEN_EVENT_IDS = 10_000;

const agentErrorSchema = z.object({
  agent:   z.string().refine(isAddress, "Invalid agent address"),
  eventId: z.string().min(1).max(128).optional(),
});

router.post("/agent-error", (req, res) => {
  // ── Bearer-token authentication ────────────────────────────────────────────
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

  // ── Input validation ───────────────────────────────────────────────────────
  const parsed = agentErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { agent, eventId } = parsed.data;

  // ── Idempotency check ──────────────────────────────────────────────────────
  if (eventId) {
    if (seenEventIds.has(eventId)) {
      res.json({ agent, duplicate: true });
      return;
    }
    if (seenEventIds.size >= MAX_SEEN_EVENT_IDS) {
      // Evict oldest entries to stay bounded (Set preserves insertion order)
      const first = seenEventIds.values().next().value;
      if (first !== undefined) seenEventIds.delete(first);
    }
    seenEventIds.add(eventId);
  }

  // ── Record error + auto-block ──────────────────────────────────────────────
  const count = recordDailyError(agent);
  const blocked = count > DAILY_ERROR_HARD_THRESHOLD;
  res.json({
    agent,
    dailyErrors: count,
    blocked,
    blockedUntil: blocked ? getAgentStatus(agent).blockedUntil : null,
  });
});

export default router;
