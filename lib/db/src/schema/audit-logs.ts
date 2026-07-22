import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),       // UUID v4
    action: text("action").notNull(),  // e.g. "role.set", "api_key.create"
    actor: text("actor").notNull(),    // wallet_address or "system"
    target: text("target"),            // wallet_address, key id, etc.
    metadata: jsonb("metadata"),       // arbitrary context
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_audit_logs_actor").on(t.actor),
    index("idx_audit_logs_action").on(t.action),
  ],
);

export type AuditLog = typeof auditLogsTable.$inferSelect;
export type InsertAuditLog = typeof auditLogsTable.$inferInsert;
