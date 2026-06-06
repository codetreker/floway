CREATE TABLE search_usage (
  provider TEXT NOT NULL CHECK (provider IN ('tavily', 'microsoft-grounding')),
  key_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_id, hour)
);

CREATE INDEX idx_search_usage_hour ON search_usage (hour);
