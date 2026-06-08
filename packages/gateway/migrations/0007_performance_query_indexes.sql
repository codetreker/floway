CREATE INDEX idx_performance_summary_scope_hour
  ON performance_summary (metric_scope, hour);

CREATE INDEX idx_performance_summary_key_scope_hour
  ON performance_summary (key_id, metric_scope, hour);

CREATE INDEX idx_performance_latency_buckets_scope_hour
  ON performance_latency_buckets (metric_scope, hour);

CREATE INDEX idx_performance_latency_buckets_key_scope_hour
  ON performance_latency_buckets (key_id, metric_scope, hour);
