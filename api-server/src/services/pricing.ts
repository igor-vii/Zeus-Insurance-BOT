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

/**
 * Convert HUMI score (0–100) to a risk multiplier.
 * Higher HUMI = more reliable seller = lower risk.
 *
 * HUMI ≥ 80 → 0.70  (very reliable)
 * HUMI ≥ 60 → 0.85
 * HUMI ≥ 40 → 1.00  (neutral)
 * HUMI ≥ 20 → 1.50
 * HUMI < 20  → 2.00  (high risk)
 */
export function getHumiMultiplier(humi: number): number {
  if (humi >= 80) return 0.70;
  if (humi >= 60) return 0.85;
  if (humi >= 40) return 1.00;
  if (humi >= 20) return 1.50;
  return 2.00;
}

/**
 * Dynamic HUMI weight in the risk score formula.
 * Higher HUMI confidence → higher weight given to HUMI data.
 */
function getHumiWeight(humi: number): number {
  if (humi > 50)  return 0.25; // HUMI_WEIGHT_HIGH
  if (humi >= 30) return 0.20; // HUMI_WEIGHT_MEDIUM
  return 0.15;                 // HUMI_WEIGHT_LOW
}

// ── Risk Score ────────────────────────────────────────────────────────────────

/**
 * Calculate Risk Score for a seller.
 * Range: 0.1 – 5.0
 *
 * Base formula (weighted by existingWeight = 1 − humiWeight):
 *   oracleRisk × 0.40 + executionRisk × 0.30 + modelRisk × 0.20 + gasVolatility × 0.10
 *
 * Plus HUMI component (weighted by humiWeight):
 *   getHumiMultiplier(humi) × humiWeight
 *
 * Total weights always sum to 1.0.
 */
export async function calculateRiskScore(
  sellerAddress: string,
  _amount: bigint,
  retries: number,
  history: SellerHistory,
): Promise<number> {
  if (!sellerAddress.startsWith("0x") || sellerAddress.length !== 42) {
    throw new Error("Invalid seller address format");
  }

  // 1. Oracle_Risk (base 40%) — constant 2.0 until GSA oracle is integrated
  const oracleRisk = 2.0;

  // 2. Gas_Volatility (base 10%) — constant 2.0 until gas oracle is integrated
  const gasVolatility = 2.0;

  // 3. Execution_Risk (base 30%) — derived from seller's on-chain failure rate
  let executionRisk = 2.0;
  if (history.totalPolicies > 0) {
    const failureRate = history.failedPolicies / history.totalPolicies;
    executionRisk = 1.0 + failureRate * 4.0; // 1.0 – 5.0
  }

  // 4. Model_Risk (base 20%) — from historical avg score if available, else from retries
  let modelRisk = 2.0;
  if (history.avgRiskScore > 0) {
    modelRisk = history.avgRiskScore;
  } else {
    modelRisk = Math.min(5.0, 1.0 + retries * 0.5);
  }

  // 5. HUMI factor — fetched from GSA with fallback to 50
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

// ── Premium ───────────────────────────────────────────────────────────────────

/**
 * Calculate premium based on amount and Risk Score.
 * Formula: amount × (0.05 + 0.01 × riskScore)
 */
export async function calculatePremium(amount: bigint, riskScore: number): Promise<bigint> {
  if (amount <= 0n) {
    throw new Error("Amount must be greater than 0");
  }
  if (riskScore < 0.1 || riskScore > 5.0) {
    throw new Error("Risk score must be between 0.1 and 5.0");
  }

  // (0.05 + 0.01 * riskScore) * 10000 → integer multiplier for BigInt arithmetic
  const multiplier = Math.round((5 + riskScore) * 100);
  return (amount * BigInt(multiplier)) / 10_000n;
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
  if (!sellerAddress.startsWith("0x") || sellerAddress.length !== 42) {
    throw new Error("Invalid seller address format");
  }
  if (payoutFactor < 0 || payoutFactor > 5.0) {
    throw new Error("Payout factor must be between 0 and 5.0");
  }

  const N = 10;
  const newScore = (currentRiskScore * N + payoutFactor) / (N + 1);
  return Math.max(0.1, Math.min(5.0, newScore));
}
