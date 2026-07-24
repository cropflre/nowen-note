import type Database from "better-sqlite3";

export interface ScopedTagRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string;
  createdAt: string;
}

export interface EnsureScopedTagInput {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string;
}

export interface EnsureScopedTagResult {
  tag: ScopedTagRecord;
  created: boolean;
}

export function normalizeTagName(raw: unknown): string {
  return String(raw ?? "").trim();
}

/**
 * 标签作用域：
 * - 个人空间：同一 userId 内名称唯一；
 * - 工作区：同一 workspaceId 内名称唯一，创建者 userId 不参与查重。
 *
 * 名称查找与数据库唯一索引保持一致，使用 trim + lower 处理前后空格和
 * ASCII 大小写差异，避免 React/react 被当成两个标签。
 */
export function findTagByScopedName(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  name: string,
): ScopedTagRecord | undefined {
  const normalizedName = normalizeTagName(name);
  if (!normalizedName) return undefined;

  if (workspaceId) {
    return db.prepare(`
      SELECT id, userId, workspaceId, name, color, createdAt
      FROM tags
      WHERE workspaceId = ?
        AND lower(trim(name)) = lower(?)
      ORDER BY createdAt ASC, id ASC
      LIMIT 1
    `).get(workspaceId, normalizedName) as ScopedTagRecord | undefined;
  }

  return db.prepare(`
    SELECT id, userId, workspaceId, name, color, createdAt
    FROM tags
    WHERE userId = ?
      AND workspaceId IS NULL
      AND lower(trim(name)) = lower(?)
    ORDER BY createdAt ASC, id ASC
    LIMIT 1
  `).get(userId, normalizedName) as ScopedTagRecord | undefined;
}

export function isTagUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT/i.test(message);
}

/**
 * 幂等创建标签。
 *
 * 先查再插用于常规路径；唯一索引负责并发兜底。若两个请求同时创建同名标签，
 * 后到请求捕获唯一冲突后重新查询并复用已创建记录，而不是向用户暴露 409。
 */
export function ensureScopedTag(
  db: Database.Database,
  input: EnsureScopedTagInput,
): EnsureScopedTagResult {
  const name = normalizeTagName(input.name);
  const existing = findTagByScopedName(db, input.userId, input.workspaceId, name);
  if (existing) return { tag: existing, created: false };

  try {
    db.prepare(`
      INSERT INTO tags (id, userId, workspaceId, name, color)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.userId, input.workspaceId, name, input.color);
  } catch (error) {
    if (isTagUniqueConstraintError(error)) {
      const raced = findTagByScopedName(db, input.userId, input.workspaceId, name);
      if (raced) return { tag: raced, created: false };
    }
    throw error;
  }

  const created = db.prepare(`
    SELECT id, userId, workspaceId, name, color, createdAt
    FROM tags
    WHERE id = ?
  `).get(input.id) as ScopedTagRecord | undefined;

  if (!created) {
    throw new Error("标签创建后未能读取记录");
  }
  return { tag: created, created: true };
}
