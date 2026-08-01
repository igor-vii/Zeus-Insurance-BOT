/**
 * @packageDocumentation
 * Pricing service for Zeus Insurance V2.
 */

export interface SellerHistory {
  totalPolicies: number;
  failedPolicies: number;
  avgRiskScore: number;
}

// ── HUMI ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the GSA HUMI (Historical Uptime and Market Intelligence) score
 * for a seller address. Range: 0–100 (higher = more reliable).
 * Falls back to 50 (neutral) on any network/parse error or timeout.
 */
export async function fetchHumi(address: string): Promise<number> {
  const TIMEOUT_MS = 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `https://api.globalscoreagent.com/v1/humi/${address}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GSA API ${res.status}`);
    const data = (await res.json()) as { humi?: number };
    const humi = typeof data.humi === "number" ? data.humi : NaN;
    if (isNaN(humi) || humi < 0 || humi > 100)
      throw new Error("Invalid HUMI value");
    return humi;
  } catch {
    return 50; // neutral fallback
  } finally {
    clearTimeout(timer);
  }
}

export function getHumiMultiplier(humi: number): number {
  if (humi >= 80) return 0.70;
  if (humi >= 60) return 0.85;
  if (humi >= 40) return 1.00;
  if (humi >= 20) return 1.50;
  return 2.00;
}

function getHumiWeight(humi: number): number {
  if (humi > 50)  return 0.25;
  if (humi >= 30) return 0.20;
  return 0.15;
}

// ── Risk Score ────────────────────────────────────────────────────────────────

export async function calculateRiskScore(
  sellerAddress: string,
  _amount: bigint,
  retries: number,
  history: SellerHistory,
): Promise<number> {
  if (!sellerAddress.startsWith("0x") || sellerAddress.length !== 42) {
    throw new Error("Invalid seller address format");
  }

  const oracleRisk = 2.0;
  const gasVolatility = 2.0;

  let executionRisk = 2.0;
  if (history.totalPolicies > 0) {
    const failureRate = history.failedPolicies / history.totalPolicies;
    executionRisk = 1.0 + failureRate * 4.0;
  }

  let modelRisk = 2.0;
  if (history.avgRiskScore > 0) {
    modelRisk = history.avgRiskScore;
  } else {
    modelRisk = Math.min(5.0, 1.0 + retries * 0.5);
  }

  const humi = await fetchHumi(sellerAddress);
  const humiMultiplier = getHumiMultiplier(humi);
  const humiWeight = getHumiWeight(humi);
  const existingWeight = 1 - humiWeight;

  const baseScore =
    oracleRisk * 0.4 +
    executionRisk * 0.3 +
    modelRisk * 0.2 +
    gasVolatility * 0.1;

  const rawScore = baseScore * existingWeight + humiMultiplier * humiWeight;
  return Math.max(0.1, Math.min(5.0, rawScore));
}

// ── Seller Premium ─────────────────────────────────────────────────────────────

export async function calculateSellerPremium(amount: bigint, riskScore: number): Promise<bigint> {
  if (amount <= 0n) throw new Error("Amount must be greater than 0");
  if (riskScore < 0.1 || riskScore > 5.0) throw new Error("Risk score must be between 0.1 and 5.0");

  const multiplier = Math.round((5 + riskScore) * 100);
  return (amount * BigInt(multiplier)) / 10_000n;
}

// ── Error Penalty ─────────────────────────────────────────────────────────────

/** Soft threshold (errors per 24h) above which a per-error penalty is added. */
export const DAILY_ERROR_SOFT_THRESHOLD = 3;

/** Hard threshold (errors per 24h) above which underwriting is refused. */
export const DAILY_ERROR_HARD_THRESHOLD = 5;

/** Per-error penalty in Basis Points (1000 BPS = 10%). */
export const PER_ERROR_PENALTY_BPS = 1000;

/**
 * Represents the recent error history of an OKX AI agent.
 */
export interface ErrorHistory {
  total: number;
  errors: number;
  windowHours: number;
}

export interface AgentStatus {
  blockedUntil: number;
  cooldownEnd: number;
  currentMultiplier: number;
}

/**
 * Compute the Penalty Score multiplier from an agent's error history.
 *
 * @param errorHistory The agent's recent error history.
 * @returns The penalty multiplier as a bigint (100n = 1.0×, 200n = 2.0×).
 */
export function calculatePenaltyScore(errorHistory: ErrorHistory): bigint {
  if (errorHistory.total === 0) return 100n;

  const errorRate = errorHistory.errors / errorHistory.total;

  let multiplier: bigint;
  if (errorRate > 0.30) multiplier = 200n;
  else if (errorRate > 0.15) multiplier = 150n;
  else multiplier = 100n;

  const capped = Math.min(errorHistory.errors, DAILY_ERROR_HARD_THRESHOLD);
  const extra = Math.max(0, capped - DAILY_ERROR_SOFT_THRESHOLD);

  multiplier += BigInt(extra * 100);

  return multiplier;
}

/**
 * Compute the premium based on the insured amount, retries, and penalty multiplier.
 *
 * @param amount The insured amount (in token base units, e.g., wei).
 * @param retries The number of retries configured for the policy.
 * @param multiplier The penalty multiplier (100n = 1.0×).
 * @returns The calculated premium as a bigint.
 */
export function calculatePremium(amount: bigint, retries: number, multiplier: bigint): bigint {
  // Base rate in BPS (700 = 7%). Each retry adds 2% (200 BPS).
  const baseBps = 700 + (retries - 1) * 200;

  // Apply penalty multiplier (100n = 100% = 1.0×)
  const effectiveBps = (BigInt(baseBps) * multiplier) / 100n;

  return (amount * effectiveBps) / 10000n;
}

export function getAgentMultiplier(
  agentAddress: string,
  agent: AgentStatus,
  history: ErrorHistory,
): bigint | null {
  const now = Date.now();

  if (agent.blockedUntil > now) return null;
  if (agent.cooldownEnd > now) return 200n;

  void agentAddress;
  return calculatePenaltyScore(history);
}

const agentErrorStore = new Map<string, number[]>();

export function recordAgentError(agent: string, timestamp: number = Date.now()): void {
  if (!agent || !agent.startsWith("0x")) throw new Error("Invalid agent address");

  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  let errors = agentErrorStore.get(agent) || [];
  errors = errors.filter(t => t > twentyFourHoursAgo);
  errors.push(timestamp);
  agentErrorStore.set(agent, errors);
}

export function getAgentErrorHistory(agent: string): ErrorHistory {
  if (!agent || !agent.startsWith("0x")) throw new Error("Invalid agent address");

  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  const errors = agentErrorStore.get(agent) || [];
  const recentErrors = errors.filter(t => t > twentyFourHoursAgo);

  return {
    total: 10, // Fixed denominator so errorRate is never always 100%
    errors: recentErrors.length,
    windowHours: 24,
  };
}

export function clearAgentErrors(agent: string): void {
  if (!agent || !agent.startsWith("0x")) throw new Error("Invalid agent address");
  agentErrorStore.delete(agent);
}

/**
 * Clear all error history and penalty state for a specific agent.
 * This effectively rehabilitates the agent, allowing them to operate without penalties.
 *
 * @param agent - Agent address
 */
export function resetAgentStatus(agent: string): void {
  if (!agent || !agent.startsWith("0x")) {
    throw new Error("Invalid agent address");
  }

  agentErrorStore.delete(agent);
}

// ── Risk Score Update ─────────────────────────────────────────────────────────

/**
 * Bayesian update of Risk Score after a payout event.
 * Formula: newScore = (currentScore × N + payoutFactor) / (N + 1), N = 10
 */
export async function updateRiskScore(
  sellerAddress: string,
  payoutFactor: number,
  currentRiskScore: number,
): Promise<number> {
  if (!sellerAddress || !sellerAddress.startsWith("0x")) {
    throw new Error("Invalid seller address");
  }
  if (payoutFactor < 0 || payoutFactor > 5.0) {
    throw new Error("Payout factor must be between 0 and 5.0");
  }

  const N = 10;
  const newScore = (currentRiskScore * N + payoutFactor) / (N + 1);
  return Math.max(0.1, Math.min(5.0, newScore));
}
