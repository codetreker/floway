-- SQLite cannot alter a CHECK constraint in place. Rebuild the table to add
-- the M365 Copilot Web provider kind while preserving every existing column
-- and row unchanged.
CREATE TABLE upstreams_with_m365_copilot_web (
  id                         TEXT PRIMARY KEY,
  provider                   TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama', 'm365-copilot-web')),
  name                       TEXT NOT NULL,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  config_json                TEXT NOT NULL,
  state_json                 TEXT NULL,
  flag_overrides             TEXT NOT NULL DEFAULT '[]',
  disabled_public_model_ids  TEXT NOT NULL DEFAULT '[]',
  proxy_fallback_list_json   TEXT NOT NULL DEFAULT '[]',
  model_prefix_json          TEXT NULL,
  models_cache_json          TEXT NULL,
  hue                        INTEGER NOT NULL CHECK (hue >= 0 AND hue < 360)
);

INSERT INTO upstreams_with_m365_copilot_web (
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  state_json,
  flag_overrides,
  disabled_public_model_ids,
  proxy_fallback_list_json,
  model_prefix_json,
  models_cache_json,
  hue
)
SELECT
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  state_json,
  flag_overrides,
  disabled_public_model_ids,
  proxy_fallback_list_json,
  model_prefix_json,
  models_cache_json,
  hue
FROM upstreams;

DROP TABLE upstreams;
ALTER TABLE upstreams_with_m365_copilot_web RENAME TO upstreams;
CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);

-- One Microsoft account can back only one upstream. Both account identifiers
-- are canonical lowercase UUIDs at the provider boundary; lower() also makes
-- the storage invariant hold if a row bypasses that boundary. SQLite permits
-- deterministic JSON expressions in indexes, and the partial predicate keeps
-- malformed JSON belonging to unrelated provider kinds outside the expression.
-- https://www.sqlite.org/expridx.html
-- https://www.sqlite.org/partialindex.html
-- https://www.sqlite.org/json1.html#jex
CREATE UNIQUE INDEX idx_upstreams_m365_account
  ON upstreams (
    lower(json_extract(config_json, '$.account.tenantId')),
    lower(json_extract(config_json, '$.account.objectId'))
  )
  WHERE provider = 'm365-copilot-web';
