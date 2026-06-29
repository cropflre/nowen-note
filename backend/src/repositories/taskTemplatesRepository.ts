/**
 * Task Templates Repository
 *
 * 职责：
 * - 封装 task_templates 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

/** task_templates 记录 */
export interface TaskTemplateRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  items: string; // JSON 字符串
  createdAt: string;
  updatedAt: string;
}

export const taskTemplatesRepository = {
  /**
   * 获取模板列表。
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @returns 模板列表
   */
  listByUser(userId: string, workspaceId: string | null): TaskTemplateRecord[] {
    const db = getDb();
    if (workspaceId) {
      return db
        .prepare('SELECT * FROM task_templates WHERE workspaceId = ? ORDER BY createdAt DESC')
        .all(workspaceId) as TaskTemplateRecord[];
    } else {
      return db
        .prepare('SELECT * FROM task_templates WHERE userId = ? AND workspaceId IS NULL ORDER BY createdAt DESC')
        .all(userId) as TaskTemplateRecord[];
    }
  },

  /**
   * 获取模板详情。
   *
   * @param templateId 模板 ID
   * @returns 模板记录，或 undefined
   */
  getById(templateId: string): TaskTemplateRecord | undefined {
    const db = getDb();
    return db
      .prepare('SELECT * FROM task_templates WHERE id = ?')
      .get(templateId) as TaskTemplateRecord | undefined;
  },

  /**
   * 创建模板。
   *
   * @param input 模板数据
   */
  create(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    name: string;
    description: string | null;
    icon: string | null;
    color: string | null;
    items: any[];
  }): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO task_templates (id, userId, workspaceId, name, description, icon, color, items, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      input.id,
      input.userId,
      input.workspaceId,
      input.name.trim(),
      input.description || null,
      input.icon || null,
      input.color || null,
      JSON.stringify(input.items),
      now,
      now
    );
  },

  /**
   * 更新模板。
   *
   * @param templateId 模板 ID
   * @param input 更新数据
   */
  update(templateId: string, input: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    items?: any[];
  }): void {
    const db = getDb();
    const updates: string[] = [];
    const params: any[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name.trim());
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description || null);
    }
    if (input.icon !== undefined) {
      updates.push('icon = ?');
      params.push(input.icon || null);
    }
    if (input.color !== undefined) {
      updates.push('color = ?');
      params.push(input.color || null);
    }
    if (input.items !== undefined) {
      updates.push('items = ?');
      params.push(JSON.stringify(input.items));
    }

    if (updates.length === 0) return;

    updates.push("updatedAt = datetime('now')");
    params.push(templateId);

    db.prepare(`UPDATE task_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  },

  /**
   * 删除模板。
   *
   * @param templateId 模板 ID
   */
  delete(templateId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM task_templates WHERE id = ?').run(templateId);
  },

  async listByUserAsync(userId: string, workspaceId: string | null): Promise<TaskTemplateRecord[]> {
    if (workspaceId) {
      return getAdapter().queryMany<TaskTemplateRecord>(
        'SELECT * FROM task_templates WHERE workspaceId = ? ORDER BY createdAt DESC',
        [workspaceId],
      );
    } else {
      return getAdapter().queryMany<TaskTemplateRecord>(
        'SELECT * FROM task_templates WHERE userId = ? AND workspaceId IS NULL ORDER BY createdAt DESC',
        [userId],
      );
    }
  },

  async getByIdAsync(templateId: string): Promise<TaskTemplateRecord | undefined> {
    return getAdapter().queryOne<TaskTemplateRecord>('SELECT * FROM task_templates WHERE id = ?', [templateId]);
  },

  async createAsync(input: { id: string; userId: string; workspaceId: string | null; name: string; description: string | null; icon: string | null; color: string | null; items: unknown[] }): Promise<void> {
    const now = new Date().toISOString();
    await getAdapter().execute(
      'INSERT INTO task_templates (id, userId, workspaceId, name, description, icon, color, items, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [input.id, input.userId, input.workspaceId, input.name.trim(), input.description || null, input.icon || null, input.color || null, JSON.stringify(input.items), now, now],
    );
  },

  async updateAsync(templateId: string, input: { name?: string; description?: string | null; icon?: string | null; color?: string | null; items?: unknown[] }): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { updates.push('name = ?'); params.push(input.name.trim()); }
    if (input.description !== undefined) { updates.push('description = ?'); params.push(input.description || null); }
    if (input.icon !== undefined) { updates.push('icon = ?'); params.push(input.icon || null); }
    if (input.color !== undefined) { updates.push('color = ?'); params.push(input.color || null); }
    if (input.items !== undefined) { updates.push('items = ?'); params.push(JSON.stringify(input.items)); }

    if (updates.length === 0) return;
    updates.push("updatedAt = datetime('now')");
    params.push(templateId);
    await getAdapter().execute(`UPDATE task_templates SET ${updates.join(', ')} WHERE id = ?`, params);
  },

  async deleteAsync(templateId: string): Promise<void> {
    await getAdapter().execute('DELETE FROM task_templates WHERE id = ?', [templateId]);
  },
};
