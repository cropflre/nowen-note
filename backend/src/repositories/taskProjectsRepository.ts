/**
 * Task Projects Repository
 *
 * 同步方法继续服务 SQLite 默认运行时；async 方法统一通过 Database Runtime
 * Provider，在 SQLite 与 PostgreSQL 下复用同一业务接口。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";

function getAdapter() {
  return getDatabaseAdapter();
}

export interface TaskProjectRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskProjectWithStats extends TaskProjectRecord {
  taskCount: number;
  completedCount: number;
  progress: number;
}

type RawTaskProjectWithStats = Omit<TaskProjectWithStats, "taskCount" | "completedCount" | "progress"> & {
  taskCount: unknown;
  completedCount: unknown;
  progress: unknown;
};

function normalizeStats(row: RawTaskProjectWithStats): TaskProjectWithStats {
  return {
    ...row,
    taskCount: Number(row.taskCount ?? 0),
    completedCount: Number(row.completedCount ?? 0),
    progress: Number(row.progress ?? 0),
  };
}

function projectStatsSql(where: string): string {
  return `SELECT p.*,
    (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id) AS "taskCount",
    (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id AND t."isCompleted" = 1) AS "completedCount",
    CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id) > 0 THEN
      ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id AND t."isCompleted" = 1) /
      (SELECT COUNT(*) FROM tasks t WHERE t."projectId" = p.id))
    ELSE 0 END AS progress
    FROM task_projects p
    WHERE ${where}`;
}

export const taskProjectsRepository = {
  listByUser(userId: string, workspaceId: string | null): TaskProjectWithStats[] {
    const db = getDb();
    const rows = workspaceId
      ? db.prepare(`${projectStatsSql('p."workspaceId" = ?')} ORDER BY p."sortOrder" ASC, p."createdAt" ASC`).all(workspaceId)
      : db.prepare(`${projectStatsSql('p."userId" = ? AND p."workspaceId" IS NULL')} ORDER BY p."sortOrder" ASC, p."createdAt" ASC`).all(userId);
    return (rows as RawTaskProjectWithStats[]).map(normalizeStats);
  },

  getById(projectId: string): TaskProjectRecord | undefined {
    return getDb().prepare("SELECT * FROM task_projects WHERE id = ?").get(projectId) as TaskProjectRecord | undefined;
  },

  getByIdWithStats(projectId: string): TaskProjectWithStats | undefined {
    const row = getDb().prepare(projectStatsSql("p.id = ?")).get(projectId) as RawTaskProjectWithStats | undefined;
    return row ? normalizeStats(row) : undefined;
  },

  create(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): void {
    getDb().prepare(
      'INSERT INTO task_projects (id, "userId", "workspaceId", name, icon, color, "sortOrder") VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(input.id, input.userId, input.workspaceId, input.name, input.icon, input.color, input.sortOrder);
  },

  update(projectId: string, input: {
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): void {
    getDb().prepare(
      'UPDATE task_projects SET name = ?, icon = ?, color = ?, "sortOrder" = ?, "updatedAt" = datetime(\'now\') WHERE id = ?',
    ).run(input.name, input.icon, input.color, input.sortOrder, projectId);
  },

  delete(projectId: string): void {
    const db = getDb();
    db.prepare('UPDATE tasks SET "projectId" = NULL WHERE "projectId" = ?').run(projectId);
    db.prepare("DELETE FROM task_projects WHERE id = ?").run(projectId);
  },

  updateSortOrder(items: Array<{ id: string; sortOrder: number }>): void {
    const db = getDb();
    const stmt = db.prepare('UPDATE task_projects SET "sortOrder" = ?, "updatedAt" = datetime(\'now\') WHERE id = ?');
    db.transaction(() => {
      for (const item of items) stmt.run(item.sortOrder, item.id);
    })();
  },

  async updateSortOrderAsync(items: Array<{ id: string; sortOrder: number }>): Promise<void> {
    if (items.length === 0) return;
    await getAdapter().executeBatch(
      'UPDATE task_projects SET "sortOrder" = ?, "updatedAt" = datetime(\'now\') WHERE id = ?',
      items.map((item) => [item.sortOrder, item.id]),
    );
  },

  async listByUserAsync(userId: string, workspaceId: string | null): Promise<TaskProjectWithStats[]> {
    const rows = workspaceId
      ? await getAdapter().queryMany<RawTaskProjectWithStats>(
          `${projectStatsSql('p."workspaceId" = ?')} ORDER BY p."sortOrder" ASC, p."createdAt" ASC`,
          [workspaceId],
        )
      : await getAdapter().queryMany<RawTaskProjectWithStats>(
          `${projectStatsSql('p."userId" = ? AND p."workspaceId" IS NULL')} ORDER BY p."sortOrder" ASC, p."createdAt" ASC`,
          [userId],
        );
    return rows.map(normalizeStats);
  },

  async getByIdAsync(projectId: string): Promise<TaskProjectRecord | undefined> {
    return getAdapter().queryOne<TaskProjectRecord>("SELECT * FROM task_projects WHERE id = ?", [projectId]);
  },

  async getByIdWithStatsAsync(projectId: string): Promise<TaskProjectWithStats | undefined> {
    const row = await getAdapter().queryOne<RawTaskProjectWithStats>(projectStatsSql("p.id = ?"), [projectId]);
    return row ? normalizeStats(row) : undefined;
  },

  async createAsync(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): Promise<void> {
    await getAdapter().execute(
      'INSERT INTO task_projects (id, "userId", "workspaceId", name, icon, color, "sortOrder") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [input.id, input.userId, input.workspaceId, input.name, input.icon, input.color, input.sortOrder],
    );
  },

  async updateAsync(projectId: string, input: {
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): Promise<void> {
    await getAdapter().execute(
      'UPDATE task_projects SET name = ?, icon = ?, color = ?, "sortOrder" = ?, "updatedAt" = datetime(\'now\') WHERE id = ?',
      [input.name, input.icon, input.color, input.sortOrder, projectId],
    );
  },

  async deleteAsync(projectId: string): Promise<void> {
    await getAdapter().executeStatements([
      { sql: 'UPDATE tasks SET "projectId" = NULL WHERE "projectId" = ?', params: [projectId] },
      { sql: "DELETE FROM task_projects WHERE id = ?", params: [projectId] },
    ]);
  },
};
