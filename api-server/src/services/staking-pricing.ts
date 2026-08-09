/**
 * Staking insurance pricing engine (phase 1).
 *
 * premium = stakedAmount * BASE_RATE * riskMultiplier * termDays / 365
 *
 * Base rate: 50 bps (0.5% APR) — slashing-only coverage.
 * Real-world slashing probability for good operators is 0.1–0.5%/yr,
 * so 0.5–1% premium keeps loss ratio < 20% while staying affordable
 * vs ~7% staking yield (user nets 6%+).
 */

export const BASE_RATE_BPS = 50n; // 0.5% APR

export interface ValidatorMetrics {
  downtimePct: number;      // 0..100, last 90 days
  priorSlashes: number;     // historical slashing events by operator
  clientSharePct: number;   // consensus client concentration (0..100)
}

export interface StakingQuote {
  baseRateBps: number;
  riskMultiplierBps: number; // 100 = neutral
  annualRateBps: number;
  premium: string;           // token decimals (bigint as string)
  coverage: string;
}

/** Bayesian-flavoured risk multiplier, 80..300 bps (0.8x..3x base). */
export function riskMultiplierBps(m: ValidatorMetrics): number {
  let score = 100;
  score += Math.round(m.downtimePct * 10);        // 5% downtime → +50
  score += m.priorSlashes * 100;                  // any history → heavy load
  if (m.clientSharePct > 33) score += 25;         // client concentration risk
  return Math.max(80, Math.min(300, score));
}

export function quoteStaking(
  stakedAmount: bigint,
  termDays: number,
  metrics: ValidatorMetrics,
): StakingQuote {
  const mult = BigInt(riskMultiplierBps(metrics));
  const annualBps = BASE_RATE_BPS * mult;                    // e.g. 50..150 bps
  // premium = amount * annualBps / 10_000 * termDays / 365
  const premium = (stakedAmount * annualBps * BigInt(termDays)) / (10_000n * 365n);

  return {
    baseRateBps: Number(BASE_RATE_BPS),
    riskMultiplierBps: Number(mult),
    annualRateBps: Number(annualBps),
    premium: premium.toString(),
    coverage: stakedAmount.toString(),
  };
}
