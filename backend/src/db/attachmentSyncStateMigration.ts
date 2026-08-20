import type { Migration } from "./migrations.impl.js";

/**
 * v83: 附件 Local-first 同步状态（Phase 9）。
 *
 * 目标：图片和附件不再依赖"远端上传成功"才能存在。
 *
 *   选择图片 → 立即存本地 → 生成 attachmentId → 笔记引用 → 立即显示
 *                                              ↓
 *                                        Outbox → 后台上传
 *
 * 断网时图片继续正常显示；重开应用图片仍在。
 * 远端上传失败只影响"同步"，不影响本地阅读。
 *
 * 为什么单独建表而不在 attachments 上加列：
 * attachments 是所有部署形态（Web / Docker / NAS / Desktop）共用的核心表，
 * 而同步状态只对开启了 Sync V2 的客户端有意义。
 * 分表可以让未启用同步的部署完全不受影响，也避免给热表增加写入负担。
 */
export const attachmentSyncStateMigration: Migration = {
  version: 83,
  name: "attachment-local-first-sync-state",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_sync_state (
        attachmentId TEXT PRIMARY KEY,
        profileId TEXT,
        -- local:     仅存在于本机，尚未纳入同步
        -- pending:   等待上传
        -- uploading: 正在上传
        -- synced:    远端已确认
        -- failed:    上传失败，保留重试
        status TEXT NOT NULL DEFAULT 'local' CHECK (
          status IN ('local', 'pending', 'uploading', 'synced', 'failed')
        ),
        -- 远端存在但本地二进制还没下载完时为 1，
        -- 供 UI 显示"正在获取图片"而不是显示破图。
        remoteOnly INTEGER NOT NULL DEFAULT 0,
        retryCount INTEGER NOT NULL DEFAULT 0,
        lastAttemptAt TEXT,
        lastError TEXT,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_sync_status
        ON attachment_sync_state(status, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_attachment_sync_profile
        ON attachment_sync_state(profileId, status);
      CREATE INDEX IF NOT EXISTS idx_attachment_sync_remote_only
        ON attachment_sync_state(remoteOnly);
    `);
  },
};
