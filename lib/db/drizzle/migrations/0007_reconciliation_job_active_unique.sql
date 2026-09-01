-- BLOCK 8.2-B.3-B2-FIX: Partial unique index for reconciliation job deduplication
-- Ensures at most ONE active (PENDING or RUNNING) reconciliation job per paymentIntentId.
-- Historical COMPLETED/UNRESOLVABLE jobs do not block new active job creation.

CREATE UNIQUE INDEX IF NOT EXISTS rj_active_per_intent_idx
ON reconciliation_jobs (payment_intent_id)
WHERE status IN ('PENDING', 'RUNNING');
