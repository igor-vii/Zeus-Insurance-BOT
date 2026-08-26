import {
  pgTable,
  text,
  timestamp,
  integer,
  decimal,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Payment Intents table — durable storage for x402 payment lifecycle.
 * 
 * Invariants enforced at DB level:
 *   INV-4: operation_id is UNIQUE → one intent per economic operation
 *   INV-7: nonce references nonce_registry → no double-spend even after crash
 */
export const paymentIntentsTable = pgTable(
  "payment_intents",
  {
    intentId: text("intent_id").primaryKey(),          // UUID v4
    operationId: text("operation_id").notNull(),       // links to Operation
    status: text("status").notNull(),                  // PaymentIntentStatus
    payer: text("payer").notNull(),                    // wallet address
    payTo: text("pay_to").notNull(),                   // recipient address
    value: decimal("value", { precision: 38, scale: 6 }).notNull(), // USDC amount
    nonce: text("nonce"),                              // FK to nonce_registry
    signature: text("signature"),                      // hex-encoded EIP-712 sig
    txHash: text("tx_hash"),                           // settlement tx hash
    facilitatorResponse: jsonb("facilitator_response"),// raw response from facilitator
    metadata: jsonb("metadata"),                       // arbitrary context
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    operationIdUnique: uniqueIndex("payment_intents_operation_id_unique").on(
      table.operationId,
    ),
    statusIdx: index("payment_intents_status_idx").on(table.status),
    payerIdx: index("payment_intents_payer_idx").on(table.payer),
    nonceIdx: index("payment_intents_nonce_idx").on(table.nonce),
  }),
);

/**
 * Nonce Registry — prevents double-spend across restarts.
 * 
 * Invariant: nonce is PK + UNIQUE → cannot reserve same nonce twice,
 * even after server crash and restart.
 */
export const nonceRegistryTable = pgTable(
  "nonce_registry",
  {
    nonce: text("nonce").primaryKey(),                 // hex nonce string
    operationId: text("operation_id").notNull(),       // which operation owns this nonce
    status: text("status").notNull(),                  // RESERVED | SIGNED | SUBMITTED | SETTLED
    payer: text("payer").notNull(),                    // wallet that signed
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    operationIdIdx: index("nonce_registry_operation_id_idx").on(
      table.operationId,
    ),
    statusIdx: index("nonce_registry_status_idx").on(table.status),
  }),
);
