/**
 * AI Custom Prompts Repository
 *
 * 职责：
 * - 封装 ai_custom_prompts 表的数据库操作
 * - 提供类型安全的接口
 * - 同一套 async API 支持 SQLite 与 PostgreSQL
 *
 * 注意：
 * - 同步方法仅用于现有 SQLite 调用链；
 * - PostgreSQL 运行时必须调用 async 方法。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";

function getAdapter() {
  return getDatabaseAdapter();
}

/** AI 自定义 Prompt 记录 */
export interface AiCustomPromptRecord {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const aiCustomPromptsRepository = {
  listByUser(userId: string): AiCustomPromptRecord[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, userId, name, prompt, usageCount, lastUsedAt, createdAt, updatedAt
         FROM ai_custom_prompts
         WHERE userId = ?
         ORDER BY usageCount DESC, updatedAt DESC, createdAt DESC
         LIMIT 200`,
      )
      .all(userId) as AiCustomPromptRecord[];
  },

  getByIdAndUser(id: string, userId: string): AiCustomPromptRecord | undefined {
    const db = getDb();
    return db
      .prepare(
        "SELECT id, userId, name, prompt, usageCount, lastUsedAt, createdAt, updatedAt FROM ai_custom_prompts WHERE id = ? AND userId = ?",
      )
      .get(id, userId) as AiCustomPromptRecord | undefined;
  },

  create(input: { id: string; userId: string; name: string; prompt: string }): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO ai_custom_prompts (id, userId, name, prompt, usageCount, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
    ).run(input.id, input.userId, input.name, input.prompt);
  },

  updateByIdAndUser(id: string, userId: string, patch: { name?: string; prompt?: string }): void {
    const db = getDb();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      params.push(patch.name);
    }
    if (patch.prompt !== undefined) {
      updates.push("prompt = ?");
      params.push(patch.prompt);
    }

    if (updates.length === 0) return;

    updates.push("updatedAt = datetime('now')");
    params.push(id, userId);

    db.prepare(`UPDATE ai_custom_prompts SET ${updates.join(", ")} WHERE id = ? AND userId = ?`).run(...params);
  },

  deleteByIdAndUser(id: string, userId: string): boolean {
    const db = getDb();
    const result = db.prepare("DELETE FROM ai_custom_prompts WHERE id = ? AND userId = ?").run(id, userId);
    return result.changes > 0;
  },

  touchUsage(id: string, userId: string): boolean {
    const db = getDb();
    const result = db
      .prepare(
        `UPDATE ai_custom_prompts
         SET usageCount = usageCount + 1,
             lastUsedAt = datetime('now')
         WHERE id = ? AND userId = ?`,
      )
      .run(id, userId);
    return result.changes > 0;
  },

  async listByUserAsync(userId: string): Promise<AiCustomPromptRecord[]> {
    return getAdapter().queryMany<AiCustomPromptRecord>(
      `SELECT id, userId, name, prompt, usageCount, lastUsedAt, createdAt, updatedAt
       FROM ai_custom_prompts
       WHERE userId = ?
       ORDER BY usageCount DESC, updatedAt DESC, createdAt DESC
       LIMIT 200`,
      [userId],
    );
  },

  async getByIdAndUserAsync(id: string, userId: string): Promise<AiCustomPromptRecord | undefined> {
    return getAdapter().queryOne<AiCustomPromptRecord>(
      "SELECT id, userId, name, prompt, usageCount, lastUsedAt, createdAt, updatedAt FROM ai_custom_prompts WHERE id = ? AND userId = ?",
      [id, userId],
    );
  },

  async createAsync(input: { id: string; userId: string; name: string; prompt: string }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO ai_custom_prompts (id, userId, name, prompt, usageCount, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
      [input.id, input.userId, input.name, input.prompt],
    );
  },

  async updateByIdAndUserAsync(id: string, userId: string, patch: { name?: string; prompt?: string }): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      params.push(patch.name);
    }
    if (patch.prompt !== undefined) {
      updates.push("prompt = ?");
      params.push(patch.prompt);
    }

    if (updates.length === 0) return;

    updates.push("updatedAt = datetime('now')");
    params.push(id, userId);

    await getAdapter().execute(
      `UPDATE ai_custom_prompts SET ${updates.join(", ")} WHERE id = ? AND userId = ?`,
      params,
    );
  },

  async deleteByIdAndUserAsync(id: string, userId: string): Promise<boolean> {
    const result = await getAdapter().execute(
      "DELETE FROM ai_custom_prompts WHERE id = ? AND userId = ?",
      [id, userId],
    );
    return result.changes > 0;
  },

  async touchUsageAsync(id: string, userId: string): Promise<boolean> {
    const result = await getAdapter().execute(
      `UPDATE ai_custom_prompts
       SET usageCount = usageCount + 1,
           lastUsedAt = datetime('now')
       WHERE id = ? AND userId = ?`,
      [id, userId],
    );
    return result.changes > 0;
  },
};
