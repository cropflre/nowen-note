-- AI Plugin Studio 隔离项目、生成记录与短期产物元数据。
BEGIN;

CREATE TABLE IF NOT EXISTS plugin_studio_projects (
  id TEXT PRIMARY KEY,
  "ownerUserId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  UNIQUE("ownerUserId", slug)
);
CREATE INDEX IF NOT EXISTS idx_plugin_studio_projects_owner_updated
  ON plugin_studio_projects("ownerUserId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS plugin_studio_generations (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES plugin_studio_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  "catalogDigest" TEXT,
  model TEXT,
  "inputDigest" TEXT,
  "outputDigest" TEXT,
  "resultSummary" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_studio_generations_project_created
  ON plugin_studio_generations("projectId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS plugin_studio_artifacts (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES plugin_studio_projects(id) ON DELETE CASCADE,
  "generationId" TEXT REFERENCES plugin_studio_generations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  "reportJson" TEXT NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_studio_artifacts_project_created
  ON plugin_studio_artifacts("projectId", "createdAt" DESC);

COMMIT;
