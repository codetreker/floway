CREATE TABLE upstreams_new (
  id                         TEXT PRIMARY KEY,
  provider                   TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure', 'codex')),
  name                       TEXT NOT NULL,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  config_json                TEXT NOT NULL,
  state_json                 TEXT NULL,
  flag_overrides             TEXT NOT NULL DEFAULT '[]',
  disabled_public_model_ids  TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO upstreams_new
  (id, provider, name, enabled, sort_order, created_at, updated_at,
   config_json, state_json, flag_overrides, disabled_public_model_ids)
SELECT
   id, provider, name, enabled, sort_order, created_at, updated_at,
   config_json, NULL,        flag_overrides, disabled_public_model_ids
FROM upstreams;

DROP TABLE upstreams;
ALTER TABLE upstreams_new RENAME TO upstreams;

CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);
