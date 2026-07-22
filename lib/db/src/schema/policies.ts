import { pgTable, text, boolean, timestamp, decimal, index } from "drizzle-orm/pg-core";

export const policiesTable = pgTable(
  "policies_cache",
  {
    id: text("id").primaryKey(),
    buyer: text("buyer").notNull(),
    seller: text("seller").notNull(),
    amount: text("amount").notNull(),
    premium: text("premium").notNull(),
    retryDeadline: text("retry_deadline").notNull(),
    maxRetries: text("max_retries").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    isPaidOut: boolean("is_paid_out").notNull().default(false),
    isExpired: boolean("is_expired").notNull().default(false),
    /** Seller's Bayesian risk score at the time this policy was last evaluated. Range 0.1–5.0. */
    riskScore: decimal("risk_score", { precision: 5, scale: 2 }).default("0.0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_policies_cache_buyer").on(t.buyer),
    index("idx_policies_cache_seller_risk_score").on(t.seller, t.riskScore),
  ],
);

export type PolicyCache = typeof policiesTable.$inferSelect;
export type InsertPolicyCache = typeof policiesTable.$inferInsert;
