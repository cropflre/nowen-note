import type {
  DatabaseAdapter,
  DatabaseDriver,
} from "../db/adapters/types";

export type TaskScope =
  | { kind: "personal"; userId: string; workspaceId: null }
  | { kind: "workspace"; userId: string; workspaceId: string };

export type TaskListFilter = "all" | "today" | "week" | "overdue" | "completed";

export interface TaskCoreRow {
  id: string;
  userId: string;
  title: string;
  isCompleted: boolean | number;
  completedAt: string | Date | null;
  priority: number;
  dueDate: string | null;
  noteId: string | null;
  parentId: string | null;
  sortOrder: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  workspaceId: string | null;
  dueAt: string | Date | null;
  projectId: string | null;
  status: string;
  repeatRule: string;
  repeatInterval: number;
  repeatEndDate: string | null;
  repeatGroupId: string | null;
  repeatGeneratedFromId: string | null;
  repeatNextGeneratedId: string | null;
  repeatEndCount: number | null;
  repeatSequenceIndex: number | null;
  startDate: string | null;
  description: string;
  repeatRuleJson: string | null;
  creatorName?: string | null;
  activeReminderCount?: number;
}

export interface CreateTaskCoreInput {
  id: string;
  userId: string;
  title: string;
  workspaceId: string | null;
  priority?: number;
  dueDate?: string | null;
  dueAt?: string | null;
  startDate?: string | null;
  noteId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  status?: string;
  sortOrder?: number;
  description?: string;
  repeatRule?: string;
  repeatInterval?: number;
  repeatEndDate?: string | null;
  repeatGroupId?: string | null;
  repeatGeneratedFromId?: string | null;
  repeatNextGeneratedId?: string | null;
  repeatEndCount?: number | null;
  repeatSequenceIndex?: number | null;
  repeatRuleJson?: string | null;
}

export interface UpdateTaskCorePatch {
  title?: string;
  priority?: number;
  dueDate?: string | null;
  dueAt?: string | null;
  startDate?: string | null;
  noteId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  status?: string;
  sortOrder?: number;
  description?: string;
  repeatRule?: string;
  repeatInterval?: number;
  repeatEndDate?: string | null;
  repeatGroupId?: string | null;
  repeatGeneratedFromId?: string | null;
  repeatNextGeneratedId?: string | null;
  repeatEndCount?: number | null;
  repeatSequenceIndex?: number | null;
  repeatRuleJson?: string | null;
}

function boolPredicate(driver: DatabaseDriver, expression: string, value: boolean): string {
  if (driver === "postgres") return `${expression} = ${value ? "TRUE" : "FALSE"}`;
  return `${expression} = ${value ? "1" : "0"}`;
}

function duePresentSql(): string {
  return '(t."dueAt" IS NOT NULL OR NULLIF(t."dueDate", \'\') IS NOT NULL)';
}

function dateCondition(driver: DatabaseDriver, filter: TaskListFilter): string | null {
  if (filter === "completed") return boolPredicate(driver, 't."isCompleted"', true);
  if (filter === "all") return null;

  if (driver === "postgres") {
    const localDate = `COALESCE(t."dueAt"::date, NULLIF(t."dueDate", '')::date)`;
    if (filter === "today") {
      return `${duePresentSql()} AND ${localDate} = CURRENT_DATE`;
    }
    if (filter === "week") {
      return `${duePresentSql()} AND ${localDate} BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')::date`;
    }
    return `${boolPredicate(driver, 't."isCompleted"', false)} AND ${duePresentSql()} AND (`
      + `(t."dueAt" IS NOT NULL AND t."dueAt" < CURRENT_TIMESTAMP) OR `
      + `(t."dueAt" IS NULL AND NULLIF(t."dueDate", '')::date < CURRENT_DATE))`;
  }

  const dueValue = 'COALESCE(t."dueAt", t."dueDate")';
  if (filter === "today") {
    return `${duePresentSql()} AND date(${dueValue}) = date('now', 'localtime')`;
  }
  if (filter === "week") {
    return `${duePresentSql()} AND date(${dueValue}) BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')`;
  }
  return `${boolPredicate(driver, 't."isCompleted"', false)} AND ${duePresentSql()} AND `
    + `datetime(COALESCE(t."dueAt", t."dueDate" || 'T23:59:59')) < datetime('now', 'localtime')`;
}

function scopeWhere(scope: TaskScope): { sql: string; params: unknown[] } {
  if (scope.kind === "workspace") {
    return { sql: 't."workspaceId" = ?', params: [scope.workspaceId] };
  }
  return {
    sql: 't."userId" = ? AND t."workspaceId" IS NULL',
    params: [scope.userId],
  };
}

function normalizeRow(row: TaskCoreRow): TaskCoreRow {
  return {
    ...row,
    priority: Number(row.priority ?? 2),
    sortOrder: Number(row.sortOrder ?? 0),
    repeatInterval: Number(row.repeatInterval ?? 1),
    repeatEndCount: row.repeatEndCount == null ? null : Number(row.repeatEndCount),
    repeatSequenceIndex: row.repeatSequenceIndex == null ? null : Number(row.repeatSequenceIndex),
    activeReminderCount: row.activeReminderCount == null
      ? undefined
      : Number(row.activeReminderCount),
  };
}

export function createTaskCoreRepository(
  adapter: DatabaseAdapter,
  driver: DatabaseDriver,
) {
  const reminderEnabled = boolPredicate(driver, 'tr.enabled', true);

  return {
    async getWorkspaceRole(workspaceId: string, userId: string): Promise<string | null> {
      const row = await adapter.queryOne<{ role: string }>(
        'SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?',
        [workspaceId, userId],
      );
      return row?.role ?? null;
    },

    async getUserRole(userId: string): Promise<string | null> {
      const row = await adapter.queryOne<{ role: string }>(
        'SELECT role FROM users WHERE id = ?',
        [userId],
      );
      return row?.role ?? null;
    },

    async list(input: {
      scope: TaskScope;
      filter?: TaskListFilter;
      noteId?: string | null;
      projectId?: string | null | undefined;
    }): Promise<TaskCoreRow[]> {
      const scoped = scopeWhere(input.scope);
      const conditions = [scoped.sql];
      const params: unknown[] = [input.scope.userId, ...scoped.params];

      if (input.noteId) {
        conditions.push('t."noteId" = ?');
        params.push(input.noteId);
      }
      if (input.projectId !== undefined) {
        if (input.projectId === null || input.projectId === "") {
          conditions.push('t."projectId" IS NULL');
        } else {
          conditions.push('t."projectId" = ?');
          params.push(input.projectId);
        }
      }
      const filterSql = dateCondition(driver, input.filter ?? "all");
      if (filterSql) conditions.push(filterSql);

      const rows = await adapter.queryMany<TaskCoreRow>(
        `SELECT t.*,
                u.username AS "creatorName",
                (SELECT COUNT(*)
                   FROM task_reminders tr
                  WHERE tr."taskId" = t.id
                    AND tr."userId" = ?
                    AND ${reminderEnabled}) AS "activeReminderCount"
           FROM tasks t
           LEFT JOIN users u ON u.id = t."userId"
          WHERE ${conditions.join(" AND ")}
          ORDER BY t."isCompleted" ASC, t.priority DESC, t."sortOrder" ASC, t."createdAt" DESC`,
        params,
      );
      return rows.map(normalizeRow);
    },

    async stats(scope: TaskScope): Promise<{
      total: number;
      completed: number;
      pending: number;
      today: number;
      overdue: number;
      week: number;
    }> {
      const scoped = scopeWhere(scope);
      const complete = boolPredicate(driver, 't."isCompleted"', true);
      const pending = boolPredicate(driver, 't."isCompleted"', false);
      const today = dateCondition(driver, "today")!;
      const overdue = dateCondition(driver, "overdue")!;
      const week = dateCondition(driver, "week")!;
      const row = await adapter.queryOne<{
        total: number | string;
        completed: number | string | null;
        today: number | string | null;
        overdue: number | string | null;
        week: number | string | null;
      }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ${complete} THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN ${pending} AND ${today} THEN 1 ELSE 0 END) AS today,
                SUM(CASE WHEN ${overdue} THEN 1 ELSE 0 END) AS overdue,
                SUM(CASE WHEN ${pending} AND ${week} THEN 1 ELSE 0 END) AS week
           FROM tasks t
          WHERE ${scoped.sql}`,
        scoped.params,
      );
      const total = Number(row?.total ?? 0);
      const completed = Number(row?.completed ?? 0);
      const todayCount = Number(row?.today ?? 0);
      const overdueCount = Number(row?.overdue ?? 0);
      const weekCount = Number(row?.week ?? 0);
      return {
        total,
        completed,
        pending: total - completed,
        today: todayCount,
        overdue: overdueCount,
        week: weekCount,
      };
    },

    async getById(id: string): Promise<TaskCoreRow | undefined> {
      const row = await adapter.queryOne<TaskCoreRow>(
        'SELECT * FROM tasks WHERE id = ?',
        [id],
      );
      return row ? normalizeRow(row) : undefined;
    },

    async listChildren(parentId: string): Promise<TaskCoreRow[]> {
      const rows = await adapter.queryMany<TaskCoreRow>(
        'SELECT * FROM tasks WHERE "parentId" = ? ORDER BY "sortOrder" ASC, "createdAt" ASC',
        [parentId],
      );
      return rows.map(normalizeRow);
    },

    async create(input: CreateTaskCoreInput): Promise<TaskCoreRow> {
      await adapter.execute(
        `INSERT INTO tasks (
           id, "userId", title, "workspaceId", priority,
           "dueDate", "dueAt", "startDate", "noteId", "parentId", "projectId",
           status, "sortOrder", description, "repeatRule", "repeatInterval",
           "repeatEndDate", "repeatGroupId", "repeatGeneratedFromId",
           "repeatNextGeneratedId", "repeatEndCount", "repeatSequenceIndex", "repeatRuleJson"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.userId,
          input.title,
          input.workspaceId,
          input.priority ?? 2,
          input.dueDate ?? null,
          input.dueAt ?? null,
          input.startDate ?? null,
          input.noteId ?? null,
          input.parentId ?? null,
          input.projectId ?? null,
          input.status ?? "todo",
          input.sortOrder ?? 0,
          input.description ?? "",
          input.repeatRule ?? "none",
          input.repeatInterval ?? 1,
          input.repeatEndDate ?? null,
          input.repeatGroupId ?? null,
          input.repeatGeneratedFromId ?? null,
          input.repeatNextGeneratedId ?? null,
          input.repeatEndCount ?? null,
          input.repeatSequenceIndex ?? null,
          input.repeatRuleJson ?? null,
        ],
      );
      const created = await this.getById(input.id);
      if (!created) throw new Error(`Task ${input.id} was not readable after insert`);
      return created;
    },

    async update(id: string, patch: UpdateTaskCorePatch): Promise<TaskCoreRow | undefined> {
      const columns: Record<keyof UpdateTaskCorePatch, string> = {
        title: "title",
        priority: "priority",
        dueDate: '"dueDate"',
        dueAt: '"dueAt"',
        startDate: '"startDate"',
        noteId: '"noteId"',
        parentId: '"parentId"',
        projectId: '"projectId"',
        status: "status",
        sortOrder: '"sortOrder"',
        description: "description",
        repeatRule: '"repeatRule"',
        repeatInterval: '"repeatInterval"',
        repeatEndDate: '"repeatEndDate"',
        repeatGroupId: '"repeatGroupId"',
        repeatGeneratedFromId: '"repeatGeneratedFromId"',
        repeatNextGeneratedId: '"repeatNextGeneratedId"',
        repeatEndCount: '"repeatEndCount"',
        repeatSequenceIndex: '"repeatSequenceIndex"',
        repeatRuleJson: '"repeatRuleJson"',
      };
      const assignments: string[] = [];
      const params: unknown[] = [];
      for (const [key, value] of Object.entries(patch) as Array<[keyof UpdateTaskCorePatch, unknown]>) {
        if (!(key in columns)) continue;
        assignments.push(`${columns[key]} = ?`);
        params.push(value);
      }
      if (assignments.length === 0) return this.getById(id);
      assignments.push('"updatedAt" = CURRENT_TIMESTAMP');
      params.push(id);
      const result = await adapter.execute(
        `UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`,
        params,
      );
      if (result.changes !== 1) return undefined;
      return this.getById(id);
    },

    async setCompletion(id: string, completed: boolean): Promise<TaskCoreRow | undefined> {
      const result = await adapter.execute(
        `UPDATE tasks
            SET "isCompleted" = ?,
                "completedAt" = ${completed ? "CURRENT_TIMESTAMP" : "NULL"},
                status = ?,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [completed, completed ? "done" : "todo", id],
      );
      if (result.changes !== 1) return undefined;
      return this.getById(id);
    },

    async getRowsForReorder(ids: string[]): Promise<Array<{
      id: string;
      userId: string;
      workspaceId: string | null;
      parentId: string | null;
    }>> {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      return adapter.queryMany(
        `SELECT id,
                "userId" AS "userId",
                "workspaceId" AS "workspaceId",
                "parentId" AS "parentId"
           FROM tasks WHERE id IN (${placeholders})`,
        ids,
      );
    },

    async reorder(items: Array<{ id: string; sortOrder: number }>): Promise<void> {
      await adapter.transaction(async (tx) => {
        for (const item of items) {
          await tx.execute(
            'UPDATE tasks SET "sortOrder" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ?',
            [item.sortOrder, item.id],
          );
        }
      });
    },

    async collectDescendantIds(rootId: string): Promise<string[]> {
      const rows = await adapter.queryMany<{ id: string }>(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT child.id
             FROM tasks child
             JOIN descendants parent ON child."parentId" = parent.id
         )
         SELECT id FROM descendants`,
        [rootId],
      );
      return rows.map((row) => row.id);
    },

    async deleteIds(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(", ");
      const result = await adapter.execute(
        `DELETE FROM tasks WHERE id IN (${placeholders})`,
        ids,
      );
      return result.changes;
    },
  };
}
