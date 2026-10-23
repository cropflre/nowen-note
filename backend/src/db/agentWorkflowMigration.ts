import type { Migration } from "./migrations.impl.js";

export const agentWorkflowMigration: Migration = {
  version: 137,
  name: "agent-notebook-workflows",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workflows (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notebookId TEXT NOT NULL, workspaceId TEXT, status TEXT NOT NULL, model TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, errorCode TEXT,
      sourceRefs TEXT NOT NULL DEFAULT '[]',
      tokenDigest TEXT, payloadDigest TEXT, expiresAt TEXT, consumedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_workflows_user ON agent_workflows(userId,createdAt);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_workflows_active ON agent_workflows(userId)
      WHERE status IN ('queued','running','waiting_approval','applying');
    CREATE TABLE IF NOT EXISTS agent_workflow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
      toolName TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_workflow_actions (
      runId TEXT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, status TEXT NOT NULL, resourceIds TEXT NOT NULL DEFAULT '[]', errorCode TEXT,
      PRIMARY KEY(runId,kind)
    );`);
  },
};
