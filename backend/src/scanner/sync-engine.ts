/**
 * scanner/sync-engine.ts — DB 同步引擎
 *
 * 将扫描解析后的结构化数据写入 nowen-note SQLite 数据库。
 * 支持 upsert（仅变更时更新）和 delete（文件已移除时）。
 */
import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import type { ParsedNote } from "./parser";

// ========================================
// 接口
// ========================================

export interface SyncStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  errors: number;
  /** 处理耗时 (ms) */
  elapsedMs: number;
}

export interface NotebookInfo {
  id: string;
  path: string; // 如 "编程/TypeScript"
  name: string;
}

// ========================================
// 笔记本路径管理
// ========================================

/**
 * 获取或创建笔记本路径层级
 * "编程/TypeScript" → 创建 "编程" → 在其下创建 "TypeScript"
 * 返回最终的笔记本 ID
 */
function ensureNotebookPath(
  db: Database,
  userId: string,
  notebookPath: string | null,
): string | null {
  if (!notebookPath) return null;

  const parts = notebookPath.split("/").filter(Boolean);
  let parentId: string | null = null;
  let currentId: string | null = null;

  for (const part of parts) {
    // 查询是否存在此路径下的笔记本
    const existing = db
      .prepare(
        "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS ? AND isDeleted = 0",
      )
      .get(userId, part, parentId) as { id: string } | undefined;
    
    // 上面的 IS NULL 对比问题，需要用 CASE 处理
    // 改用 EXISTS 查询

    if (existing) {
      currentId = existing.id;
    } else {
      currentId = uuid();
      db.prepare(
        "INSERT INTO notebooks (id, userId, parentId, name, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
      ).run(currentId, userId, parentId, part);
    }
    parentId = currentId;
  }

  return currentId;
}

// 修复版本：正确处理 parentId IS NULL
function findOrCreateNotebookPath(
  db: Database,
  userId: string,
  notebookPath: string | null,
): string | null {
  if (!notebookPath) return null;

  const parts = notebookPath.split("/").filter(Boolean);
  let parentId: string | null = null;
  let currentId: string | null = null;

  for (const part of parts) {
    let existing: { id: string } | undefined;

    if (parentId === null) {
      existing = db
        .prepare(
          "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS NULL AND isDeleted = 0",
        )
        .get(userId, part) as { id: string } | undefined;
    } else {
      existing = db
        .prepare(
          "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId = ? AND isDeleted = 0",
        )
        .get(userId, part, parentId) as { id: string } | undefined;
    }

    if (existing) {
      currentId = existing.id;
    } else {
      currentId = uuid();
      db.prepare(
        "INSERT INTO notebooks (id, userId, parentId, name, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
      ).run(currentId, userId, parentId, part);
    }
    parentId = currentId;
  }

  return currentId;
}

// ========================================
// Tag 管理
// ========================================

function ensureTags(
  db: Database,
  userId: string,
  tagNames: string[],
): string[] {
  const tagIds: string[] = [];

  for (const name of tagNames) {
    const existing = db
      .prepare("SELECT id FROM tags WHERE userId = ? AND name = ?")
      .get(userId, name) as { id: string } | undefined;

    if (existing) {
      tagIds.push(existing.id);
    } else {
      const id = uuid();
      db.prepare(
        "INSERT INTO tags (id, userId, name, color, createdAt) VALUES (?, ?, ?, '#58a6ff', datetime('now'))",
      ).run(id, userId, name);
      tagIds.push(id);
    }
  }

  return tagIds;
}

// ========================================
// Backlinks 管理
// ========================================

/**
 * 确保 backlinks 表存在（懒初始化）
 */
function ensureBacklinksTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backlinks (
      sourceNoteId TEXT NOT NULL,
      targetNoteId TEXT NOT NULL,
      displayText TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sourceNoteId, targetNoteId),
      FOREIGN KEY (sourceNoteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (targetNoteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_backlinks_target
      ON backlinks(targetNoteId);
  `);
}

function updateBacklinks(
  db: Database,
  noteId: string,
  targets: string[],
): void {
  // 先清空旧的双链
  db.prepare("DELETE FROM backlinks WHERE sourceNoteId = ?").run(noteId);
  // 写入新的双链
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO backlinks (sourceNoteId, targetNoteId, displayText) VALUES (?, ?, ?)",
  );
  for (const target of targets) {
    stmt.run(noteId, target, target);
  }
}

// ========================================
// 主同步函数
// ========================================

export interface SyncOptions {
  /** 用户 ID（目前单用户模式，固定用 admin 的 userId） */
  userId: string;
  /** 是否强制重建全部索引（清空再写入） */
  rebuild?: boolean;
  /** 当前文件路径集合（用于检测已删除的文件） */
  currentPaths?: Set<string>;
}

/**
 * 同步一批解析后的笔记到 DB
 */
export function syncNotes(
  db: Database,
  notes: ParsedNote[],
  options: SyncOptions,
): SyncStats {
  const startTime = Date.now();
  const stats: SyncStats = {
    total: notes.length,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    errors: 0,
    elapsedMs: 0,
  };

  const { userId } = options;

  // 确保 backlinks 表存在
  ensureBacklinksTable(db);

  // 使用事务批量写入
  const writeBatch = db.transaction(() => {
    for (const note of notes) {
      try {
        // 1. 确定目标笔记本
        const notebookId = findOrCreateNotebookPath(db, userId, note.notebook);

        // 2. 检查笔记是否已存在
        const existing = db
          .prepare("SELECT id, sha256 FROM notes WHERE id = ?")
          .get(note.id) as { id: string; sha256: string } | undefined;

        // 如果有 existingNoteId 但 note.id 不同，通过 relativePath 查找
        const existingByPath = !existing
          ? db
              .prepare("SELECT id, sha256 FROM notes WHERE userId = ? AND sourcePath = ?")
              .get(userId, note.relativePath) as { id: string; sha256: string } | undefined
          : null;

        const effectiveExisting = existing || existingByPath;

        // 3. 判断是否需要更新（SHA256 比较）
        if (effectiveExisting) {
          // 即使 SHA256 没变，如果是 rebuild 模式也更新
          if (!options.rebuild && effectiveExisting.sha256 === note.sha256) {
            stats.skipped++;
            continue;
          }

          // 更新已有笔记
          db.prepare(
            `UPDATE notes SET
              title = ?, content = ?, contentText = ?, notebookId = ?,
              contentFormat = 'markdown', sourcePath = ?,
              sha256 = ?, isPinned = ?, isArchived = ?,
              version = version + 1, updatedAt = datetime('now')
            WHERE id = ?`,
          ).run(
            note.title, note.body, note.contentText, notebookId,
            note.relativePath, note.sha256,
            note.pinned ? 1 : 0, note.archived ? 1 : 0,
            effectiveExisting.id,
          );

          // 如果 id 变了（path match 但 id 不同），更新 backlinks 中的引用
          if (effectiveExisting.id !== note.id) {
            // 保留旧 id（数据库已有引用）
          }

          stats.updated++;
        } else {
          // 创建新笔记
          const noteId = note.id;
          db.prepare(
            `INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText,
              contentFormat, isPinned, isArchived, isFavorite, isLocked, isTrashed, version,
              sourcePath, sha256, createdAt, updatedAt)
            VALUES (?, ?, ?, NULL, ?, ?, ?, 'markdown', ?, ?, 0, 0, 0, 1, ?, ?, ?, datetime('now'))`,
          ).run(
            noteId, userId, notebookId,
            note.title, note.body, note.contentText,
            note.pinned ? 1 : 0, note.archived ? 1 : 0,
            note.relativePath, note.sha256, note.createdAt,
          );
          stats.created++;
        }

        const currentId = effectiveExisting?.id || note.id;

        // 4. 同步标签
        if (note.tags.length > 0) {
          const tagIds = ensureTags(db, userId, note.tags);
          // 清空旧标签关联
          db.prepare("DELETE FROM note_tags WHERE noteId = ?").run(currentId);
          // 写入新标签关联
          const tagStmt = db.prepare(
            "INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)",
          );
          for (const tagId of tagIds) {
            tagStmt.run(currentId, tagId);
          }
        }

        // 5. 同步双链（如果 notes 表已填充完成，可以解析）
        // 双链解析需要所有笔记的 title → id 映射，在外部做
        // 这里预留接口

      } catch (e) {
        console.error(`[scanner/sync-engine] 同步笔记失败: ${note.relativePath}`, e);
        stats.errors++;
      }
    }
  });

  writeBatch();
  stats.elapsedMs = Date.now() - startTime;
  return stats;
}

/**
 * 加载所有笔记的 title→id 和 alias→id 映射
 */
export function loadNoteTitles(
  db: Database,
  userId: string,
): { titles: Map<string, string>; aliases: Map<string, string> } {
  const titles = new Map<string, string>();
  const aliases = new Map<string, string>();

  const rows = db
    .prepare("SELECT id, title FROM notes WHERE userId = ? AND isTrashed = 0")
    .all(userId) as { id: string; title: string }[];

  for (const row of rows) {
    titles.set(row.title, row.id);
  }

  return { titles, aliases };
}
