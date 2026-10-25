-- Migration 0010: R0 repair — durable round-trip of non-column extra fields.
-- updatePaymentIntentStatus(id, status, extra) may carry auxiliary fields
-- (e.g. the EIP-3009 `signature`) that have no dedicated column. Persist them
-- in a JSONB sidecar so a restart cannot lose them. Additive & idempotent.
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "extra_fields" jsonb;
