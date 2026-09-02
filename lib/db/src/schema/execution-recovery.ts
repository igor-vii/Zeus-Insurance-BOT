import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Execution Attempts — durable record of each seller HTTP call.
 *
 * INV-9: execution_id is UNIQUE per operation → stable idempotency key
 * INV-13: raw_result stored BEFORE state machine interpretation
 */
export const executionAttemptsTable = pgTable(
  "execution_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),       // UUID v4
    operationId: text("operation_id").notNull(),       // FK to payment_intents
    executionId: text("execution_id").notNull(),       // stable idempotency key (= operationId for idempotent)
    attemptNumber: integer("attempt_number").notNull().default(1),
    status: text("status").notNull(),                  // PENDING | ATTEMPTED | SUCCESS | HTTP_FAILURE | DELIVERY_UNKNOWN
    requestUrl: text("request_url"),                   // seller endpoint
    requestMethod: text("request_method"),             // GET | POST | etc.
    requestBody: jsonb("request_body"),                // what was sent
    responseStatusCode: integer("response_status_code"),
    responseBody: jsonb("response_body"),              // raw response (evidence before interpretation)
    responseHeaders: jsonb("response_headers"),        // captured headers
    errorReason: text("error_reason"),                 // TIMEOUT | CONNECTION_RESET | etc.
    idempotencyKey: text("idempotency_key"),           // sent as header to seller
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    operationIdIdx: index("exec_attempts_operation_id_idx").on(table.operationId),
    executionIdUnique: uniqueIndex("exec_attempts_execution_id_attempt_unique").on(
      table.executionId,
      table.attemptNumber,
    ),
    statusIdx: index("exec_attempts_status_idx").on(table.status),
  }),
);

/**
 * Recovery Jobs — DB-backed queue for post-settlement execution/recovery.
 *
 * INV-12: After crash+restart, worker finds PENDING jobs and resumes.
 * INV-8: Only created AFTER settlement confirmed.
 */
export const recoveryJobsTable = pgTable(
  "recovery_jobs",
  {
    jobId: text("job_id").primaryKey(),                // UUID v4
    operationId: text("operation_id").notNull(),       // FK to payment_intents
    jobType: text("job_type").notNull(),               // EXECUTION | RETRY | RETRIEVAL | OBSERVATION
    status: text("status").notNull(),                  // PENDING | RUNNING | COMPLETED | FAILED | UNRESOLVABLE
    priority: integer("priority").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    currentAttempt: integer("current_attempt").notNull().default(0),
    lockedBy: text("locked_by"),                       // worker ID that claimed this job (INV-AQ)
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    fenceGeneration: integer("fence_generation").notNull().default(0), // R2.2-R9: monotonic ownership generation for stale-worker fencing
    lastError: text("last_error"),
    metadata: jsonb("metadata"),                       // arbitrary context
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    operationIdIdx: index("recovery_jobs_operation_id_idx").on(table.operationId),
    statusIdx: index("recovery_jobs_status_idx").on(table.status),
    pendingIdx: index("recovery_jobs_pending_idx").on(table.status, table.priority),
    executionObligationUnique: uniqueIndex("execution_obligations_operation_id_key")
      .on(table.operationId)
      .where(sql`job_type = 'EXECUTION'`),
  }),
);
