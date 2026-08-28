-- Migration 0005: Secretariat V0 tables
-- Creates payment lifecycle, execution/recovery, and reconciliation tables
-- for Zeus Secretariat V0 durable state management.

-- ============================================================================
-- Payment Intents (canonical V0 payment lifecycle)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "payment_intents" (
    "payment_intent_id" text PRIMARY KEY NOT NULL,
    "operation_id" text NOT NULL,
    "request_id" text,
    "client_id" text,
    "authorizer" text NOT NULL,
    "pay_to" text NOT NULL,
    "value" numeric(38, 6) NOT NULL,
    "asset" text NOT NULL,
    "network" text NOT NULL,
    "nonce" text NOT NULL,
    "valid_after" bigint NOT NULL,
    "valid_before" bigint NOT NULL,
    "payment_payload" text NOT NULL,
    "payment_payload_hash" text NOT NULL,
    "settlement_state" text NOT NULL DEFAULT 'AUTHORIZED',
    "tx_hash" text,
    "facilitator_http_status" integer,
    "facilitator_response_body" jsonb,
    "error_reason" text,
    "submit_attempt_at" timestamp with time zone,
    "settled_at" timestamp with time zone,
    "not_settled_at" timestamp with time zone,
    "settled_evidence_bundle" jsonb,
    "not_settled_evidence_bundle" jsonb,
    "reconciliation_observations" jsonb,
    "next_probe_at" timestamp with time zone,
    "probe_count" integer NOT NULL DEFAULT 0,
    "version" integer NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "pi_operation_id_unique" ON "payment_intents" ("operation_id");
CREATE INDEX IF NOT EXISTS "pi_nonce_idx" ON "payment_intents" ("nonce");
CREATE INDEX IF NOT EXISTS "pi_settlement_state_idx" ON "payment_intents" ("settlement_state");
CREATE INDEX IF NOT EXISTS "pi_next_probe_at_idx" ON "payment_intents" ("next_probe_at");
CREATE INDEX IF NOT EXISTS "pi_authorizer_idx" ON "payment_intents" ("authorizer");

-- ============================================================================
-- Nonce Registry (prevents double-spend across restarts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "nonce_registry" (
    "nonce" text PRIMARY KEY NOT NULL,
    "operation_id" text NOT NULL,
    "status" text NOT NULL,
    "payer" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "nr_operation_id_idx" ON "nonce_registry" ("operation_id");
CREATE INDEX IF NOT EXISTS "nr_status_idx" ON "nonce_registry" ("status");

-- ============================================================================
-- Reconciliation Observations (on-chain observation evidence)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "reconciliation_observations" (
    "observation_id" text PRIMARY KEY NOT NULL,
    "payment_intent_id" text NOT NULL,
    "attempt_id" text NOT NULL,
    "rpc_provider_id" text NOT NULL,
    "underlying_provider" text NOT NULL,
    "observed_at" timestamp with time zone NOT NULL,
    "block_number" bigint NOT NULL,
    "chain_head" bigint NOT NULL,
    "authorization_state" boolean,
    "valid_before" bigint NOT NULL,
    "result" text NOT NULL,
    "staleness_blocks" integer,
    "error" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ro_payment_intent_id_idx" ON "reconciliation_observations" ("payment_intent_id");
CREATE INDEX IF NOT EXISTS "ro_rpc_provider_id_idx" ON "reconciliation_observations" ("rpc_provider_id");

-- ============================================================================
-- Reconciliation Jobs (on-chain observation scheduling — NOT execution)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "reconciliation_jobs" (
    "job_id" text PRIMARY KEY NOT NULL,
    "payment_intent_id" text NOT NULL,
    "status" text NOT NULL,
    "probe_count" integer NOT NULL DEFAULT 0,
    "next_probe_at" timestamp with time zone NOT NULL,
    "locked_by" text,
    "locked_until" timestamp with time zone,
    "last_error" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "rj_payment_intent_id_idx" ON "reconciliation_jobs" ("payment_intent_id");
CREATE INDEX IF NOT EXISTS "rj_pending_probe_idx" ON "reconciliation_jobs" ("status", "next_probe_at");

-- ============================================================================
-- Execution Attempts (seller invocation evidence)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "execution_attempts" (
    "attempt_id" text PRIMARY KEY NOT NULL,
    "operation_id" text NOT NULL,
    "execution_id" text NOT NULL,
    "attempt_number" integer NOT NULL DEFAULT 1,
    "status" text NOT NULL,
    "request_url" text,
    "request_method" text,
    "request_body" jsonb,
    "response_status_code" integer,
    "response_body" jsonb,
    "response_headers" jsonb,
    "error_reason" text,
    "idempotency_key" text,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "exec_attempts_operation_id_idx" ON "execution_attempts" ("operation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "exec_attempts_execution_id_attempt_unique" ON "execution_attempts" ("execution_id", "attempt_number");
CREATE INDEX IF NOT EXISTS "exec_attempts_status_idx" ON "execution_attempts" ("status");

-- ============================================================================
-- Recovery Jobs (post-settlement execution orchestration — NOT reconciliation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "recovery_jobs" (
    "job_id" text PRIMARY KEY NOT NULL,
    "operation_id" text NOT NULL,
    "job_type" text NOT NULL,
    "status" text NOT NULL,
    "priority" integer NOT NULL DEFAULT 0,
    "max_attempts" integer NOT NULL DEFAULT 3,
    "current_attempt" integer NOT NULL DEFAULT 0,
    "locked_by" text,
    "locked_until" timestamp with time zone,
    "last_error" text,
    "metadata" jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "rj_operation_id_idx" ON "recovery_jobs" ("operation_id");
CREATE INDEX IF NOT EXISTS "rj_pending_probe_idx" ON "recovery_jobs" ("status", "priority");
