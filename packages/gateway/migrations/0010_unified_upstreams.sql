CREATE TABLE upstreams (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled_fixes TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);

CREATE TABLE __github_account_order (
  user_id INTEGER PRIMARY KEY,
  sort_order INTEGER NOT NULL
);

INSERT INTO __github_account_order (user_id, sort_order)
SELECT user_id, MIN(sort_order)
FROM (
  SELECT
    CAST(item.value AS INTEGER) AS user_id,
    CAST(item.key AS INTEGER) AS sort_order
  FROM config AS cfg,
    json_each(CASE WHEN json_valid(cfg.value) THEN cfg.value ELSE '[]' END) AS item
  WHERE cfg.key = 'github_account_order'
    AND item.type = 'integer'
)
WHERE user_id IN (SELECT user_id FROM github_accounts)
GROUP BY user_id;

CREATE TABLE __copilot_upstream_migration (
  user_id INTEGER PRIMARY KEY,
  upstream_id TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL
);

INSERT INTO __copilot_upstream_migration (user_id, upstream_id, sort_order)
WITH ranked_accounts AS (
  SELECT
    github_accounts.user_id,
    COALESCE(
      __github_account_order.sort_order,
      COALESCE((SELECT MAX(sort_order) + 1 FROM __github_account_order), 0)
        + ROW_NUMBER() OVER (ORDER BY github_accounts.user_id) - 1
    ) AS sort_order
  FROM github_accounts
  LEFT JOIN __github_account_order
    ON __github_account_order.user_id = github_accounts.user_id
)
SELECT
  user_id,
  'up_' || lower(hex(randomblob(12))),
  sort_order
FROM ranked_accounts
ORDER BY sort_order, user_id;

INSERT INTO upstreams (
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  enabled_fixes
)
SELECT
  migration.upstream_id,
  'copilot',
  COALESCE(NULLIF(github_accounts.name, ''), github_accounts.login, 'GitHub Copilot ' || github_accounts.user_id),
  1,
  migration.sort_order,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  json_object(
    'githubToken', github_accounts.token,
    'accountType', github_accounts.account_type,
    'user', json_object(
      'login', github_accounts.login,
      'avatar_url', github_accounts.avatar_url,
      'name', github_accounts.name,
      'id', github_accounts.user_id
    )
  ),
  '[]'
FROM github_accounts
JOIN __copilot_upstream_migration AS migration
  ON migration.user_id = github_accounts.user_id;

CREATE TABLE __custom_sort_offset (
  offset INTEGER NOT NULL
);

INSERT INTO __custom_sort_offset (offset)
WITH stats AS (
  SELECT
    (SELECT COUNT(*) FROM __copilot_upstream_migration) AS copilot_count,
    (SELECT MAX(sort_order) FROM __copilot_upstream_migration) AS max_copilot_sort,
    (SELECT COUNT(*) FROM upstream_configs) AS custom_count,
    (SELECT MIN(sort_order) FROM upstream_configs) AS min_custom_sort
)
SELECT
  CASE
    WHEN copilot_count > 0
      AND custom_count > 0
      AND min_custom_sort <= max_copilot_sort
      THEN max_copilot_sort - min_custom_sort + 1
    ELSE 0
  END
FROM stats;

INSERT INTO upstreams (
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  enabled_fixes
)
SELECT
  upstream_configs.id,
  'custom',
  upstream_configs.name,
  upstream_configs.enabled,
  upstream_configs.sort_order + (SELECT offset FROM __custom_sort_offset),
  upstream_configs.created_at,
  upstream_configs.created_at,
  json_patch(
    json_object(
      'baseUrl', upstream_configs.base_url,
      'bearerToken', upstream_configs.bearer_token,
      'supportedEndpoints', json(upstream_configs.supported_endpoints)
    ),
    CASE
      WHEN upstream_configs.path_overrides IS NULL THEN '{}'
      ELSE json_object('pathOverrides', json(upstream_configs.path_overrides))
    END
  ),
  json(COALESCE(upstream_configs.enabled_fixes, '[]'))
FROM upstream_configs;

CREATE TABLE __usage_upstream_rewrite AS
WITH normalized AS (
  SELECT
    key_id,
    model,
    CASE
      WHEN upstream LIKE 'openai:%' THEN substr(upstream, length('openai:') + 1)
      WHEN upstream LIKE 'copilot:%'
        AND EXISTS (
          SELECT 1
          FROM __copilot_upstream_migration
          WHERE user_id = CAST(substr(usage.upstream, length('copilot:') + 1) AS INTEGER)
        )
        THEN (
          SELECT upstream_id
          FROM __copilot_upstream_migration
          WHERE user_id = CAST(substr(usage.upstream, length('copilot:') + 1) AS INTEGER)
        )
      WHEN upstream LIKE 'copilot:%' THEN NULL
      ELSE upstream
    END AS normalized_upstream,
    model_key,
    hour,
    requests,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_creation_tokens
  FROM usage
)
SELECT
  key_id,
  model,
  NULLIF(COALESCE(normalized_upstream, ''), '') AS upstream,
  model_key,
  hour,
  SUM(requests) AS requests,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens
FROM normalized
GROUP BY key_id, model, COALESCE(normalized_upstream, ''), model_key, hour;

DELETE FROM usage;

INSERT INTO usage (
  key_id,
  model,
  upstream,
  model_key,
  hour,
  requests,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_creation_tokens
)
SELECT
  key_id,
  model,
  upstream,
  model_key,
  hour,
  requests,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_creation_tokens
FROM __usage_upstream_rewrite;

CREATE TABLE __performance_summary_upstream_rewrite AS
WITH normalized AS (
  SELECT
    hour,
    metric_scope,
    key_id,
    model,
    CASE
      WHEN upstream LIKE 'openai:%' THEN substr(upstream, length('openai:') + 1)
      WHEN upstream LIKE 'copilot:%'
        AND EXISTS (
          SELECT 1
          FROM __copilot_upstream_migration
          WHERE user_id = CAST(substr(performance_summary.upstream, length('copilot:') + 1) AS INTEGER)
        )
        THEN (
          SELECT upstream_id
          FROM __copilot_upstream_migration
          WHERE user_id = CAST(substr(performance_summary.upstream, length('copilot:') + 1) AS INTEGER)
        )
      WHEN upstream LIKE 'copilot:%' THEN NULL
      ELSE upstream
    END AS normalized_upstream,
    model_key,
    source_api,
    target_api,
    stream,
    runtime_location,
    requests,
    errors,
    total_ms_sum
  FROM performance_summary
)
SELECT
  hour,
  metric_scope,
  key_id,
  model,
  NULLIF(COALESCE(normalized_upstream, ''), '') AS upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  SUM(requests) AS requests,
  SUM(errors) AS errors,
  SUM(total_ms_sum) AS total_ms_sum
FROM normalized
GROUP BY
  hour,
  metric_scope,
  key_id,
  model,
  COALESCE(normalized_upstream, ''),
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location;

DELETE FROM performance_summary;

INSERT INTO performance_summary (
  hour,
  metric_scope,
  key_id,
  model,
  upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  requests,
  errors,
  total_ms_sum
)
SELECT
  hour,
  metric_scope,
  key_id,
  model,
  upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  requests,
  errors,
  total_ms_sum
FROM __performance_summary_upstream_rewrite;

CREATE TABLE __performance_latency_upstream_rewrite AS
WITH normalized AS (
  SELECT
    hour,
    metric_scope,
    key_id,
    model,
    CASE
      WHEN upstream LIKE 'openai:%' THEN substr(upstream, length('openai:') + 1)
      WHEN upstream LIKE 'copilot:%'
        AND EXISTS (
          SELECT 1
          FROM __copilot_upstream_migration
          WHERE user_id = CAST(substr(performance_latency_buckets.upstream, length('copilot:') + 1) AS INTEGER)
        )
        THEN (
          SELECT upstream_id
          FROM __copilot_upstream_migration
          WHERE user_id = CAST(substr(performance_latency_buckets.upstream, length('copilot:') + 1) AS INTEGER)
        )
      WHEN upstream LIKE 'copilot:%' THEN NULL
      ELSE upstream
    END AS normalized_upstream,
    model_key,
    source_api,
    target_api,
    stream,
    runtime_location,
    lower_ms,
    upper_ms,
    count
  FROM performance_latency_buckets
)
SELECT
  hour,
  metric_scope,
  key_id,
  model,
  NULLIF(COALESCE(normalized_upstream, ''), '') AS upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  lower_ms,
  upper_ms,
  SUM(count) AS count
FROM normalized
GROUP BY
  hour,
  metric_scope,
  key_id,
  model,
  COALESCE(normalized_upstream, ''),
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  lower_ms,
  upper_ms;

DELETE FROM performance_latency_buckets;

INSERT INTO performance_latency_buckets (
  hour,
  metric_scope,
  key_id,
  model,
  upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  lower_ms,
  upper_ms,
  count
)
SELECT
  hour,
  metric_scope,
  key_id,
  model,
  upstream,
  model_key,
  source_api,
  target_api,
  stream,
  runtime_location,
  lower_ms,
  upper_ms,
  count
FROM __performance_latency_upstream_rewrite;

DELETE FROM config
WHERE key = 'github_account_order'
  OR (key >= 'models_cache_v2:' AND key < 'models_cache_v2;');

DROP TABLE upstream_configs;
DROP TABLE github_accounts;
DROP TABLE __performance_latency_upstream_rewrite;
DROP TABLE __performance_summary_upstream_rewrite;
DROP TABLE __usage_upstream_rewrite;
DROP TABLE __custom_sort_offset;
DROP TABLE __copilot_upstream_migration;
DROP TABLE __github_account_order;
