-- NULL = inherit global upstream order; non-NULL JSON array = whitelist + priority order.
-- Upstream deletes do not cascade here; stale ids are dropped on the next write to the key.

ALTER TABLE api_keys ADD COLUMN upstream_ids TEXT;
