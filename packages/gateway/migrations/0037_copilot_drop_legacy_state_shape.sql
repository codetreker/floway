-- The Copilot refactor that moved per-tier data-plane host routing from
-- a static config.accountType enum to a state.copilotToken.baseUrl field
-- changed two on-disk shapes; this migration cleans them up.
--
-- 1. config_json.accountType is no longer read by the gateway. The per-tier
--    host comes from /copilot_internal/v2/token's `endpoints.api` instead.
--    Strip the field so the source of truth does not drift.
UPDATE upstreams
SET config_json = json_remove(config_json, '$.accountType')
WHERE provider = 'copilot'
  AND json_extract(config_json, '$.accountType') IS NOT NULL;

-- 2. state_json.copilotToken gained a required `baseUrl` field. Pre-
--    refactor entries persisted only `{token, expiresAt}` — without baseUrl
--    the runtime cannot route the data-plane call. SQL cannot backfill
--    baseUrl (it lives in a live response from /copilot_internal/v2/token),
--    so strip the partial entry; the next data-plane request mints a fresh
--    {token, expiresAt, baseUrl} via exchangeCopilotToken().
UPDATE upstreams
SET state_json = json_remove(state_json, '$.copilotToken')
WHERE provider = 'copilot'
  AND state_json IS NOT NULL
  AND json_extract(state_json, '$.copilotToken') IS NOT NULL
  AND json_extract(state_json, '$.copilotToken.baseUrl') IS NULL;
