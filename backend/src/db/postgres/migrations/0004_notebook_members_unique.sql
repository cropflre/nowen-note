-- Notebook member upsert requires a stable conflict target on notebookId + userId.
-- Keep this as a versioned migration so existing PostgreSQL pilot databases are
-- upgraded before repository traffic is enabled.

CREATE UNIQUE INDEX IF NOT EXISTS idx_notebook_members_notebook_user
  ON notebook_members("notebookId", "userId");
