import { pgTable, text, timestamp, decimal, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const sellerRiskScoresTable = pgTable(
  "seller_risk_scores",
  {
    id: text("id").primaryKey(), // UUID v4
    seller: text("seller").notNull(), // seller wallet address
    chainId: integer("chain_id").notNull(),
    riskScore: decimal("risk_score", { precision: 5, scale: 2 }).notNull(), // 0.1–5.0
    totalPolicies: integer("total_policies").notNull().default(0),
    successfulDeliveries: integer("successful_deliveries").notNull().default(0),
    failedDeliveries: integer("failed_deliveries").notNull().default(0),
    claimsPaid: integer("claims_paid").notNull().default(0),
    claimsRejected: integer("claims_rejected").notNull().default(0),
    metadata: jsonb("metadata"), // additional risk factors
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_seller_risk_seller_chain").on(t.seller, t.chainId),
    index("idx_seller_risk_score").on(t.riskScore),
    index("idx_seller_risk_updated").on(t.updatedAt),
  ],
);

export type SellerRiskScore = typeof sellerRiskScoresTable.$inferSelect;
export type InsertSellerRiskScore = typeof sellerRiskScoresTable.$inferInsert;
