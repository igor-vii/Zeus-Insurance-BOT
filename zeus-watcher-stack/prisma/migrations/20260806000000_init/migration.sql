-- Prisma initial migration — zeus-watcher-stack
-- Tables: Policy, Vote, Claim

CREATE TABLE "Policy" (
    "id"            TEXT        NOT NULL,
    "chainId"       INTEGER     NOT NULL,
    "policyId"      TEXT        NOT NULL,
    "contract"      TEXT        NOT NULL,
    "buyer"         TEXT        NOT NULL,
    "seller"        TEXT        NOT NULL,
    "amount"        TEXT        NOT NULL,
    "premium"       TEXT        NOT NULL,
    "retryDeadline" BIGINT      NOT NULL,
    "isActive"      BOOLEAN     NOT NULL DEFAULT true,
    "isPaidOut"     BOOLEAN     NOT NULL DEFAULT false,
    "isExpired"     BOOLEAN     NOT NULL DEFAULT false,
    "status"        TEXT        NOT NULL DEFAULT 'pending',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Vote" (
    "id"        TEXT         NOT NULL,
    "policyId"  TEXT         NOT NULL,
    "watcher"   TEXT         NOT NULL,
    "vote"      BOOLEAN,
    "signature" TEXT         NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Claim" (
    "id"        TEXT         NOT NULL,
    "policyId"  TEXT         NOT NULL,
    "txHash"    TEXT,
    "gasUsed"   TEXT,
    "gasPrice"  TEXT,
    "status"    TEXT         NOT NULL DEFAULT 'pending',
    "error"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- Unique constraints & indexes
CREATE UNIQUE INDEX "Policy_chainId_policyId_key"   ON "Policy"("chainId", "policyId");
CREATE        INDEX "Policy_status_retryDeadline_idx" ON "Policy"("status", "retryDeadline");
CREATE UNIQUE INDEX "Vote_policyId_watcher_key"      ON "Vote"("policyId", "watcher");

-- Foreign keys
ALTER TABLE "Vote"  ADD CONSTRAINT "Vote_policyId_fkey"  FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma migrations tracking table
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT         NOT NULL,
    "checksum"              TEXT         NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        TEXT         NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER      NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
);
