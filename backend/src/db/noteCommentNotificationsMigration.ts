import type { Migration } from "./migrations.impl.js";

export const noteCommentNotificationsMigration: Migration = {
  version: 116,
  name: "note-comment-notifications",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(notifications)").all() as { name: string; notnull: number }[];
    // 个人笔记没有工作区，放宽通知作用域，同时完整保留已有议题通知及已读状态。
    if (columns.find((column) => column.name === "workspaceId")?.notnull) {
      db.exec(`
        CREATE TABLE notifications_v116 (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          actorUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
          resourceType TEXT NOT NULL,
          resourceId TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          readAt TEXT,
          createdAt TEXT NOT NULL
        );
        INSERT INTO notifications_v116 SELECT * FROM notifications;
        DROP TABLE notifications;
        ALTER TABLE notifications_v116 RENAME TO notifications;
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications(userId, readAt, createdAt DESC, id);
      CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspaceId, resourceType, resourceId);
      CREATE INDEX IF NOT EXISTS idx_notifications_resource ON notifications(resourceType, resourceId);
    `);
  },
};
