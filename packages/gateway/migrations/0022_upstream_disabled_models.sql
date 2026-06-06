-- Per-upstream public-model disable list. A top-level column parallel to
-- flag_overrides (uniform across all provider kinds), holding a JSON array of
-- public model ids the operator has switched off. Existing rows backfill to the
-- empty array via the column DEFAULT.
--
-- As with flag_overrides (migration 0013), every runtime INSERT supplies this
-- column explicitly (see src/repo/d1.ts) and the strict runtime parser rejects
-- non-array shapes at read time, so the DEFAULT only serves the ALTER backfill.
ALTER TABLE upstreams ADD COLUMN disabled_public_model_ids TEXT NOT NULL DEFAULT '[]';
