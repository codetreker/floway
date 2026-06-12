CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  -- NOCASE so usernames are matched case-insensitively everywhere: the
  -- `WHERE username = ?` login lookup and the active-username unique index
  -- below both inherit this collation, so "Admin" and "admin" are the same
  -- account and cannot coexist.
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  upstream_ids TEXT,
  can_view_global_telemetry INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_users_username_active ON users(username) WHERE deleted_at IS NULL;

INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, can_view_global_telemetry, created_at)
  VALUES (1, 'admin', NULL, 1, NULL, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE api_keys_new (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  upstream_ids TEXT,
  deleted_at TEXT
);
INSERT INTO api_keys_new (id, user_id, name, key, created_at, last_used_at, upstream_ids, deleted_at)
  SELECT id, 1, name, key, created_at, last_used_at, upstream_ids, NULL FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;
CREATE INDEX idx_api_keys_user ON api_keys(user_id) WHERE deleted_at IS NULL;
