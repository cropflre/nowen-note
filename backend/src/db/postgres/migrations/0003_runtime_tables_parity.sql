-- Tables that were historically created lazily by SQLite routes/services or
-- added to the SQLite baseline after the first PostgreSQL schema draft.

CREATE TABLE IF NOT EXISTS user_preferences (
  "userId" TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  "preferencesJson" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'check-circle',
  color TEXT NOT NULL DEFAULT '#10b981',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS habit_checkins (
  id TEXT PRIMARY KEY,
  "habitId" TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "checkinDate" DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failure')),
  note TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("habitId", "checkinDate")
);

CREATE INDEX IF NOT EXISTS idx_habits_user_ws_archived_sort
  ON habits("userId", "workspaceId", "archivedAt", "sortOrder");
CREATE INDEX IF NOT EXISTS idx_habits_workspace_archived_sort
  ON habits("workspaceId", "archivedAt", "sortOrder");
CREATE INDEX IF NOT EXISTS idx_habit_checkins_habit_date
  ON habit_checkins("habitId", "checkinDate");
CREATE INDEX IF NOT EXISTS idx_habit_checkins_user_date
  ON habit_checkins("userId", "checkinDate");
CREATE INDEX IF NOT EXISTS idx_habit_checkins_workspace_date
  ON habit_checkins("workspaceId", "checkinDate");

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  "targetType" TEXT DEFAULT '',
  "targetId" TEXT DEFAULT '',
  details TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  "userAgent" TEXT DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs("userId");
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs("targetType", "targetId");

CREATE TABLE IF NOT EXISTS mindmaps (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT,
  "folderId" TEXT,
  title TEXT NOT NULL DEFAULT '无标题导图',
  data TEXT NOT NULL DEFAULT '{}',
  starred BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mindmaps_user ON mindmaps("userId");
CREATE INDEX IF NOT EXISTS idx_mindmaps_updated ON mindmaps("updatedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_mindmaps_workspace ON mindmaps("workspaceId");
CREATE INDEX IF NOT EXISTS idx_mindmaps_folder ON mindmaps("folderId");

CREATE TABLE IF NOT EXISTS notebook_acl_overrides (
  "notebookId" TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('none', 'read', 'comment', 'write', 'manage')),
  "allowDownload" BOOLEAN NOT NULL DEFAULT true,
  "allowReshare" BOOLEAN NOT NULL DEFAULT false,
  "createdBy" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("notebookId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_notebook_acl_user
  ON notebook_acl_overrides("userId", "notebookId");

CREATE TABLE IF NOT EXISTS notebook_publications (
  id TEXT PRIMARY KEY,
  "notebookId" TEXT NOT NULL UNIQUE REFERENCES notebooks(id) ON DELETE CASCADE,
  "ownerId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  "accessMode" TEXT NOT NULL DEFAULT 'link'
    CHECK ("accessMode" IN ('public', 'link', 'code', 'password')),
  "accessSecret" TEXT,
  permission TEXT NOT NULL DEFAULT 'read'
    CHECK (permission IN ('read', 'comment', 'write')),
  "allowDownload" BOOLEAN NOT NULL DEFAULT true,
  "allowComment" BOOLEAN NOT NULL DEFAULT false,
  "allowEdit" BOOLEAN NOT NULL DEFAULT false,
  "allowReshare" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMPTZ,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notebook_publications_public
  ON notebook_publications("accessMode", "isActive", "updatedAt");

CREATE TABLE IF NOT EXISTS notebook_public_comments (
  id TEXT PRIMARY KEY,
  "publicationId" TEXT NOT NULL REFERENCES notebook_publications(id) ON DELETE CASCADE,
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  content TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notebook_public_comments_note
  ON notebook_public_comments("publicationId", "noteId", "createdAt");

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '["*"]',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  description TEXT DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  "webhookId" TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  "responseStatus" INTEGER,
  "responseBody" TEXT DEFAULT '',
  success BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0,
  "deliveredAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks("userId");
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries("webhookId");
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_time ON webhook_deliveries("deliveredAt" DESC);
