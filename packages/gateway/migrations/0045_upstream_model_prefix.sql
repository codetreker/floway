-- Per-upstream model name prefix. NULL keeps today's behavior — clients
-- address the upstream's models by bare id only.
ALTER TABLE upstreams ADD COLUMN model_prefix_json TEXT NULL;
