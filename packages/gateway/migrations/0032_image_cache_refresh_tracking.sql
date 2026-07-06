-- Track each image-cache entry's last refresh time so the gateway can debounce
-- TTL-only writes. The bounded sliding-TTL refresh fixes Cloudflare KV's
-- per-key 1-write/sec limit (https://developers.cloudflare.com/kv/platform/limits/)
-- when a single request batches dozens of identical inline images, and removes
-- the matching no-op UPDATEs from the Node sqlite path. Existing rows default
-- to 0 so the next read of each pre-existing entry triggers exactly one
-- self-healing UPDATE that stamps a real timestamp; subsequent reads inside
-- the refresh window then skip the write entirely.

ALTER TABLE image_cache ADD COLUMN last_refreshed_at INTEGER NOT NULL DEFAULT 0;
