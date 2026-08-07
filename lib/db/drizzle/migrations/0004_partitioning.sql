-- Partition watcher_observations by month for better performance
-- Note: In production, you should create a trigger or use pg_partman for automatic partition creation.

CREATE TABLE watcher_observations_partitioned (
    LIKE watcher_observations INCLUDING ALL
) PARTITION BY RANGE ("timestamp");

-- Example partitions
CREATE TABLE watcher_observations_y2026m01 PARTITION OF watcher_observations_partitioned
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE watcher_observations_y2026m02 PARTITION OF watcher_observations_partitioned
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
