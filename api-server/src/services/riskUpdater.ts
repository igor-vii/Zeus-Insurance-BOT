import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, avg } from "drizzle-orm";
import { policiesTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import { updateRiskScore } from "./pricing.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: { policiesTable } });

/**
 * Bayesian update of a seller's risk score after a ClaimPaid event.
 *
 * Reads the current avg(risk_score) from all of the seller's policy rows,
 * computes the new Bayesian score, then writes it back to every row for
 * that seller so future AVG queries reflect the updated value.
 *
 * payoutFactor convention:
 *   wasSuccessful = true  → 0.5  (seller delivered; risk decreases)
 *   wasSuccessful = false → 4.0  (payout triggered; risk increases)
 */
export async function updateSellerRiskScore(
  sellerAddress: string,
  wasSuccessful: boolean,
): Promise<number> {
  try {
    const [result] = await db
      .select({ avgRiskScore: avg(policiesTable.riskScore) })
      .from(policiesTable)
      .where(eq(policiesTable.seller, sellerAddress.toLowerCase()));

    const currentAvg = result?.avgRiskScore ? parseFloat(String(result.avgRiskScore)) : 2.0;
    const payoutFactor = wasSuccessful ? 0.5 : 4.0;

    const newRiskScore = await updateRiskScore(sellerAddress, payoutFactor, currentAvg);

    await db
      .update(policiesTable)
      .set({ riskScore: newRiskScore.toFixed(2) })
      .where(eq(policiesTable.seller, sellerAddress.toLowerCase()));

    logger.info(
      { sellerAddress, currentAvg, payoutFactor, newRiskScore },
      "[riskUpdater] seller risk score updated",
    );

    return newRiskScore;
  } catch (err) {
    logger.warn({ err, sellerAddress }, "[riskUpdater] failed to update risk score — using fallback 2.0");
    return 2.0;
  }
}
