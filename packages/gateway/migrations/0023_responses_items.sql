CREATE TABLE responses_items (
  id TEXT NOT NULL,
  api_key_id TEXT,
  upstream_id TEXT,
  upstream_item_id TEXT,
  item_type TEXT NOT NULL,
  payload_json TEXT,
  encrypted_content_hash TEXT,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(item_type) > 0),
  CHECK (upstream_id IS NOT NULL OR upstream_item_id IS NULL)
);

CREATE UNIQUE INDEX idx_responses_items_id_scope ON responses_items (id, COALESCE(api_key_id, ''));
CREATE INDEX idx_responses_items_api_key_id ON responses_items (api_key_id);
CREATE INDEX idx_responses_items_created_at ON responses_items (created_at);
-- Items echoed back without a gateway id — Responses reasoning and compaction
-- carry only `encrypted_content` — are matched by the hash of that blob to
-- recover their owning upstream for affinity routing.
CREATE INDEX idx_responses_items_enc_hash ON responses_items (api_key_id, encrypted_content_hash);
