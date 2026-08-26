import {
  pgTable,
  text,
  timestamp,
  integer,
  decimal,
  jsonb,
  boolean,
  bigint,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

/**
 * §4: Durable Payment Intents — persisted BEFORE /settle network I/O.
 * §3: Economic safety enforced via settlement_state check.
 * §21: Atomic terminal transitions via CAS (compareAndSetState).
 */
export const paymentIntentsTable = pgTable(
  "payment_intents",
  {
    // Identity
    paymentIntentId: text("payment_intent_id").primaryKey(),
    operationId: text("operation_id").notNull(),
    requestId: text("request_id"),
    clientId: text("client_id"),

    // Authorization fields (§4)
    authorizer: text("authorizer").notNull(),
    payTo: text("pay_to").notNull(),
    value: decimal("value", { precision: 38, scale: 6 }).notNull(),
    asset: text("asset").notNull(),
    network: text("network").notNull(),

    // EIP-3009 fields (§4)
    nonce: text("nonce").notNull(),
    validAfter: bigint("valid_after", { mode: "number" }).notNull(),
    validBefore: bigint("valid_before", { mode: "number" }).notNull(),

    // Signed payload (§4)
    paymentPayload: text("payment_payload").notNull(),
    paymentPayloadHash: text("payment_payload_hash").notNull(),

    // Settlement lifecycle (§2)
    settlementState: text("settlement_state").notNull().default("AUTHORIZED"),
    txHash: text("tx_hash"),
    facilitatorHttpStatus: integer("facilitator_http_status"),
    facilitatorResponseBody: jsonb("facilitator_response_body"),
    errorReason: text("error_reason"),
    submitAttemptAt: timestamp("submit_attempt_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    notSettledAt: timestamp("not_settled_at", { withTimezone: true }),

    // Evidence bundles (§7, §11, §22, §23)
    settledEvidenceBundle: jsonb("settled_evidence_bundle"),
    notSettledEvidenceBundle: jsonb("not_settled_evidence_bundle"),
    reconciliationObservations: jsonb("reconciliation_observations"),

    // Reconciliation schedule (§16)
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
    probeCount: integer("probe_count").notNull().default(0),

    // Concurrency control (§19, §21)
    version: integer("version").notNull().default(0), // optimistic locking for CAS

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // §3 + §19: One intent per operation — economic safety at DB level
    operationIdUnique: uniqueIndex("pi_operation_id_unique").on(table.operationId),
    // §4: Nonce uniqueness within scope
    nonceIdx: index("pi_nonce_idx").on(table.nonce),
    // State queries for reconciliation worker
    stateIdx: index("pi_settlement_state_idx").on(table.settlementState),
    // Probe scheduling
    probeIdx: index("pi_next_probe_at_idx").on(table.nextProbeAt),
    // Authorizer lookups
    authorizerIdx: index("pi_authorizer_idx").on(table.authorizer),
  }),
);

/**
 * §4 + §19: Nonce Registry — prevents double-spend across restarts.
 * PK(nonce) ensures no duplicate reservation even after crash.
 */
export const nonceRegistryTable = pgTable(
  "nonce_registry",
  {
    nonce: text("nonce").primaryKey(),
    operationId: text("operation_id").notNull(),
    status: text("status").notNull(), // RESERVED | SIGNED | SUBMITTED | SETTLED
    payer: text("payer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operationIdIdx: index("nr_operation_id_idx").on(table.operationId),
    statusIdx: index("nr_status_idx").on(table.status),
  }),
);

/**
 * §14-15 + §22: Reconciliation observations — persisted per probe.
 * Each row = one RPC observation for one payment intent.
 */
export const reconciliationObservationsTable = pgTable(
  "reconciliation_observations",
  {
    observationId: text("observation_id").primaryKey(),
    paymentIntentId: text("payment_intent_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    rpcProviderId: text("rpc_provider_id").notNull(),
    underlyingProvider: text("underlying_provider").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    chainHead: bigint("chain_head", { mode: "number" }).notNull(),
    authorizationState: boolean("authorization_state"),
    validBefore: bigint("valid_before", { mode: "number" }).notNull(),
    result: text("result").notNull(),
    stalenessBlocks: integer("staleness_blocks"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intentIdx: index("ro_payment_intent_id_idx").on(table.paymentIntentId),
    providerIdx: index("ro_rpc_provider_id_idx").on(table.rpcProviderId),
  }),
);

/**
 * §16: Reconciliation jobs — durable probe schedule.
 * Survives restart. No busy loop.
 */
export const reconciliationJobsTable = pgTable(
  "reconciliation_jobs",
  {
    jobId: text("job_id").primaryKey(),
    paymentIntentId: text("payment_intent_id").notNull(),
    status: text("status").notNull(), // PENDING | RUNNING | COMPLETED | UNRESOLVABLE
    probeCount: integer("probe_count").notNull().default(0),
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }).notNull(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intentIdx: index("rj_payment_intent_id_idx").on(table.paymentIntentId),
    pendingIdx: index("rj_pending_probe_idx").on(table.status, table.nextProbeAt),
  }),
);
