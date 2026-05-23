CREATE TABLE account_model_backoffs (
  account_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, model)
);

CREATE INDEX idx_account_model_backoffs_expires_at ON account_model_backoffs (expires_at);

INSERT INTO config (key, value)
SELECT 'github_account_order', (
  SELECT json_group_array(user_id)
  FROM (
    SELECT user_id
    FROM github_accounts
    ORDER BY
      CASE
        WHEN user_id = CAST((SELECT value FROM config WHERE key = 'active_github_account') AS INTEGER) THEN 0
        ELSE 1
      END,
      user_id
  )
)
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'github_account_order')
  AND EXISTS (SELECT 1 FROM github_accounts);

-- Keep the deprecated active_github_account key for migration-before-deploy
-- rollouts. New code ignores it, but old Worker versions still need it until
-- the new bundle is live everywhere.
