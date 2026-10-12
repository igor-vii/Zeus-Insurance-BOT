-- Durable evidence emitted before a payment intent exists.
-- Intentionally no FK to payment_intents: failed discovery/validation must remain auditable.
CREATE TABLE IF NOT EXISTS pre_intent_evidence (
  evidence_id text PRIMARY KEY,
  operation_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pre_intent_evidence_operation_idx
  ON pre_intent_evidence (operation_id);

CREATE INDEX IF NOT EXISTS pre_intent_evidence_observed_at_idx
  ON pre_intent_evidence (operation_id, observed_at);
