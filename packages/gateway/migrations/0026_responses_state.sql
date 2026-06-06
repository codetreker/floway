ALTER TABLE responses_items ADD COLUMN content_hash TEXT;

CREATE INDEX idx_responses_items_content_hash ON responses_items (api_key_id, content_hash);

CREATE TABLE responses_snapshots (
  id TEXT NOT NULL,
  api_key_id TEXT,
  item_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(item_ids_json) > 0)
);

CREATE UNIQUE INDEX idx_responses_snapshots_id_scope ON responses_snapshots (id, COALESCE(api_key_id, ''));
CREATE INDEX idx_responses_snapshots_refreshed_at ON responses_snapshots (refreshed_at);
