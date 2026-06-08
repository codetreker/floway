-- Rename legacy azure deployment cost keys to the BillingDimension names.
--
-- The pricing model moved from {input, output, cache_read, cache_write} to the
-- BillingDimension keys, so the azure config parser now recognizes only
-- `input_cache_read` / `input_cache_write`. Existing azure upstream configs
-- still carry the old `cache_read` / `cache_write` keys inside
-- deployments[].cost; left untouched, the parser would drop them and the
-- affected deployments would bill cached input at the uncached input fallback.
--
-- The legacy tokens only ever appear as cost-object keys in these configs, so a
-- targeted replace of the quoted JSON key is exact and idempotent (a second run
-- finds nothing left to rewrite). SQLite cannot easily rewrite keys nested in
-- the deployments[] array via json_* in a single UPDATE, and a string replace
-- of the unique quoted key is the simplest correct transform here.
UPDATE upstreams
SET config_json = REPLACE(REPLACE(config_json, '"cache_read"', '"input_cache_read"'), '"cache_write"', '"input_cache_write"')
WHERE provider = 'azure' AND (config_json LIKE '%"cache_read"%' OR config_json LIKE '%"cache_write"%');
