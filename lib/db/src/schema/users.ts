import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("user_role", [
  "admin",
  "partner",
  "investor",
  "oracle",
]);

export const usersTable = pgTable(
  "users",
  {
    walletAddress: text("wallet_address").primaryKey(), // lowercase hex
    role: roleEnum("role").notNull().default("investor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_users_role").on(t.role)],
);

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
export type UserRole = (typeof roleEnum.enumValues)[number];
export const USER_ROLES = roleEnum.enumValues;
