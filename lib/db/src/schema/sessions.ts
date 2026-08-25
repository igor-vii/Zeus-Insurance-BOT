import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Auth sessions table.
 *
 * Flow:
 *  1. Row is created with a nonce when the frontend requests one.
 *  2. After the wallet signs and the server verifies the signature, token_hash
 *     is set and nonce is cleared — the session becomes active.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // UUID v4
    walletAddress: text("wallet_address").notNull(),
    nonce: text("nonce"),                          // cleared after verification
    nonceExpiresAt: timestamp("nonce_expires_at", { withTimezone: true }),
    tokenHash: text("token_hash"),                 // SHA-256 of the session token
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sessions_wallet").on(t.walletAddress),
    index("idx_sessions_token_hash").on(t.tokenHash),
  ],
);

export type Session = typeof sessionsTable.$inferSelect;
export type InsertSession = typeof sessionsTable.$inferInsert;
