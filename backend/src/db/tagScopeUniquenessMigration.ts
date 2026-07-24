import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

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

    const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (fkErrors.length > 0) {
      throw new Error(`tag scope migration foreign key check failed: ${JSON.stringify(fkErrors)}`);
    }
  },
};
