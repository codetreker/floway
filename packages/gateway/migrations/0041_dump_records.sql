-- D1/sqlite table backing the per-key request dump feature.
--
-- Bodies live in the FileProvider; the row carries only descriptors that
-- point at them. Keeps the row small and avoids base64 inflation.
--
-- `upstream_id` is its own column so list/get queries can LEFT JOIN against
-- `upstreams` and surface the current name and kind. Freezing those values
-- into `meta_json` would let an admin rename go silently un-honored on every
-- historical record.
CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,            -- ULID
  created_at INTEGER NOT NULL, -- unix ms
  upstream_id TEXT,
  meta_json TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  response_headers_json TEXT,
  -- Either NULL or a JSON descriptor pointing at the gzipped body file in
  -- the FileProvider. Response side carries a `type` discriminator for
  -- bytes vs events. No content hash — we do not deduplicate across keys.
  request_body_descriptor TEXT,
  response_body_descriptor TEXT,
  PRIMARY KEY (key_id, id)
);

-- The cron sweep filters by `(key_id, created_at < cutoff)` and the
-- dashboard list scans newest-first under one key, so a compound index
-- on (key_id, created_at DESC) drives both.
CREATE INDEX idx_dump_records_key_created ON dump_records(key_id, created_at DESC);
