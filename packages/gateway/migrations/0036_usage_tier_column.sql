-- Add the per-request service tier column to `usage` + `usage_requests`.
--
-- `tier` is the upstream-stamped service-tier marker (Anthropic `usage.speed`,
-- OpenAI `usage.service_tier`). It participates in bucket identity so a model
-- billed at multiple tiers in one hour aggregates as separate buckets with
-- distinct unit prices; recording writes NULL for base-tier requests and a
-- non-empty string otherwise. The unique index uses `COALESCE(tier, '')`
-- because SQLite treats NULLs as distinct under UNIQUE.
--
-- SQLite cannot add a column to the middle of a UNIQUE INDEX in place, so
-- both tables are recreated. Existing rows backfill `tier = NULL`, which the
-- aggregator treats as base pricing — historical buckets compute identically.

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

INSERT INTO usage_new (key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price)
  SELECT key_id, model, upstream, model_key, hour, NULL, dimension, tokens, unit_price FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''), dimension);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);

CREATE TABLE usage_requests_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_requests_new (key_id, model, upstream, model_key, hour, tier, requests)
  SELECT key_id, model, upstream, model_key, hour, NULL, requests FROM usage_requests;

DROP TABLE usage_requests;
ALTER TABLE usage_requests_new RENAME TO usage_requests;

CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''));
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);
