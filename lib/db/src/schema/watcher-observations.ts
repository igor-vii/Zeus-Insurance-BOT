import { pgTable, text, timestamp, integer, decimal, jsonb, index } from "drizzle-orm/pg-core";

export const watcherObservTable = pgTable(
  "watcher_observations",
  {
    id: text("id").primaryKey(), // UUID v4
    chainId: integer("chain_id").notNull(),
    policyId: text("policy_id").notNull(),
    requestId: text("request_id").notNull(),
    watcher: text("watcher").notNull(), // watcher name (logs, rpc, api, etc.)
    vote: integer("vote"), // 0 = no, 1 = yes, null = abstain
    reason: text("reason"),
    signature: text("signature"),
    metadataHash: text("metadata_hash"),
    nonce: integer("nonce"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_watcher_obs_request_id").on(t.requestId),
    index("idx_watcher_obs_policy_id").on(t.chainId, t.policyId),
    index("idx_watcher_obs_watcher").on(t.watcher),
    index("idx_watcher_obs_timestamp").on(t.timestamp),
  ],
);

export type WatcherObservation = typeof watcherObservTable.$inferSelect;
export type InsertWatcherObservation = typeof watcherObservTable.$inferInsert;
