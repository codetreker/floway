-- Rename every custom upstream's pathOverrides keys to the OpenAI-canonical
-- path-fragment form (e.g. `chat_completions` -> `/chat/completions`,
-- `images_generations` -> `/images/generations`). The new key matches the
-- public URL it overrides, so the runtime no longer needs a defaults lookup
-- table — `/v1` + the key reproduces the default upstream path. Each key is
-- moved independently with `json_patch` (add new) + `json_remove` (drop old)
-- gated on the old key actually existing, which keeps the migration
-- idempotent and a no-op on rows that never opted into overrides.

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/completions', json_extract(config_json, '$.pathOverrides.completions')))),
  '$.pathOverrides.completions'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.completions') IS NOT NULL;

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/chat/completions', json_extract(config_json, '$.pathOverrides.chat_completions')))),
  '$.pathOverrides.chat_completions'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.chat_completions') IS NOT NULL;

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/responses', json_extract(config_json, '$.pathOverrides.responses')))),
  '$.pathOverrides.responses'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.responses') IS NOT NULL;

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/messages', json_extract(config_json, '$.pathOverrides.messages')))),
  '$.pathOverrides.messages'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.messages') IS NOT NULL;

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/embeddings', json_extract(config_json, '$.pathOverrides.embeddings')))),
  '$.pathOverrides.embeddings'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.embeddings') IS NOT NULL;

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/images/generations', json_extract(config_json, '$.pathOverrides.images_generations')))),
  '$.pathOverrides.images_generations'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.images_generations') IS NOT NULL;

UPDATE upstreams
SET config_json = json_remove(
  json_patch(config_json, json_object('pathOverrides', json_object('/images/edits', json_extract(config_json, '$.pathOverrides.images_edits')))),
  '$.pathOverrides.images_edits'
)
WHERE provider = 'custom' AND json_type(config_json, '$.pathOverrides.images_edits') IS NOT NULL;
