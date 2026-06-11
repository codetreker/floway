-- Drop the source_api / target_api dimensions from the performance tables.
-- Both columns are part of each table's uniqueness identity index, so recreate
-- the tables on the narrower identity and fold the old rows in by summing the
-- counters across the now-absent dimensions. The table shape mirrors migration
-- 0009: `upstream` is nullable and uniqueness is a UNIQUE INDEX over
-- COALESCE(upstream, '') (not a primary key) so NULL upstreams still dedup,
-- which the recorder's ON CONFLICT upserts rely on.

CREATE TABLE performance_summary_new (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms_sum INTEGER NOT NULL DEFAULT 0
);

INSERT INTO performance_summary_new (hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, requests, errors, total_ms_sum)
  SELECT hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, SUM(requests), SUM(errors), SUM(total_ms_sum)
  FROM performance_summary
  GROUP BY hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location;

DROP TABLE performance_summary;
ALTER TABLE performance_summary_new RENAME TO performance_summary;

CREATE UNIQUE INDEX idx_performance_summary_identity
  ON performance_summary (hour, metric_scope, key_id, model, COALESCE(upstream, ''), model_key, stream, runtime_location);
CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);
CREATE INDEX idx_performance_summary_scope_hour ON performance_summary (metric_scope, hour);
CREATE INDEX idx_performance_summary_key_scope_hour ON performance_summary (key_id, metric_scope, hour);

CREATE TABLE performance_latency_buckets_new (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  lower_ms INTEGER NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO performance_latency_buckets_new (hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, lower_ms, upper_ms, count)
  SELECT hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, lower_ms, upper_ms, SUM(count)
  FROM performance_latency_buckets
  GROUP BY hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, lower_ms, upper_ms;

DROP TABLE performance_latency_buckets;
ALTER TABLE performance_latency_buckets_new RENAME TO performance_latency_buckets;

CREATE UNIQUE INDEX idx_performance_latency_buckets_identity
  ON performance_latency_buckets (hour, metric_scope, key_id, model, COALESCE(upstream, ''), model_key, stream, runtime_location, lower_ms, upper_ms);
CREATE INDEX idx_performance_latency_buckets_hour ON performance_latency_buckets (hour);
CREATE INDEX idx_performance_latency_buckets_scope_hour ON performance_latency_buckets (metric_scope, hour);
CREATE INDEX idx_performance_latency_buckets_key_scope_hour ON performance_latency_buckets (key_id, metric_scope, hour);
