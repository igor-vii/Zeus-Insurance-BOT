-- Migration 0009: Repair C3 — Pre-intent evidence persistence + safe replay
-- 1) Allow reconciliation_observations rows BEFORE a payment intent exists
--    (durable evidence outbox). Additive & safe for existing data.
-- 2) Partial index for deterministic chronological retrieval of evidence-log
--    rows by owning operation id.
-- Idempotent via catalog guards.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reconciliation_observations'
      AND column_name = 'payment_intent_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "reconciliation_observations" ALTER COLUMN "payment_intent_id" DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ro_evidence_log_operation_idx"
  ON "reconciliation_observations" ("attempt_id", "observed_at")
  WHERE "rpc_provider_id" = 'evidence-log';
