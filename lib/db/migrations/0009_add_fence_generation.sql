-- R2.2 Repair #9: Add monotonic fencing generation to recovery_jobs
-- for stale-worker protection. Each lease claim atomically increments
-- this value. Workers must present the current generation when committing
-- state transitions; stale workers with old generations are rejected.

ALTER TABLE recovery_jobs
ADD COLUMN IF NOT EXISTS fence_generation INTEGER NOT NULL DEFAULT 0;

-- Backfill: existing RUNNING jobs get generation 1 (they were claimed at least once)
UPDATE recovery_jobs SET fence_generation = 1 WHERE status = 'RUNNING' AND fence_generation = 0;
