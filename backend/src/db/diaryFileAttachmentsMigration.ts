import type { Migration } from "./migrations.impl.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";

/**
 * v147：说说支持任意文件附件（Issue #928）。
 *
 * - diaries.attachments：与 images / media 平行的 JSON 数组
 *   `[{ id, filename, mimeType, size }]`，不占 9 图 / 1 视频额度；
 * - diary_attachments.kind：上传用途，'media'（图片/视频，历史行默认值）或 'file'；
 * - diary_attachments.filename：文件附件的原始文件名（历史媒体行为 NULL）；
 * - 重建说说同步触发器，让 Outbox 载荷携带 attachments。
 */
export const DIARY_FILE_ATTACHMENTS_SCHEMA_VERSION = 147;

export const diaryFileAttachmentsMigration: Migration = {
  version: DIARY_FILE_ATTACHMENTS_SCHEMA_VERSION,
  name: "diary-file-attachments",
  up: (db) => {
    const hasColumn = (table: string, column: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .some((entry) => entry.name === column);
    if (!hasColumn("diaries", "attachments")) {
      db.prepare("ALTER TABLE diaries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'").run();
    }
    if (!hasColumn("diary_attachments", "kind")) {
      db.prepare("ALTER TABLE diary_attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'media'").run();
    }
    if (!hasColumn("diary_attachments", "filename")) {
      db.prepare("ALTER TABLE diary_attachments ADD COLUMN filename TEXT").run();
    }
    installSyncPersonalEntitiesTriggers(db);
  },
};
