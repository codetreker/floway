-- Widen the `usage.dimension` CHECK list to admit `input_cache_write_1h`.
--
-- Anthropic's `extended-cache-ttl-2025-04-11` beta surfaces 1-hour cache
-- writes under `usage.cache_creation.ephemeral_1h_input_tokens`. Until now
-- we folded both 5m and 1h writes into the same `input_cache_write` bucket,
-- which under-bills 1h writes (priced at input × 2 vs. input × 1.25 for 5m).
-- Adding the dimension as a disjoint bucket requires recreating `usage`
-- because SQLite cannot alter a CHECK constraint in place.
--
-- `usage_requests` is untouched: it does not carry a dimension column.

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

INSERT INTO usage_new (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price)
  SELECT key_id, model, upstream, model_key, hour, dimension, tokens, unit_price FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, dimension);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);
