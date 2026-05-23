-- Add per-row pricing snapshot column on usage and backfill historical rows.
--
-- Why this exists: migrations 0009 and 0010 introduced the (upstream, model_key)
-- telemetry identity but set upstream to NULL on all pre-existing rows, which
-- left the aggregation layer with no way to look up pricing for historical
-- data. Storing pricing inline at write time avoids re-resolving through the
-- provider registry forever, and lets a one-time backfill recover the
-- historical Copilot rows that were stripped of upstream identity.
--
-- Scope: backfill applies to (a) rows with NULL upstream (assumed Copilot, all
-- pre-bc81e60 traffic) and (b) rows whose upstream is a Copilot row. Custom
-- and Azure rows are left NULL on purpose: those providers were introduced
-- recently and have no historical rows that need fixing; new writes populate
-- cost_json directly from the runtime.
--
-- The pricing table below is a snapshot of
-- src/data-plane/providers/copilot/pricing.ts at the time this migration was
-- authored. Future pricing edits live in TypeScript only; this migration is
-- one-shot historical cleanup and is not the source of truth going forward.

ALTER TABLE usage ADD COLUMN cost_json TEXT;

CREATE TABLE __usage_lookup_key AS
WITH variant_stripped AS (
  SELECT
    rowid,
    CASE
      WHEN model_key LIKE 'claude-%' AND model_key LIKE '%-1m-internal' THEN substr(model_key, 1, length(model_key) - 12)
      WHEN model_key LIKE 'claude-%' AND model_key LIKE '%-xhigh' THEN substr(model_key, 1, length(model_key) - 6)
      WHEN model_key LIKE 'claude-%' AND model_key LIKE '%-high' THEN substr(model_key, 1, length(model_key) - 5)
      WHEN model_key LIKE 'claude-%' AND model_key LIKE '%-1m' THEN substr(model_key, 1, length(model_key) - 3)
      ELSE model_key
    END AS stripped
  FROM usage
), date_stripped AS (
  SELECT
    rowid,
    CASE
      WHEN stripped LIKE 'claude-%' AND stripped GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        THEN substr(stripped, 1, length(stripped) - 9)
      ELSE stripped
    END AS stripped_dated
  FROM variant_stripped
)
SELECT
  rowid,
  CASE
    WHEN stripped_dated LIKE 'claude-%' THEN replace(stripped_dated, '.', '-')
    ELSE stripped_dated
  END AS lookup_key
FROM date_stripped;

CREATE INDEX idx___usage_lookup_key_rowid ON __usage_lookup_key (rowid);

UPDATE usage
SET cost_json = (
  SELECT CASE
    -- Claude family (Opus 4.5/4.6/4.7, Sonnet 4(/4.5/4.6), Haiku 4.5)
    WHEN lookup_key GLOB 'claude-opus-4-[567]'
      THEN '{"input":5,"output":25,"cache_read":0.5,"cache_write":6.25}'
    WHEN lookup_key IN ('claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4-6')
      THEN '{"input":3,"output":15,"cache_read":0.3,"cache_write":3.75}'
    WHEN lookup_key = 'claude-haiku-4-5'
      THEN '{"input":1,"output":5,"cache_read":0.1,"cache_write":1.25}'

    -- GPT-5 family. Order matters: more-specific exact matches before
    -- broader LIKE patterns. The TypeScript table uses regexes; this
    -- expanded form preserves the same semantics.
    WHEN lookup_key = 'gpt-5.5' THEN '{"input":5,"output":30,"cache_read":0.5}'
    WHEN lookup_key = 'gpt-5.4-mini' THEN '{"input":0.75,"output":4.5,"cache_read":0.075}'
    WHEN lookup_key = 'gpt-5.4-nano' THEN '{"input":0.2,"output":1.25,"cache_read":0.02}'
    WHEN lookup_key = 'gpt-5.4' THEN '{"input":2.5,"output":15,"cache_read":0.25}'
    WHEN lookup_key IN ('gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3', 'gpt-5.3-codex')
      THEN '{"input":1.75,"output":14,"cache_read":0.175}'
    WHEN lookup_key = 'gpt-5.1-codex-mini' THEN '{"input":0.25,"output":2,"cache_read":0.025}'
    WHEN lookup_key LIKE 'gpt-5.1%' THEN '{"input":1.25,"output":10,"cache_read":0.125}'
    WHEN lookup_key = 'gpt-5-mini' THEN '{"input":0.25,"output":2,"cache_read":0.025}'

    -- GPT-4 family
    WHEN lookup_key = 'gpt-41-copilot' THEN '{"input":2,"output":8,"cache_read":0.5}'
    WHEN lookup_key LIKE 'gpt-4.1%' THEN '{"input":2,"output":8,"cache_read":0.5}'
    WHEN lookup_key = 'gpt-4o-preview' OR lookup_key = 'gpt-4-o-preview'
      THEN '{"input":2.5,"output":10,"cache_read":1.25}'
    WHEN lookup_key LIKE 'gpt-4o-mini%' THEN '{"input":0.15,"output":0.6,"cache_read":0.075}'
    WHEN lookup_key = 'gpt-4o' OR lookup_key GLOB 'gpt-4o-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      THEN '{"input":2.5,"output":10,"cache_read":1.25}'
    WHEN lookup_key = 'gpt-4' OR lookup_key = 'gpt-4-0613' THEN '{"input":30,"output":60}'
    WHEN lookup_key = 'gpt-4-0125-preview' THEN '{"input":10,"output":30}'

    -- GPT-3.5
    WHEN lookup_key = 'gpt-3.5-turbo' THEN '{"input":0.5,"output":1.5}'
    WHEN lookup_key = 'gpt-3.5-turbo-0613' THEN '{"input":1.5,"output":2}'

    -- Gemini family
    WHEN lookup_key = 'gemini-2.5-pro' THEN '{"input":1.25,"output":10,"cache_read":0.125}'
    WHEN lookup_key = 'gemini-3-flash-preview' THEN '{"input":0.5,"output":3,"cache_read":0.05}'
    WHEN lookup_key = 'gemini-3.1-pro-preview' THEN '{"input":2,"output":12,"cache_read":0.2}'
    WHEN lookup_key = 'gemini-3.5-flash' THEN '{"input":1.5,"output":9,"cache_read":0.15}'

    -- Other Copilot-table entries
    WHEN lookup_key LIKE 'grok-code-fast%' THEN '{"input":0.2,"output":1.5}'
    WHEN lookup_key = 'goldeneye' THEN '{"input":1.25,"output":10,"cache_read":0.125}'
    WHEN lookup_key = 'raptor-mini' THEN '{"input":0.25,"output":2,"cache_read":0.025}'
    WHEN lookup_key = 'minimax-m2.5' THEN '{"input":0.3,"output":1.2}'
    WHEN lookup_key LIKE 'text-embedding-3-small%' THEN '{"input":0.02,"output":0}'
    WHEN lookup_key = 'text-embedding-ada-002' THEN '{"input":0.1,"output":0}'

    ELSE NULL
  END
  FROM __usage_lookup_key WHERE __usage_lookup_key.rowid = usage.rowid
)
WHERE upstream IS NULL
   OR upstream IN (SELECT id FROM upstreams WHERE provider = 'copilot');

DROP TABLE __usage_lookup_key;
