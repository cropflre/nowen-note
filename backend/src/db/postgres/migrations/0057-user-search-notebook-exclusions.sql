CREATE TABLE IF NOT EXISTS user_search_notebook_exclusions (
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "notebookId" TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  "includeDescendants" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("userId", "notebookId")
);

CREATE INDEX IF NOT EXISTS idx_user_search_notebook_exclusions_user
  ON user_search_notebook_exclusions("userId", "notebookId");
CREATE INDEX IF NOT EXISTS idx_user_search_notebook_exclusions_notebook
  ON user_search_notebook_exclusions("notebookId", "userId");
