import type { Migration } from "./migrations.impl.js";

export const automationPlatformMigration: Migration = {
  version: 95,
  name: "nowen-extension-platform-v1-2-automation",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        apiVersion INTEGER NOT NULL DEFAULT 1,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        source TEXT NOT NULL,
        sourceId TEXT,
        correlationId TEXT NOT NULL,
        causationId TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        batchId TEXT,
        replayedFrom TEXT,
        payloadJson TEXT NOT NULL DEFAULT '{}',
        dispatchState TEXT NOT NULL DEFAULT 'pending',
        lockedBy TEXT,
        lockedAt TEXT,
        dispatchedAt TEXT,
        occurredAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_events_dispatch ON automation_events(dispatchState, occurredAt);
      CREATE INDEX IF NOT EXISTS idx_automation_events_type_time ON automation_events(type, occurredAt DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_events_workspace_time ON automation_events(workspaceId, occurredAt DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_events_resource ON automation_events(resourceType, resourceId);

      CREATE TABLE IF NOT EXISTS automation_workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        userId TEXT NOT NULL,
        workspaceId TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        triggerType TEXT NOT NULL,
        triggerConfigJson TEXT NOT NULL,
        definitionJson TEXT NOT NULL,
        ignoreSync INTEGER NOT NULL DEFAULT 1,
        ignoreBulk INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_workflows_trigger ON automation_workflows(enabled, triggerType);
      CREATE INDEX IF NOT EXISTS idx_automation_workflows_owner ON automation_workflows(userId, workspaceId);

      CREATE TABLE IF NOT EXISTS automation_workflow_runs (
        id TEXT PRIMARY KEY,
        workflowId TEXT NOT NULL,
        eventId TEXT,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        status TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT,
        resumeAt TEXT,
        currentStep INTEGER NOT NULL DEFAULT 0,
        errorCode TEXT,
        errorMessage TEXT,
        correlationId TEXT NOT NULL,
        requiresAttention INTEGER NOT NULL DEFAULT 0,
        lockedBy TEXT,
        lockedAt TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (workflowId) REFERENCES automation_workflows(id) ON DELETE CASCADE,
        FOREIGN KEY (eventId) REFERENCES automation_events(id) ON DELETE SET NULL,
        UNIQUE (workflowId, eventId)
      );
      CREATE INDEX IF NOT EXISTS idx_automation_runs_claim ON automation_workflow_runs(status, resumeAt, createdAt);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_workflow ON automation_workflow_runs(workflowId, createdAt DESC);

      CREATE TABLE IF NOT EXISTS automation_workflow_steps (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        stepId TEXT NOT NULL,
        stepType TEXT NOT NULL,
        pluginId TEXT,
        actionId TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        maxAttempts INTEGER NOT NULL DEFAULT 1,
        idempotencyKey TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT,
        inputJson TEXT,
        outputPreview TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        FOREIGN KEY (runId) REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
        UNIQUE (runId, stepId)
      );
      CREATE INDEX IF NOT EXISTS idx_automation_steps_run ON automation_workflow_steps(runId, startedAt);

      CREATE TABLE IF NOT EXISTS automation_schedules (
        workflowId TEXT PRIMARY KEY,
        cronExpression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        nextRunAt TEXT NOT NULL,
        lastRunAt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        lockedBy TEXT,
        lockedAt TEXT,
        FOREIGN KEY (workflowId) REFERENCES automation_workflows(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_automation_schedules_due ON automation_schedules(enabled, nextRunAt);

      CREATE TABLE IF NOT EXISTS automation_webhooks (
        workflowId TEXT PRIMARY KEY,
        tokenHash TEXT NOT NULL UNIQUE,
        secretEncrypted TEXT,
        secretIv TEXT,
        secretTag TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        requestsInWindow INTEGER NOT NULL DEFAULT 0,
        windowStartedAt TEXT,
        lastTriggeredAt TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (workflowId) REFERENCES automation_workflows(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS automation_idempotency (
        idempotencyKey TEXT NOT NULL,
        operation TEXT NOT NULL,
        resultJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (idempotencyKey, operation)
      );
    `);
  },
};
