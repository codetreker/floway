-- The previous "models_cache_v2:" prefix is replaced by "models_store:" in
-- code. The old rows are unreachable; clean them up so the config table does
-- not accumulate dead entries. Mirrors the cleanup precedent in 0010.

DELETE FROM config WHERE key >= 'models_cache_v2:' AND key < 'models_cache_v2;';
