import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

type ForeignKeyViolation = {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
};

/**
 * 1.2.x 的部分数据库可能残留已经找不到 users 父记录的登录会话。
 * 会话本身属于可丢弃的认证缓存，不包含用户内容；v59 是历史上首次执行全库
 * foreign_key_check 的迁移，因此这些既有脏记录会让无关的标签迁移反复失败。
 */
function repairLegacyOrphanedUserSessions(db: Database.Database): void {
  const table = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'user_sessions'
  `).get();
  if (!table) return;

  const columns = db.prepare("PRAGMA table_info(user_sessions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "userId")) return;

  const result = db.prepare(`
    DELETE FROM user_sessions
    WHERE NOT EXISTS (
      SELECT 1 FROM users WHERE users.id = user_sessions.userId
    )
  `).run();

  if (result.changes > 0) {
    console.warn(
      `[migrations:v59] removed ${result.changes} orphaned legacy user session(s)`,
    );
  }
}

/**
 * v59: 标签名称从“账号全局唯一”调整为真正的空间唯一。
 *
 * 最终规则：
 * - 个人空间：userId + normalizedName 唯一；
 * - 工作区：workspaceId + normalizedName 唯一，创建者 userId 不参与唯一性。
 *
 * 历史库可能已存在大小写/空格差异的重复标签，或同一工作区由不同成员创建
 * 的同名标签。迁移保留最早创建的记录，并把 note_tags 关系合并到该记录。
 */
export const tagScopeUniquenessMigration: Migration = {
  version: 59,
  name: "tag-scope-unique-names",
  up: (db: Database.Database) => {
    repairLegacyOrphanedUserSessions(db);

    db.exec(`
      CREATE TABLE tags_v59 (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#58a6ff',
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        workspaceId TEXT,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );

      INSERT INTO tags_v59 (id, userId, name, color, createdAt, workspaceId)
      SELECT
        t.id,
        t.userId,
        trim(t.name),
        t.color,
        t.createdAt,
        t.workspaceId
      FROM tags t
      WHERE t.id = (
        SELECT t2.id
        FROM tags t2
        WHERE lower(trim(t2.name)) = lower(trim(t.name))
          AND (
            (
              t.workspaceId IS NULL
              AND t2.workspaceId IS NULL
              AND t2.userId = t.userId
            )
            OR (
              t.workspaceId IS NOT NULL
              AND t2.workspaceId = t.workspaceId
            )
          )
        ORDER BY t2.createdAt ASC, t2.id ASC
        LIMIT 1
      );

      CREATE TABLE note_tags_v59 (
        noteId TEXT NOT NULL,
        tagId TEXT NOT NULL,
        PRIMARY KEY (noteId, tagId),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (tagId) REFERENCES tags_v59(id) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO note_tags_v59 (noteId, tagId)
      SELECT
        nt.noteId,
        (
          SELECT t2.id
          FROM tags t2
          WHERE lower(trim(t2.name)) = lower(trim(t.name))
            AND (
              (
                t.workspaceId IS NULL
                AND t2.workspaceId IS NULL
                AND t2.userId = t.userId
              )
              OR (
                t.workspaceId IS NOT NULL
                AND t2.workspaceId = t.workspaceId
              )
            )
          ORDER BY t2.createdAt ASC, t2.id ASC
          LIMIT 1
        ) AS canonicalTagId
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tagId;

      DROP TABLE note_tags;
      DROP TABLE tags;
      ALTER TABLE tags_v59 RENAME TO tags;
      ALTER TABLE note_tags_v59 RENAME TO note_tags;

      CREATE INDEX IF NOT EXISTS idx_tags_workspace
        ON tags(workspaceId);
      CREATE INDEX IF NOT EXISTS idx_tags_user_workspace
        ON tags(userId, workspaceId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_personal_name_unique
        ON tags(userId, lower(trim(name)))
        WHERE workspaceId IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_workspace_name_unique
        ON tags(workspaceId, lower(trim(name)))
        WHERE workspaceId IS NOT NULL;
    `);

    // 这里只验证本迁移重建的表。旧库其他表已有的外键问题不能被误报成 v59 失败，
    // 否则 Docker restart policy 会把一次可恢复的数据兼容问题放大成无限重启。
    const fkErrors = db.prepare("PRAGMA foreign_key_check").all() as ForeignKeyViolation[];
    const migrationFkErrors = fkErrors.filter(
      (error) => error.table === "tags" || error.table === "note_tags",
    );
    if (migrationFkErrors.length > 0) {
      throw new Error(
        `tag scope migration foreign key check failed: ${JSON.stringify(migrationFkErrors)}`,
      );
    }
  },
};
