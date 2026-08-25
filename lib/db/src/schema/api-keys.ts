import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),           // UUID v4
    name: text("name").notNull(),          // human-readable label
    keyHash: text("key_hash").notNull().unique(), // SHA-256 of the plaintext key
    createdBy: text("created_by").notNull(),     // wallet_address of the admin
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("idx_api_keys_hash").on(t.keyHash)],
);

export type ApiKey = typeof apiKeysTable.$inferSelect;
export type InsertApiKey = typeof apiKeysTable.$inferInsert;
