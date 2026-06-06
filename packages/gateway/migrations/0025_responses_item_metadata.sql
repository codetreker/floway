ALTER TABLE responses_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'upstream' CHECK (origin IN ('input', 'upstream', 'synthetic'));
ALTER TABLE responses_items ADD COLUMN refreshed_at INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_responses_items_refreshed_at_default
AFTER INSERT ON responses_items
WHEN NEW.refreshed_at = 0
BEGIN
  UPDATE responses_items
  SET refreshed_at = NEW.created_at
  WHERE rowid = NEW.rowid;
END;

UPDATE responses_items SET origin = CASE WHEN upstream_id IS NULL THEN 'synthetic' ELSE 'upstream' END;
UPDATE responses_items SET refreshed_at = created_at;

CREATE INDEX idx_responses_items_refreshed_at ON responses_items (refreshed_at);
