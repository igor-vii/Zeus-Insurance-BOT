import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql, count, avg } from "drizzle-orm";
import { policiesTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import type { SellerHistory } from "./pricing.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: { policiesTable } });

const ZERO_HISTORY: SellerHistory = { totalPolicies: 0, failedPolicies: 0, avgRiskScore: 0 };

/**
 * Derives seller history from the policies cache.
 * "Failed" policies are those where isPaidOut = true — meaning the seller
 * failed to deliver and the buyer was compensated from the reserve fund.
 *
 * Falls back to ZERO_HISTORY on DB errors (e.g. DATABASE_URL not configured),
 * which causes the pricing module to use the neutral midpoint baseline (2.0).
 */
export async function getSellerHistory(sellerAddress: string): Promise<SellerHistory> {
  if (!sellerAddress.startsWith("0x") || sellerAddress.length !== 42) {
    throw new Error("Invalid seller address");
  }

  try {
    const [result] = await db
      .select({
        totalPolicies: count(),
        failedPolicies: sql<number>`COUNT(CASE WHEN ${policiesTable.isPaidOut} = true THEN 1 END)`,
        avgRiskScore: avg(policiesTable.riskScore),
      })
      .from(policiesTable)
      .where(sql`${policiesTable.seller} = ${sellerAddress.toLowerCase()}`);

    if (!result || result.totalPolicies === 0) return ZERO_HISTORY;

    return {
      totalPolicies: Number(result.totalPolicies),
      failedPolicies: Number(result.failedPolicies),
      avgRiskScore: result.avgRiskScore ? parseFloat(String(result.avgRiskScore)) : 0,
    };
  } catch (err) {
    logger.warn({ err, sellerAddress }, "[sellerHistory] DB query failed — using zero history baseline");
    return ZERO_HISTORY;
  }
}
