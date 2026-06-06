-- Split usage accounting into two narrow tables keyed by disjoint billing
-- dimensions.
--
-- Why this exists: the wide usage table modeled tokens as fixed columns
-- (input_tokens/output_tokens/cache_read_tokens/cache_creation_tokens) with a
-- single cost_json pricing snapshot of {input,output,cache_read?,cache_write?}.
-- That shape cannot represent token-based image models, which bill text-input
-- vs image-input vs image-output separately. We generalize to a set of
-- disjoint BillingDimension rows:
--   input, input_cache_read, input_cache_write, input_image, output, output_image
--
-- New shape:
--   usage(key_id, model, upstream, model_key, hour, dimension, tokens, unit_price)
--     one row per non-zero dimension; tokens are disjoint; unit_price is the
--     USD-per-1M snapshot for that dimension at write time (NULL = unknown).
--   usage_requests(key_id, model, upstream, model_key, hour, requests)
--     request counts moved out of the per-dimension table.
--
-- The old input_tokens column was inclusive of the cache columns; we recover
-- the disjoint bare input as input_tokens - cache_read_tokens -
-- cache_creation_tokens. Each old cost_json key maps onto a dimension unit
-- price, with cache_read/cache_write falling back to input when absent.

CREATE TABLE usage_dimensions (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

-- COALESCE(upstream, '') mirrors the rest of the telemetry schema: a nullable
-- upstream cannot participate directly in a PRIMARY KEY because SQLite treats
-- NULLs as distinct, which would defeat the additive ON CONFLICT upsert.
CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage_dimensions (key_id, model, COALESCE(upstream, ''), model_key, hour, dimension);
CREATE INDEX idx_usage_dimension_hour ON usage_dimensions (hour);

CREATE TABLE usage_requests (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, hour);
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);

-- Explode each old row into one dimension row per non-zero count. unit_price is
-- read from cost_json via json_extract; cache dimensions fall back to the input
-- rate when their key is absent, matching unitPriceForDimension. The bare-input
-- expression is non-negative for every historical row because the old write
-- path stored input_tokens inclusive of both cache columns, so the `> 0` filter
-- only omits zero rows — it is not handling negative data.
INSERT INTO usage_dimensions (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price)
SELECT key_id, model, upstream, model_key, hour, 'input',
       input_tokens - cache_read_tokens - cache_creation_tokens,
       json_extract(cost_json, '$.input')
FROM usage
WHERE input_tokens - cache_read_tokens - cache_creation_tokens > 0;

INSERT INTO usage_dimensions (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price)
SELECT key_id, model, upstream, model_key, hour, 'input_cache_read',
       cache_read_tokens,
       COALESCE(json_extract(cost_json, '$.cache_read'), json_extract(cost_json, '$.input'))
FROM usage
WHERE cache_read_tokens > 0;

INSERT INTO usage_dimensions (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price)
SELECT key_id, model, upstream, model_key, hour, 'input_cache_write',
       cache_creation_tokens,
       COALESCE(json_extract(cost_json, '$.cache_write'), json_extract(cost_json, '$.input'))
FROM usage
WHERE cache_creation_tokens > 0;

INSERT INTO usage_dimensions (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price)
SELECT key_id, model, upstream, model_key, hour, 'output',
       output_tokens,
       json_extract(cost_json, '$.output')
FROM usage
WHERE output_tokens > 0;

INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, requests)
SELECT key_id, model, upstream, model_key, hour, requests
FROM usage
WHERE requests > 0;

DROP TABLE usage;
ALTER TABLE usage_dimensions RENAME TO usage;
