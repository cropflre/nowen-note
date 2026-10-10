import type { Migration } from "./migrations.impl.js";

export const workspaceIssuesMigration: Migration = {
  version: 114,
  name: "workspace-issues-and-notifications",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_issues (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
        createdBy TEXT REFERENCES users(id) ON DELETE SET NULL,
        closedBy TEXT REFERENCES users(id) ON DELETE SET NULL,
        closedAt TEXT,
        relatedNoteId TEXT REFERENCES notes(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(workspaceId, number)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_issues_list
        ON workspace_issues(workspaceId, status, updatedAt DESC, id);
      CREATE TABLE IF NOT EXISTS workspace_issue_comments (
        id TEXT PRIMARY KEY,
        issueId TEXT NOT NULL REFERENCES workspace_issues(id) ON DELETE CASCADE,
        userId TEXT REFERENCES users(id) ON DELETE SET NULL,
        parentId TEXT REFERENCES workspace_issue_comments(id) ON DELETE SET NULL,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_issue_comments_time
        ON workspace_issue_comments(issueId, createdAt, id);
      -- 状态事件独立保存，关闭或重开不会覆盖历史讨论时间线。
      CREATE TABLE IF NOT EXISTS workspace_issue_events (
        id TEXT PRIMARY KEY,
        issueId TEXT NOT NULL REFERENCES workspace_issues(id) ON DELETE CASCADE,
        userId TEXT REFERENCES users(id) ON DELETE SET NULL,
        type TEXT NOT NULL CHECK(type IN ('closed', 'reopened')),
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_issue_events_time
        ON workspace_issue_events(issueId, createdAt, id);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actorUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        readAt TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user_time
        ON notifications(userId, readAt, createdAt DESC, id);
      CREATE INDEX IF NOT EXISTS idx_notifications_workspace
        ON notifications(workspaceId, resourceType, resourceId);
    `);
  },
};
