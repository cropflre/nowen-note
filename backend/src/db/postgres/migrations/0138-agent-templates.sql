-- Metadata parity; SQLite remains the Agent runtime.
CREATE TABLE IF NOT EXISTS agent_templates (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "workspaceId" TEXT, name TEXT NOT NULL, "configJson" TEXT NOT NULL, revision TEXT NOT NULL,
      "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_templates_owner ON agent_templates("userId","workspaceId");
    CREATE TABLE IF NOT EXISTS agent_mcp_connections (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, url TEXT NOT NULL, "allowedTools" TEXT NOT NULL,
      "secretJson" TEXT, "toolsJson" TEXT NOT NULL DEFAULT '[]', revision TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_extension_receipts (
      "runId" TEXT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
      "callIndex" INTEGER NOT NULL, "toolId" TEXT NOT NULL, status TEXT NOT NULL,
      "argumentDigest" TEXT NOT NULL, "createdAt" TEXT NOT NULL, PRIMARY KEY("runId","callIndex")
    );
    CREATE TABLE IF NOT EXISTS agent_trigger_runs (
      "automationRunId" TEXT PRIMARY KEY REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
      "agentRunId" TEXT NOT NULL UNIQUE REFERENCES agent_workflows(id) ON DELETE CASCADE,
      "templateId" TEXT NOT NULL
    );
