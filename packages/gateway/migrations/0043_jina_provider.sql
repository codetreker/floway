-- Extend `search_config` and `search_usage` to accept the Jina provider.
--
-- `search_config.jina_api_key` is a plain ADD COLUMN with empty default so the
-- singleton row keeps working untouched until the operator configures Jina via
-- the dashboard.
--
-- `search_usage.provider` carries a CHECK constraint listing the allowed names;
-- D1/SQLite cannot alter a CHECK constraint in place, so we rebuild the table
-- via swap (same pattern as 0017 — see the comment there).

ALTER TABLE search_config ADD COLUMN jina_api_key TEXT NOT NULL DEFAULT '';

CREATE TABLE search_usage_new (
  provider TEXT NOT NULL CHECK (provider IN ('tavily', 'microsoft-grounding', 'jina')),
  key_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'search' CHECK (action IN ('search', 'fetch_page')),
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_id, action, hour)
);

INSERT INTO search_usage_new (provider, key_id, action, hour, requests)
SELECT provider, key_id, action, hour, requests FROM search_usage;

DROP INDEX IF EXISTS idx_search_usage_hour;
DROP TABLE search_usage;
ALTER TABLE search_usage_new RENAME TO search_usage;
CREATE INDEX idx_search_usage_hour ON search_usage (hour);
