-- D1/SQLite does not support adding a CHECK constraint or extending the
-- primary key in-place via ALTER TABLE, so rebuild via swap. Existing rows
-- backfill to action='search' because every prior recorded call was a
-- search call (fetch_page is introduced in this change set).

CREATE TABLE search_usage_new (
  provider TEXT NOT NULL CHECK (provider IN ('tavily', 'microsoft-grounding')),
  key_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'search' CHECK (action IN ('search', 'fetch_page')),
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_id, action, hour)
);

INSERT INTO search_usage_new (provider, key_id, action, hour, requests)
SELECT provider, key_id, 'search', hour, requests FROM search_usage;

DROP INDEX IF EXISTS idx_search_usage_hour;
DROP TABLE search_usage;
ALTER TABLE search_usage_new RENAME TO search_usage;
CREATE INDEX idx_search_usage_hour ON search_usage (hour);
