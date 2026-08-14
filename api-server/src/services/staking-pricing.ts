/**
 * Staking insurance pricing engine v2 — First Loss Model (Soter-style).
 *
 * Key changes from v1:
 *   - Coverage is firstLossPercent of stake (e.g. 3%), not 100%
 *   - Base premium configurable per-network via basePremiumBps
 *   - Collateral required for Emerging/Unproven networks
 *   - Risk multiplier based on validator architecture + HUMI score
 *
 * Formulas:
 *   coveredAmount = stakedAmount × firstLossPercent / 10000
 *   annualPremium = stakedAmount × basePremiumBps / 10000 × riskMultiplier / 100
 *   premium       = annualPremium × termDays / 365
 *   collateral    = coveredAmount × collateralRatio / 100  (only if != Proven)
 */

// ── Network configurations ────────────────────────────────────────────────────

export enum NetworkRisk {
  Proven = 0,     // Ethereum — established, slashing history exists
  Emerging = 1,   // X Layer — some history, moderate risk
  Unproven = 2,   // BOT Chain — new, no slashing data
}

export interface NetworkConfig {
  firstLossPercent: number;  // bps (300 = 3%)
  basePremiumBps: number;    // annual premium in bps (6 = 0.06%)
  networkRisk: NetworkRisk;
  collateralRatio: number;   // % of coveredAmount (100 = 100%)
}

export const NETWORK_CONFIGS: Record<number, NetworkConfig> = {
  1: {   // Ethereum Mainnet
    firstLossPercent: 200,   // 2%
    basePremiumBps: 4,       // 4 bps/year
    networkRisk: NetworkRisk.Proven,
    collateralRatio: 0,
  },
  196: { // X Layer
    firstLossPercent: 300,   // 3%
    basePremiumBps: 6,       // 6 bps/year
    networkRisk: NetworkRisk.Emerging,
    collateralRatio: 100,    // 100% of coveredAmount
  },
  677: { // BOT Chain
    firstLossPercent: 500,   // 5%
    basePremiumBps: 10,      // 10 bps/year
    networkRisk: NetworkRisk.Unproven,
    collateralRatio: 150,    // 150% of coveredAmount
  },
};

// ── Validator architecture metrics ────────────────────────────────────────────

export interface ValidatorMetrics {
  downtimePct: number;        // 0..100, last 90 days
  priorSlashes: number;       // historical slashing events by operator
  clientSharePct: number;     // max consensus client concentration (0..100)
  hasCircuitBreakers: boolean;
  hasKeySegregation: boolean;
  humiScore: number;          // 0..1000, HUMI trust score
}

// ── Quote result ──────────────────────────────────────────────────────────────

export interface StakingQuote {
  // Input
  stakedAmount: string;
  termDays: number;
  chainId: number;

  // Network config
  firstLossPercent: number;
  basePremiumBps: number;
  networkRisk: string;

  // Calculated
  coveredAmount: string;      // first-loss coverage
  riskMultiplier: number;     // 80..300 (0.8x..3.0x)
  annualPremiumBps: number;   // effective annual rate in bps
  premium: string;            // token amount for the term
  collateral: string;         // locked deposit (0 for Proven)
  totalUpfront: string;       // premium + collateral

  // Marketing
  estimatedAPR: number;       // assumed staking APR %
  premiumPctOfIncome: number; // premium as % of estimated staking income
}

// ── Risk multiplier calculation ───────────────────────────────────────────────

/**
 * Architecture-based risk multiplier (80..300 = 0.8x..3.0x).
 *
 * Components:
 *   clientDivMult:     client concentration risk
 *   circuitBreakerMult: auto-shutdown protection
 *   keySegMult:        key management segregation
 *   humiMult:          HUMI trust score
 *   downtimeMult:      recent downtime
 *   slashHistoryMult:  prior slashing events
 */
export function computeRiskMultiplier(m: ValidatorMetrics): number {
  // Client diversification
  let clientDivMult = 1.0;
  if (m.clientSharePct > 50) clientDivMult = 1.8;
  else if (m.clientSharePct > 33) clientDivMult = 1.3;

  // Circuit breakers
  const circuitBreakerMult = m.hasCircuitBreakers ? 1.0 : 2.0;

  // Key segregation
  const keySegMult = m.hasKeySegregation ? 1.0 : 1.3;

  // HUMI score
  let humiMult = 1.0;
  if (m.humiScore >= 800) humiMult = 0.8;
  else if (m.humiScore < 400) humiMult = 1.5;

  // Downtime
  let downtimeMult = 1.0;
  if (m.downtimePct > 5) downtimeMult = 1.5;
  else if (m.downtimePct > 1) downtimeMult = 1.2;

  // Prior slashes
  let slashMult = 1.0;
  if (m.priorSlashes >= 3) slashMult = 2.0;
  else if (m.priorSlashes >= 1) slashMult = 1.5;

  const raw = clientDivMult * circuitBreakerMult * keySegMult * humiMult * downtimeMult * slashMult;
  const scaled = Math.round(raw * 100); // convert to bps-like integer
  return Math.max(80, Math.min(300, scaled));
}

// ── Main quote function ───────────────────────────────────────────────────────

/** Default assumed staking APR by chain (for marketing display) */
const DEFAULT_STAKING_APR: Record<number, number> = {
  1: 3.0,    // Ethereum
  196: 5.0,  // X Layer
  677: 8.0,  // BOT Chain
};

export function quoteStaking(
  stakedAmount: bigint,
  termDays: number,
  chainId: number,
  metrics: ValidatorMetrics,
): StakingQuote {
  const config = NETWORK_CONFIGS[chainId] ?? NETWORK_CONFIGS[196]; // fallback to X Layer

  // Covered amount = first loss portion
  const coveredAmount = stakedAmount * BigInt(config.firstLossPercent) / 10000n;

  // Risk multiplier
  const riskMultiplier = computeRiskMultiplier(metrics);

  // Annual premium = stakedAmount × basePremiumBps / 10000 × riskMultiplier / 100
  const annualPremium = stakedAmount * BigInt(config.basePremiumBps) * BigInt(riskMultiplier) / (10000n * 100n);

  // Term premium = annual × termDays / 365
  const premium = annualPremium * BigInt(termDays) / 365n;

  // Collateral
  let collateral = 0n;
  if (config.networkRisk !== NetworkRisk.Proven && config.collateralRatio > 0) {
    collateral = coveredAmount * BigInt(config.collateralRatio) / 100n;
  }

  const totalUpfront = premium + collateral;

  // Marketing metrics
  const estimatedAPR = DEFAULT_STAKING_APR[chainId] ?? 5.0;
  const annualIncome = Number(stakedAmount) * estimatedAPR / 100;
  const premiumPctOfIncome = annualIncome > 0
    ? Math.round(Number(premium) / annualIncome * 10000) / 100
    : 0;

  return {
    stakedAmount: stakedAmount.toString(),
    termDays,
    chainId,
    firstLossPercent: config.firstLossPercent,
    basePremiumBps: config.basePremiumBps,
    networkRisk: NetworkRisk[config.networkRisk],
    coveredAmount: coveredAmount.toString(),
    riskMultiplier,
    annualPremiumBps: Math.round(config.basePremiumBps * riskMultiplier / 100),
    premium: premium.toString(),
    collateral: collateral.toString(),
    totalUpfront: totalUpfront.toString(),
    estimatedAPR,
    premiumPctOfIncome,
  };
}
