-- =============================================================================
-- Zeus Insurance — Railway DB init script
-- Run this in Railway Dashboard → postgres → Console (psql tab)
-- Covers: API server (Drizzle) + Watcher (Prisma)
-- Safe to re-run — uses IF NOT EXISTS / IF NOT EXISTS everywhere
-- =============================================================================

-- ── 1. API SERVER — Drizzle tables ───────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM('admin', 'partner', 'investor', 'oracle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "policies_cache" (
    "id"             text         PRIMARY KEY NOT NULL,
    "buyer"          text         NOT NULL,
    "seller"         text         NOT NULL,
    "amount"         text         NOT NULL,
    "premium"        text         NOT NULL,
    "retry_deadline" text         NOT NULL,
    "max_retries"    text         NOT NULL,
    "is_active"      boolean      NOT NULL DEFAULT true,
    "is_paid_out"    boolean      NOT NULL DEFAULT false,
    "is_expired"     boolean      NOT NULL DEFAULT false,
    "risk_score"     numeric(5,2)          DEFAULT '0.0',
    "created_at"     timestamptz  NOT NULL DEFAULT now(),
    "updated_at"     timestamptz  NOT NULL DEFAULT now(),
    "synced_at"      timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "users" (
    "wallet_address" text      PRIMARY KEY NOT NULL,
    "role"           user_role NOT NULL DEFAULT 'investor',
    "created_at"     timestamptz NOT NULL DEFAULT now(),
    "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sessions" (
    "id"               text        PRIMARY KEY NOT NULL,
    "wallet_address"   text        NOT NULL,
    "nonce"            text,
    "nonce_expires_at" timestamptz,
    "token_hash"       text,
    "token_expires_at" timestamptz,
    "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "api_keys" (
    "id"           text        PRIMARY KEY NOT NULL,
    "name"         text        NOT NULL,
    "key_hash"     text        NOT NULL,
    "created_by"   text        NOT NULL,
    "is_active"    boolean     NOT NULL DEFAULT true,
    "created_at"   timestamptz NOT NULL DEFAULT now(),
    "last_used_at" timestamptz,
    CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id"         text        PRIMARY KEY NOT NULL,
    "action"     text        NOT NULL,
    "actor"      text        NOT NULL,
    "target"     text,
    "metadata"   jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Indexes (Drizzle)
CREATE INDEX IF NOT EXISTS "idx_policies_cache_buyer"            ON "policies_cache"("buyer");
CREATE INDEX IF NOT EXISTS "idx_policies_cache_seller_risk_score" ON "policies_cache"("seller", "risk_score");
CREATE INDEX IF NOT EXISTS "idx_users_role"                      ON "users"("role");
CREATE INDEX IF NOT EXISTS "idx_sessions_wallet"                 ON "sessions"("wallet_address");
CREATE INDEX IF NOT EXISTS "idx_sessions_token_hash"             ON "sessions"("token_hash");
CREATE INDEX IF NOT EXISTS "idx_api_keys_hash"                   ON "api_keys"("key_hash");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_actor"                ON "audit_logs"("actor");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action"               ON "audit_logs"("action");

-- Drizzle migrations tracking
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
    id         SERIAL  PRIMARY KEY,
    hash       text    NOT NULL,
    created_at bigint
);

-- ── 2. WATCHER — Prisma tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Policy" (
    "id"            text         PRIMARY KEY NOT NULL,
    "chainId"       integer      NOT NULL,
    "policyId"      text         NOT NULL,
    "contract"      text         NOT NULL,
    "buyer"         text         NOT NULL,
    "seller"        text         NOT NULL,
    "amount"        text         NOT NULL,
    "premium"       text         NOT NULL,
    "retryDeadline" bigint       NOT NULL,
    "isActive"      boolean      NOT NULL DEFAULT true,
    "isPaidOut"     boolean      NOT NULL DEFAULT false,
    "isExpired"     boolean      NOT NULL DEFAULT false,
    "status"        text         NOT NULL DEFAULT 'pending',
    "createdAt"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Vote" (
    "id"        text         PRIMARY KEY NOT NULL,
    "policyId"  text         NOT NULL,
    "watcher"   text         NOT NULL,
    "vote"      boolean,
    "signature" text         NOT NULL,
    "timestamp" timestamp(3) NOT NULL,
    "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Claim" (
    "id"        text         PRIMARY KEY NOT NULL,
    "policyId"  text         NOT NULL,
    "txHash"    text,
    "gasUsed"   text,
    "gasPrice"  text,
    "status"    text         NOT NULL DEFAULT 'pending',
    "error"     text,
    "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraints & indexes (Prisma)
CREATE UNIQUE INDEX IF NOT EXISTS "Policy_chainId_policyId_key"    ON "Policy"("chainId", "policyId");
CREATE        INDEX IF NOT EXISTS "Policy_status_retryDeadline_idx" ON "Policy"("status", "retryDeadline");
CREATE UNIQUE INDEX IF NOT EXISTS "Vote_policyId_watcher_key"       ON "Vote"("policyId", "watcher");

-- Foreign keys (idempotent via DO block)
DO $$ BEGIN
  ALTER TABLE "Vote"  ADD CONSTRAINT "Vote_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Claim" ADD CONSTRAINT "Claim_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Prisma migrations tracking
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                  text        PRIMARY KEY NOT NULL,
    "checksum"            text        NOT NULL,
    "finished_at"         timestamptz,
    "migration_name"      text        NOT NULL,
    "logs"                text,
    "rolled_back_at"      timestamptz,
    "started_at"          timestamptz NOT NULL DEFAULT now(),
    "applied_steps_count" integer     NOT NULL DEFAULT 0
);

-- =============================================================================
-- Done. All tables, indexes and constraints created.
-- =============================================================================
