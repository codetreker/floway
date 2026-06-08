CREATE TABLE IF NOT EXISTS upstream_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  bearer_token TEXT NOT NULL,
  supported_endpoints TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  enabled_fixes TEXT NOT NULL DEFAULT '[]',
  path_overrides TEXT
);

CREATE INDEX idx_upstream_configs_sort ON upstream_configs (sort_order, created_at);
