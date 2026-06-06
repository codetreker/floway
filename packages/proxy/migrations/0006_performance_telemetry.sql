CREATE TABLE performance_summary (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  source_api TEXT NOT NULL CHECK (source_api IN ('messages', 'responses', 'chat-completions')),
  target_api TEXT NOT NULL CHECK (target_api IN ('messages', 'responses', 'chat-completions')),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location)
);

CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE performance_latency_buckets (
  hour TEXT NOT NULL,
  metric_scope TEXT NOT NULL CHECK (metric_scope IN ('request_total', 'upstream_success')),
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  source_api TEXT NOT NULL CHECK (source_api IN ('messages', 'responses', 'chat-completions')),
  target_api TEXT NOT NULL CHECK (target_api IN ('messages', 'responses', 'chat-completions')),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  runtime_location TEXT NOT NULL DEFAULT 'unknown',
  lower_ms INTEGER NOT NULL,
  upper_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, lower_ms, upper_ms)
);

CREATE INDEX idx_performance_latency_buckets_hour ON performance_latency_buckets (hour);
