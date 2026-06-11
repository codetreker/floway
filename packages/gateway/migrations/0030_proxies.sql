-- Adds the proxies catalog, the per-(proxy, upstream) backoff table, and
-- the per-upstream proxy fallback list column. dial_timeout_seconds is
-- nullable: NULL means "use the gateway default" (DEFAULT_DIAL_DEADLINE_MS
-- in @floway-dev/proxy); an explicit integer overrides it for that row.

CREATE TABLE proxies (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  dial_timeout_seconds INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- proxy_id always references a proxies.id. We omit the FK because the
-- application sweeps backoff rows unconditionally on proxy/upstream DELETE
-- rather than relying on ON DELETE CASCADE.
CREATE TABLE proxy_upstream_backoffs (
  proxy_id      TEXT NOT NULL,
  upstream_id   TEXT NOT NULL,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  last_error    TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);
-- listForUpstream is called on every proxied dial and queries by
-- upstream_id alone, which is the right column of the composite PK and
-- not covered by it. The table stays small in practice (one row per
-- failing (proxy, upstream) pair, cleared on success), so a full scan
-- is microseconds at the scales we ship; if that stops being true we
-- should add an index on upstream_id.

ALTER TABLE upstreams
  ADD COLUMN proxy_fallback_list_json TEXT NOT NULL DEFAULT '[]';
