-- B8-001: Durable idempotency — partial unique index on (client_id, request_id)
-- Only enforced when both columns are NOT NULL.
-- Calls without clientId remain backward-compatible.

CREATE UNIQUE INDEX IF NOT EXISTS pi_client_request_unique
  ON payment_intents (client_id, request_id)
  WHERE client_id IS NOT NULL AND request_id IS NOT NULL;
