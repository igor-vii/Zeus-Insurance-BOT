-- Migration 0008: Repair C1 — Operation request semantics persistence
-- Adds target, method, payment_policy columns to payment_intents
-- so that Operation reconstruction after restart preserves request semantics.
-- Safe to re-run: uses IF NOT EXISTS via ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "target" text;
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "method" text;
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "payment_policy" jsonb;
