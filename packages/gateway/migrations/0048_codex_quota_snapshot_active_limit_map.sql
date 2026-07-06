-- Rebucket Codex quota snapshots written before active-limit bucketing landed.
-- Old rows store one snapshot directly at accounts[0].quotaSnapshot:
--   { "data": { "active_limit": "premium", ... }, "fetchedAt": 123 }
--
-- The current state contract stores snapshots keyed by active limit:
--   { "premium": { "data": { "active_limit": "premium", ... }, "fetchedAt": 123 } }
--
-- Keep this as a data migration rather than a runtime legacy shape. The
-- provider state validator accepts only the current map form.

UPDATE upstreams
SET state_json = json_set(
  state_json,
  '$.accounts[0].quotaSnapshot',
  json_object(
    CASE
      WHEN json_type(state_json, '$.accounts[0].quotaSnapshot.data.active_limit') = 'text'
        AND trim(json_extract(state_json, '$.accounts[0].quotaSnapshot.data.active_limit')) <> ''
        AND trim(json_extract(state_json, '$.accounts[0].quotaSnapshot.data.active_limit')) NOT IN ('__proto__', 'constructor', 'prototype')
      THEN trim(json_extract(state_json, '$.accounts[0].quotaSnapshot.data.active_limit'))
      ELSE 'unknown'
    END,
    json_object(
      'data', json(json_extract(state_json, '$.accounts[0].quotaSnapshot.data')),
      'fetchedAt', json_extract(state_json, '$.accounts[0].quotaSnapshot.fetchedAt')
    )
  )
)
WHERE provider = 'codex'
  AND state_json IS NOT NULL
  AND json_type(state_json, '$.accounts[0].quotaSnapshot') = 'object'
  AND json_type(state_json, '$.accounts[0].quotaSnapshot.fetchedAt') IN ('integer', 'real')
  AND json_type(state_json, '$.accounts[0].quotaSnapshot.data') = 'object';
