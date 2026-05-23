-- Rename upstreams.enabled_fixes (TEXT JSON string array) to flag_overrides
-- (TEXT JSON object {id: bool}). Convert existing rows in two passes:
--
--   1. Convert legacy JSON arrays element-by-element to objects: each enabled
--      id becomes `{id: true}`. Force-off entries do not exist in the legacy
--      shape, so the resulting object has only true values.
--   2. Catch-all for any other shape (malformed JSON, scalars, JSON null,
--      objects already present from future or test data) is reset to `{}`
--      so the strict runtime parser at read time sees only valid JSON
--      objects.
--
-- SQLite supports RENAME COLUMN since 3.25. D1 ships a recent SQLite so this
-- is safe.

-- The RENAME COLUMN carries over the original `DEFAULT '[]'` from migration
-- 0010 to the new `flag_overrides` column. SQLite has no `ALTER COLUMN SET
-- DEFAULT` (the only fix is a full table rebuild), so the stale default
-- stays. This is safe because every runtime INSERT supplies the column
-- explicitly (see src/repo/d1.ts), and the strict runtime parser would
-- reject an array-shaped row immediately. Do not rely on column defaults
-- for new INSERTs here.
ALTER TABLE upstreams RENAME COLUMN enabled_fixes TO flag_overrides;

UPDATE upstreams
SET flag_overrides = COALESCE(
  (
    SELECT json_group_object(item.value, json('true'))
    FROM json_each(CASE WHEN json_valid(flag_overrides) THEN flag_overrides ELSE '[]' END) AS item
    WHERE item.type = 'text'
  ),
  '{}'
)
WHERE json_valid(flag_overrides)
  AND json_type(flag_overrides) = 'array';

-- Defensive: any row that wasn't a JSON array is reset to an empty object.
UPDATE upstreams
SET flag_overrides = '{}'
WHERE NOT json_valid(flag_overrides)
   OR json_type(flag_overrides) != 'object';
