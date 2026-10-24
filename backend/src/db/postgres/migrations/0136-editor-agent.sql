-- Storage parity only; does not enable the PostgreSQL product runtime.
CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "noteId" TEXT NOT NULL, "workspaceId" TEXT, status TEXT NOT NULL, model TEXT NOT NULL,
      "expectedVersion" INTEGER NOT NULL, "snapshotDigest" TEXT NOT NULL, "serverDigest" TEXT NOT NULL, "resultDigest" TEXT,
      "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, "errorCode" TEXT, usage INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_runs_user ON agent_runs("userId","createdAt");
    CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_active ON agent_runs("userId")
      WHERE status IN ('queued','running','waiting_approval','applying');
    CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY, "runId" TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, "toolName" TEXT NOT NULL, status TEXT NOT NULL,
      "createdAt" TEXT NOT NULL, UNIQUE("runId",sequence)
    );
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY, "runId" TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
      "userId" TEXT NOT NULL, "actionType" TEXT NOT NULL, "noteId" TEXT NOT NULL,
      "payloadDigest" TEXT NOT NULL, "expectedRevision" TEXT NOT NULL,
      "tokenDigest" TEXT NOT NULL, status TEXT NOT NULL, "expiresAt" TEXT NOT NULL, "consumedAt" TEXT
    );
