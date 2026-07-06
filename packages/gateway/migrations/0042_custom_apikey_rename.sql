-- Rename the credential field on every `custom` upstream from `bearerToken`
-- to `apiKey`. The name was misleading even before the third auth mode:
-- with authStyle = 'anthropic' the value is sent as `x-api-key`, not as a
-- bearer token. Adding `authStyle = 'none'` makes the old name actively
-- wrong, so we collapse both inconsistencies in one pass.
--
-- json_type returns NULL only when the path is absent, so it covers JSON-null
-- values as well — using `json_extract(...) IS NOT NULL` would have skipped
-- rows whose bearerToken happened to be stored as JSON null.
UPDATE upstreams
SET config_json = json_patch(
  json_remove(config_json, '$.bearerToken'),
  json_object('apiKey', json_extract(config_json, '$.bearerToken'))
)
WHERE provider = 'custom'
  AND json_type(config_json, '$.bearerToken') IS NOT NULL;

-- The runtime parser used to default an absent authStyle to 'bearer'. The
-- new parser is strict and requires the field. Backfill the legacy rows
-- here so the strict parse path stays clean.
UPDATE upstreams
SET config_json = json_patch(config_json, json_object('authStyle', 'bearer'))
WHERE provider = 'custom'
  AND json_type(config_json, '$.authStyle') IS NULL;
