import type { Migration } from "./migrations.impl.js";

/**
 * v150：为团队任务增加负责人字段 assigneeId 及工作区负责人索引。
 */
export const taskAssigneeMigration: Migration = {
  version: 150,
  name: "task-assignee",
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("assigneeId")) {
      db.exec("ALTER TABLE tasks ADD COLUMN assigneeId TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace_assignee ON tasks(workspaceId, assigneeId)");
  },
};
