import type { Migration } from "./migrations.impl.js";

/**
 * v151：工作区成员分组（用户组 / 部门）表，支持按组管理成员与目录批量授权。
 */
export const workspaceGroupsMigration: Migration = {
  version: 151,
  name: "workspace-groups",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_groups (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        createdBy TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
        UNIQUE(workspaceId, name)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_groups_ws ON workspace_groups(workspaceId, name);

      CREATE TABLE IF NOT EXISTS workspace_group_members (
        groupId TEXT NOT NULL,
        userId TEXT NOT NULL,
        addedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (groupId, userId),
        FOREIGN KEY (groupId) REFERENCES workspace_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_group_members_user ON workspace_group_members(userId);
    `);
  },
};
