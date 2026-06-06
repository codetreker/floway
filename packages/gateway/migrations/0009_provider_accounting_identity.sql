-- This migration was named before the project terminology changed from
-- "accounting" to "telemetry". Do not rename it: the filename is part of the
-- D1 migration identity once applied.

CREATE TABLE __model_name_source (
  model_key TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO __model_name_source (model_key)
SELECT model FROM usage;

INSERT OR IGNORE INTO __model_name_source (model_key)
SELECT model FROM performance_summary;

INSERT OR IGNORE INTO __model_name_source (model_key)
SELECT model FROM performance_latency_buckets;

CREATE TABLE __model_name_migration (
  model_key TEXT PRIMARY KEY,
  model TEXT NOT NULL
);

-- Historical rows used the provider/upstream model id as `model`. From this
-- migration onward, `model` is the public model id and `model_key` preserves
-- the old provider-owned telemetry key. Keep this conversion here only; the
-- runtime must treat stored `model` as already display/public-normalized.
INSERT INTO __model_name_migration (model_key, model)
WITH dot_normalized AS (
  SELECT
    model_key,
    CASE
      WHEN model_key = 'codex-auto-review' THEN 'gpt-5.4'
      WHEN model_key LIKE 'claude-%' THEN replace(model_key, '.', '-')
      ELSE model_key
    END AS model
  FROM __model_name_source
), date_stripped AS (
  SELECT
    model_key,
    CASE
      WHEN model GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        THEN substr(model, 1, length(model) - 9)
      ELSE model
    END AS model
  FROM dot_normalized
), variant_stripped AS (
  SELECT
    model_key,
    CASE
      WHEN model LIKE '%-1m-internal' THEN substr(model, 1, length(model) - 12)
      WHEN model LIKE '%-xhigh' THEN substr(model, 1, length(model) - 6)
      WHEN model LIKE '%-high' THEN substr(model, 1, length(model) - 5)
      WHEN model LIKE '%-1m' THEN substr(model, 1, length(model) - 3)
      ELSE model
    END AS model
  FROM date_stripped
)
SELECT model_key, model FROM variant_stripped;

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_new (
  key_id,
  model,
  upstream,
  model_key,
  hour,
  requests,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_creation_tokens
)
SELECT
  usage.key_id,
  __model_name_migration.model,
  NULL,
  usage.model,
  usage.hour,
  usage.requests,
  usage.input_tokens,
  usage.output_tokens,
  usage.cache_read_tokens,
  usage.cache_creation_tokens
FROM usage
JOIN __model_name_migration ON __model_name_migration.model_key = usage.model;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour);
CREATE INDEX idx_usage_hour ON usage (hour);

CREATE TABLE performance_summary_new (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  source_api TEXT NOT NULL CHECK (source_api IN ('messages', 'responses', 'chat-completions', 'gemini', 'embeddings')),
  target_api TEXT NOT NULL CHECK (target_api IN ('messages', 'responses', 'chat-completions', 'gemini', 'embeddings')),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms_sum INTEGER NOT NULL DEFAULT 0
);

INSERT INTO performance_summary_new (
  hour,
  metric_scope,
  key_id,
  model,
  upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  requests,
  errors,
  total_ms_sum
)
SELECT
  performance_summary.hour,
  performance_summary.metric_scope,
  performance_summary.key_id,
  __model_name_migration.model,
  NULL,
  performance_summary.model,
  performance_summary.source_api,
  performance_summary.target_api,
  performance_summary.stream,
  performance_summary.runtime_location,
  performance_summary.requests,
  performance_summary.errors,
  performance_summary.total_ms_sum
FROM performance_summary
JOIN __model_name_migration
  ON __model_name_migration.model_key = performance_summary.model;

DROP TABLE performance_summary;
ALTER TABLE performance_summary_new RENAME TO performance_summary;

CREATE UNIQUE INDEX idx_performance_summary_identity
  ON performance_summary (
    hour,
    metric_scope,
    key_id,
    model,
    COALESCE(upstream, ''),
    model_key,
    source_api,
    target_api,
    stream,
    runtime_location
  );
CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);
CREATE INDEX idx_performance_summary_scope_hour
  ON performance_summary (metric_scope, hour);
CREATE INDEX idx_performance_summary_key_scope_hour
  ON performance_summary (key_id, metric_scope, hour);

CREATE TABLE performance_latency_buckets_new (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  source_api TEXT NOT NULL CHECK (source_api IN ('messages', 'responses', 'chat-completions', 'gemini', 'embeddings')),
  target_api TEXT NOT NULL CHECK (target_api IN ('messages', 'responses', 'chat-completions', 'gemini', 'embeddings')),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  lower_ms INTEGER NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO performance_latency_buckets_new (
  hour,
  metric_scope,
  key_id,
  model,
  upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  lower_ms,
  upper_ms,
  count
)
SELECT
  performance_latency_buckets.hour,
  performance_latency_buckets.metric_scope,
  performance_latency_buckets.key_id,
  __model_name_migration.model,
  NULL,
  performance_latency_buckets.model,
  performance_latency_buckets.source_api,
  performance_latency_buckets.target_api,
  performance_latency_buckets.stream,
  performance_latency_buckets.runtime_location,
  performance_latency_buckets.lower_ms,
  performance_latency_buckets.upper_ms,
  performance_latency_buckets.count
FROM performance_latency_buckets
JOIN __model_name_migration
  ON __model_name_migration.model_key = performance_latency_buckets.model;

DROP TABLE performance_latency_buckets;
ALTER TABLE performance_latency_buckets_new RENAME TO performance_latency_buckets;

CREATE UNIQUE INDEX idx_performance_latency_buckets_identity
  ON performance_latency_buckets (
    hour,
    metric_scope,
    key_id,
    model,
    COALESCE(upstream, ''),
    model_key,
    source_api,
    target_api,
    stream,
    runtime_location,
    lower_ms,
    upper_ms
  );
CREATE INDEX idx_performance_latency_buckets_hour
  ON performance_latency_buckets (hour);
CREATE INDEX idx_performance_latency_buckets_scope_hour
  ON performance_latency_buckets (metric_scope, hour);
CREATE INDEX idx_performance_latency_buckets_key_scope_hour
  ON performance_latency_buckets (key_id, metric_scope, hour);

DROP TABLE IF EXISTS account_model_backoffs;
DROP TABLE __model_name_migration;
DROP TABLE __model_name_source;
