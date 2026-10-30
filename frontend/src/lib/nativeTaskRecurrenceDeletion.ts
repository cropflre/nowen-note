export const NATIVE_TASK_DELETION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS task_recurrence_state (
    groupId TEXT NOT NULL, scopeKey TEXT NOT NULL, action TEXT NOT NULL,
    updatedAt TEXT NOT NULL, PRIMARY KEY(groupId,scopeKey)
  )`,
  `CREATE TABLE IF NOT EXISTS task_deletion_tombstones (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, workspaceId TEXT,
    repeatGroupId TEXT, deletedAt TEXT NOT NULL
  )`,
] as const;
