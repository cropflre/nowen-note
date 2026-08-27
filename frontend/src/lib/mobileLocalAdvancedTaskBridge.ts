import type {
  Habit,
  HabitCheckin,
  HabitCheckinListItem,
  HabitCheckinStatus,
  HabitStats,
  Task,
  TaskDependency,
  TaskProject,
  TaskTemplate,
  TaskTemplateItem,
} from "@/types";
import { api } from "./api";
import { newLocalId } from "./localRepository";
import type { NativeDatabase } from "./nativeDatabase";

function now(): string {
  return new Date().toISOString();
}

function dateKey(value = now()): string {
  return value.slice(0, 10);
}

function addDays(baseDate: string, offset: number): string {
  const date = new Date(`${baseDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return baseDate;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function parseItems(value: unknown): TaskTemplateItem[] {
  if (Array.isArray(value)) return value as TaskTemplateItem[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as TaskTemplateItem[] : [];
  } catch {
    return [];
  }
}

function normalizeProject(row: Record<string, unknown>): TaskProject {
  const taskCount = Number(row.taskCount || 0);
  const completedCount = Number(row.completedCount || 0);
  return {
    id: String(row.id),
    userId: String(row.userId),
    workspaceId: null,
    name: String(row.name || "未命名项目"),
    icon: String(row.icon || "📋"),
    color: String(row.color || "#6366f1"),
    sortOrder: Number(row.sortOrder || 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    taskCount,
    completedCount,
    progress: taskCount > 0 ? Math.round((completedCount / taskCount) * 100) : 0,
  };
}

function normalizeTemplate(row: Record<string, unknown>): TaskTemplate {
  return {
    id: String(row.id),
    userId: String(row.userId),
    workspaceId: null,
    name: String(row.name || "未命名模板"),
    description: row.description == null ? null : String(row.description),
    icon: row.icon == null ? null : String(row.icon),
    color: row.color == null ? null : String(row.color),
    items: parseItems(row.items),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function normalizeHabit(row: Record<string, unknown>): Habit {
  return {
    id: String(row.id),
    userId: String(row.userId),
    workspaceId: null,
    title: String(row.title || "未命名习惯"),
    icon: String(row.icon || "✅"),
    color: String(row.color || "#10b981"),
    sortOrder: Number(row.sortOrder || 0),
    archivedAt: row.archivedAt == null ? null : String(row.archivedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    todayStatus: row.todayStatus == null ? null : row.todayStatus as HabitCheckinStatus,
    todayNote: row.todayNote == null ? null : String(row.todayNote),
    todayCheckinDate: row.todayCheckinDate == null ? null : String(row.todayCheckinDate),
    canManage: true,
  };
}

async function ensureSchema(db: NativeDatabase): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS mobile_local_task_projects (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '📋',
      color TEXT NOT NULL DEFAULT '#6366f1',
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mobile_local_task_projects_sort
      ON mobile_local_task_projects(sortOrder, createdAt)`,
    `CREATE TABLE IF NOT EXISTS mobile_local_task_templates (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      color TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mobile_local_task_templates_created
      ON mobile_local_task_templates(createdAt)`,
    `CREATE TABLE IF NOT EXISTS mobile_local_task_dependencies (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      predecessorTaskId TEXT NOT NULL,
      successorTaskId TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'finish_to_start',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(predecessorTaskId, successorTaskId),
      CHECK(predecessorTaskId <> successorTaskId)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mobile_local_task_dependencies_predecessor
      ON mobile_local_task_dependencies(predecessorTaskId)`,
    `CREATE INDEX IF NOT EXISTS idx_mobile_local_task_dependencies_successor
      ON mobile_local_task_dependencies(successorTaskId)`,
    `CREATE TABLE IF NOT EXISTS mobile_local_habits (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '✅',
      color TEXT NOT NULL DEFAULT '#10b981',
      sortOrder INTEGER NOT NULL DEFAULT 0,
      archivedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mobile_local_habits_sort
      ON mobile_local_habits(archivedAt, sortOrder, createdAt)`,
    `CREATE TABLE IF NOT EXISTS mobile_local_habit_checkins (
      id TEXT PRIMARY KEY,
      habitId TEXT NOT NULL,
      userId TEXT NOT NULL,
      checkinDate TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','partial','failure')),
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(habitId, checkinDate),
      FOREIGN KEY(habitId) REFERENCES mobile_local_habits(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mobile_local_habit_checkins_date
      ON mobile_local_habit_checkins(checkinDate DESC, habitId)`,
  ];
  for (const statement of statements) await db.run(statement);
}

/**
 * Android 纯设备离线模式的任务高级能力。
 *
 * 这些实体尚未进入 Mobile Sync V2 的完整七段同步链路，因此本 Bridge 只在
 * device-only 数据库安装。这样既不再用 [] 假装成功，也不会在登录同步模式下
 * 制造“本地写成功但永远同步不上服务器”的数据分叉。
 */
export function installMobileLocalAdvancedTaskBridge(
  db: NativeDatabase,
  userId: string,
): () => void {
  const target = api as any;
  const originals = {
    getTaskProjects: target.getTaskProjects,
    createTaskProject: target.createTaskProject,
    updateTaskProject: target.updateTaskProject,
    deleteTaskProject: target.deleteTaskProject,
    getTaskTemplates: target.getTaskTemplates,
    createTaskTemplate: target.createTaskTemplate,
    updateTaskTemplate: target.updateTaskTemplate,
    deleteTaskTemplate: target.deleteTaskTemplate,
    applyTaskTemplate: target.applyTaskTemplate,
    getTaskDependencies: target.getTaskDependencies,
    createTaskDependency: target.createTaskDependency,
    deleteTaskDependency: target.deleteTaskDependency,
    getHabits: target.getHabits,
    createHabit: target.createHabit,
    updateHabit: target.updateHabit,
    archiveHabit: target.archiveHabit,
    deleteHabit: target.deleteHabit,
    getHabitCheckins: target.getHabitCheckins,
    getHabitCheckinLog: target.getHabitCheckinLog,
    checkInHabit: target.checkInHabit,
    getHabitStats: target.getHabitStats,
  };

  let schemaPromise: Promise<void> | null = null;
  const ready = () => {
    if (!schemaPromise) schemaPromise = ensureSchema(db);
    return schemaPromise;
  };

  const readProject = async (id: string): Promise<TaskProject> => {
    await ready();
    const row = (await db.query<Record<string, unknown>>(`
      SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.scopeKey='personal' AND t.projectId=p.id) AS taskCount,
        (SELECT COUNT(*) FROM tasks t WHERE t.scopeKey='personal' AND t.projectId=p.id AND t.isCompleted=1) AS completedCount
      FROM mobile_local_task_projects p WHERE p.id=? LIMIT 1
    `, [id]))[0];
    if (!row) throw new Error("任务项目不存在");
    return normalizeProject(row);
  };

  target.getTaskProjects = async (): Promise<TaskProject[]> => {
    await ready();
    const rows = await db.query<Record<string, unknown>>(`
      SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.scopeKey='personal' AND t.projectId=p.id) AS taskCount,
        (SELECT COUNT(*) FROM tasks t WHERE t.scopeKey='personal' AND t.projectId=p.id AND t.isCompleted=1) AS completedCount
      FROM mobile_local_task_projects p ORDER BY p.sortOrder,p.createdAt
    `);
    return rows.map(normalizeProject);
  };
  target.createTaskProject = async (data: { name: string; icon?: string; color?: string }): Promise<TaskProject> => {
    await ready();
    const id = newLocalId();
    const timestamp = now();
    const name = data.name?.trim();
    if (!name) throw new Error("项目名称不能为空");
    await db.run(`INSERT INTO mobile_local_task_projects
      (id,userId,name,icon,color,sortOrder,createdAt,updatedAt) VALUES (?,?,?,?,?,0,?,?)`, [
      id,userId,name,data.icon || "📋",data.color || "#6366f1",timestamp,timestamp,
    ]);
    return readProject(id);
  };
  target.updateTaskProject = async (id: string, patch: Partial<TaskProject>): Promise<TaskProject> => {
    const current = await readProject(id);
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) throw new Error("项目名称不能为空");
    await db.run(`UPDATE mobile_local_task_projects
      SET name=?,icon=?,color=?,sortOrder=?,updatedAt=? WHERE id=?`, [
      name,patch.icon ?? current.icon,patch.color ?? current.color,
      patch.sortOrder ?? current.sortOrder,now(),id,
    ]);
    return readProject(id);
  };
  target.deleteTaskProject = async (id: string) => {
    await ready();
    await db.transaction(async (tx) => {
      await tx.run("UPDATE tasks SET projectId=NULL,updatedAt=? WHERE scopeKey='personal' AND projectId=?", [now(),id]);
      await tx.run("DELETE FROM mobile_local_task_projects WHERE id=?", [id]);
    });
    return { success: true };
  };

  const readTemplate = async (id: string): Promise<TaskTemplate> => {
    await ready();
    const row = (await db.query<Record<string, unknown>>(
      "SELECT * FROM mobile_local_task_templates WHERE id=? LIMIT 1", [id],
    ))[0];
    if (!row) throw new Error("任务模板不存在");
    return normalizeTemplate(row);
  };

  target.getTaskTemplates = async (): Promise<TaskTemplate[]> => {
    await ready();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM mobile_local_task_templates ORDER BY createdAt DESC",
    );
    return rows.map(normalizeTemplate);
  };
  target.createTaskTemplate = async (data: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    items: TaskTemplateItem[];
  }): Promise<TaskTemplate> => {
    await ready();
    const name = data.name?.trim();
    if (!name) throw new Error("模板名称不能为空");
    const id = newLocalId();
    const timestamp = now();
    await db.run(`INSERT INTO mobile_local_task_templates
      (id,userId,name,description,icon,color,items,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`, [
      id,userId,name,data.description || null,data.icon || null,data.color || null,
      JSON.stringify(data.items || []),timestamp,timestamp,
    ]);
    return readTemplate(id);
  };
  target.updateTaskTemplate = async (id: string, patch: Partial<TaskTemplate>): Promise<TaskTemplate> => {
    const current = await readTemplate(id);
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) throw new Error("模板名称不能为空");
    await db.run(`UPDATE mobile_local_task_templates
      SET name=?,description=?,icon=?,color=?,items=?,updatedAt=? WHERE id=?`, [
      name,patch.description ?? current.description,patch.icon ?? current.icon,patch.color ?? current.color,
      JSON.stringify(patch.items ?? current.items),now(),id,
    ]);
    return readTemplate(id);
  };
  target.deleteTaskTemplate = async (id: string) => {
    await ready();
    await db.run("DELETE FROM mobile_local_task_templates WHERE id=?", [id]);
    return { success: true };
  };
  target.applyTaskTemplate = async (id: string, options: {
    projectId?: string | null;
    parentId?: string | null;
    baseDate?: string | null;
  }) => {
    const template = await readTemplate(id);
    if (options.projectId) await readProject(options.projectId);
    const baseDate = options.baseDate || dateKey();
    const createdTasks: Task[] = [];
    const items = [...template.items].sort((a, b) => a.sortOrder - b.sortOrder);
    const createdByOriginalIndex = new Map<number, string>();

    for (const item of items) {
      const originalIndex = template.items.indexOf(item);
      const relativeDueDays = Number.isFinite(item.relativeDueDays) ? Number(item.relativeDueDays) : null;
      const parentId = item.parentIndex == null
        ? options.parentId || null
        : createdByOriginalIndex.get(item.parentIndex) || options.parentId || null;
      const task = await target.createTask({
        title: item.title,
        description: item.description || "",
        priority: item.priority === 1 || item.priority === 3 ? item.priority : 2,
        dueDate: relativeDueDays == null ? null : addDays(baseDate, relativeDueDays),
        dueAt: null,
        parentId,
        projectId: options.projectId || null,
        sortOrder: item.sortOrder,
      }) as Task;
      createdTasks.push(task);
      createdByOriginalIndex.set(originalIndex, task.id);
    }
    return { createdTasks, count: createdTasks.length };
  };

  const dependencyRows = async (): Promise<TaskDependency[]> => {
    await ready();
    return db.query<TaskDependency>(`SELECT id,userId,NULL AS workspaceId,predecessorTaskId,successorTaskId,type,createdAt,updatedAt
      FROM mobile_local_task_dependencies ORDER BY createdAt`);
  };
  target.getTaskDependencies = async (taskId?: string): Promise<TaskDependency[]> => {
    const rows = await dependencyRows();
    if (!taskId) return rows;
    return rows.filter((row) => row.predecessorTaskId === taskId || row.successorTaskId === taskId);
  };
  target.createTaskDependency = async (data: {
    predecessorTaskId: string;
    successorTaskId: string;
    type?: string;
  }): Promise<TaskDependency> => {
    await ready();
    if (!data.predecessorTaskId || !data.successorTaskId) throw new Error("请选择前置任务和后续任务");
    if (data.predecessorTaskId === data.successorTaskId) throw new Error("任务不能依赖自身");
    const [predecessor, successor] = await Promise.all([
      target.getTask(data.predecessorTaskId),
      target.getTask(data.successorTaskId),
    ]);
    if (!predecessor || !successor) throw new Error("依赖的任务不存在");

    const rows = await dependencyRows();
    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.predecessorTaskId) || [];
      list.push(row.successorTaskId);
      adjacency.set(row.predecessorTaskId, list);
    }
    const stack = [data.successorTaskId];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === data.predecessorTaskId) throw new Error("该依赖会形成循环");
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(adjacency.get(current) || []));
    }

    if (rows.some((row) => row.predecessorTaskId === data.predecessorTaskId && row.successorTaskId === data.successorTaskId)) {
      throw new Error("该任务依赖已存在");
    }
    const id = newLocalId();
    const timestamp = now();
    await db.run(`INSERT INTO mobile_local_task_dependencies
      (id,userId,predecessorTaskId,successorTaskId,type,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`, [
      id,userId,data.predecessorTaskId,data.successorTaskId,"finish_to_start",timestamp,timestamp,
    ]);
    return (await dependencyRows()).find((row) => row.id === id)!;
  };
  target.deleteTaskDependency = async (id: string) => {
    await ready();
    await db.run("DELETE FROM mobile_local_task_dependencies WHERE id=?", [id]);
    return { success: true };
  };

  const readHabit = async (id: string, checkinDate = dateKey()): Promise<Habit> => {
    await ready();
    const row = (await db.query<Record<string, unknown>>(`
      SELECT h.*,c.status AS todayStatus,c.note AS todayNote,c.checkinDate AS todayCheckinDate
      FROM mobile_local_habits h
      LEFT JOIN mobile_local_habit_checkins c ON c.habitId=h.id AND c.checkinDate=?
      WHERE h.id=? LIMIT 1
    `, [checkinDate,id]))[0];
    if (!row) throw new Error("习惯不存在");
    return normalizeHabit(row);
  };

  target.getHabits = async (includeArchived = false, checkinDate?: string): Promise<Habit[]> => {
    await ready();
    const date = checkinDate || dateKey();
    const rows = await db.query<Record<string, unknown>>(`
      SELECT h.*,c.status AS todayStatus,c.note AS todayNote,c.checkinDate AS todayCheckinDate
      FROM mobile_local_habits h
      LEFT JOIN mobile_local_habit_checkins c ON c.habitId=h.id AND c.checkinDate=?
      ${includeArchived ? "" : "WHERE h.archivedAt IS NULL"}
      ORDER BY h.sortOrder,h.createdAt
    `, [date]);
    return rows.map(normalizeHabit);
  };
  target.createHabit = async (data: {
    title: string;
    icon?: string;
    color?: string;
    sortOrder?: number;
  }): Promise<Habit> => {
    await ready();
    const title = data.title?.trim();
    if (!title) throw new Error("习惯名称不能为空");
    const id = newLocalId();
    const timestamp = now();
    await db.run(`INSERT INTO mobile_local_habits
      (id,userId,title,icon,color,sortOrder,archivedAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,NULL,?,?)`, [
      id,userId,title,data.icon || "✅",data.color || "#10b981",data.sortOrder || 0,timestamp,timestamp,
    ]);
    return readHabit(id);
  };
  target.updateHabit = async (id: string, patch: Partial<Habit>): Promise<Habit> => {
    const current = await readHabit(id);
    const title = patch.title !== undefined ? patch.title.trim() : current.title;
    if (!title) throw new Error("习惯名称不能为空");
    await db.run(`UPDATE mobile_local_habits
      SET title=?,icon=?,color=?,sortOrder=?,archivedAt=?,updatedAt=? WHERE id=?`, [
      title,patch.icon ?? current.icon,patch.color ?? current.color,
      patch.sortOrder ?? current.sortOrder,patch.archivedAt ?? current.archivedAt,now(),id,
    ]);
    return readHabit(id);
  };
  target.archiveHabit = async (id: string, archived = true): Promise<Habit> => {
    await readHabit(id);
    await db.run("UPDATE mobile_local_habits SET archivedAt=?,updatedAt=? WHERE id=?", [
      archived ? now() : null,now(),id,
    ]);
    return readHabit(id);
  };
  target.deleteHabit = async (id: string) => {
    await ready();
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM mobile_local_habit_checkins WHERE habitId=?", [id]);
      await tx.run("DELETE FROM mobile_local_habits WHERE id=?", [id]);
    });
    return { success: true };
  };
  target.getHabitCheckins = async (id: string, params?: { from?: string; to?: string }): Promise<HabitCheckin[]> => {
    await ready();
    const where = ["habitId=?"];
    const values: unknown[] = [id];
    if (params?.from) { where.push("checkinDate>=?"); values.push(params.from); }
    if (params?.to) { where.push("checkinDate<=?"); values.push(params.to); }
    return db.query<HabitCheckin>(`SELECT id,habitId,userId,NULL AS workspaceId,checkinDate,status,note,createdAt,updatedAt
      FROM mobile_local_habit_checkins WHERE ${where.join(" AND ")} ORDER BY checkinDate DESC`, values);
  };
  target.getHabitCheckinLog = async (params?: {
    from?: string;
    to?: string;
    includeArchived?: boolean;
  }): Promise<HabitCheckinListItem[]> => {
    await ready();
    const where: string[] = [];
    const values: unknown[] = [];
    if (params?.from) { where.push("c.checkinDate>=?"); values.push(params.from); }
    if (params?.to) { where.push("c.checkinDate<=?"); values.push(params.to); }
    if (params?.includeArchived === false) where.push("h.archivedAt IS NULL");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return db.query<HabitCheckinListItem>(`SELECT
      c.id,c.habitId,c.userId,NULL AS workspaceId,c.checkinDate,c.status,c.note,c.createdAt,c.updatedAt,
      h.title AS habitTitle,h.color AS habitColor,h.icon AS habitIcon,h.archivedAt AS habitArchivedAt,
      1 AS canManage
      FROM mobile_local_habit_checkins c JOIN mobile_local_habits h ON h.id=c.habitId
      ${clause} ORDER BY c.checkinDate DESC,c.createdAt DESC`, values);
  };
  target.checkInHabit = async (id: string, data: {
    status: HabitCheckinStatus;
    note?: string;
    checkinDate?: string;
  }): Promise<HabitCheckin> => {
    await readHabit(id);
    const checkinDate = data.checkinDate || dateKey();
    const existing = (await db.query<{ id: string; createdAt: string }>(
      "SELECT id,createdAt FROM mobile_local_habit_checkins WHERE habitId=? AND checkinDate=?", [id,checkinDate],
    ))[0];
    const timestamp = now();
    const checkinId = existing?.id || newLocalId();
    if (existing) {
      await db.run(`UPDATE mobile_local_habit_checkins
        SET status=?,note=?,updatedAt=? WHERE id=?`, [data.status,data.note || "",timestamp,checkinId]);
    } else {
      await db.run(`INSERT INTO mobile_local_habit_checkins
        (id,habitId,userId,checkinDate,status,note,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)`, [
        checkinId,id,userId,checkinDate,data.status,data.note || "",timestamp,timestamp,
      ]);
    }
    return (await db.query<HabitCheckin>(`SELECT id,habitId,userId,NULL AS workspaceId,checkinDate,status,note,createdAt,updatedAt
      FROM mobile_local_habit_checkins WHERE id=?`, [checkinId]))[0];
  };
  target.getHabitStats = async (includeArchived = false, checkinDate?: string): Promise<HabitStats> => {
    await ready();
    const habits = await target.getHabits(includeArchived, checkinDate) as Habit[];
    const habitIds = new Set(habits.map((habit) => habit.id));
    const rows = (await db.query<ArrayRecord>(`SELECT habitId,checkinDate,status FROM mobile_local_habit_checkins ORDER BY checkinDate DESC`))
      .filter((row) => habitIds.has(String(row.habitId)));
    const dates = Array.from(new Set(rows.map((row) => String(row.checkinDate)))).sort().reverse();
    let currentStreak = 0;
    let cursor = new Date(`${checkinDate || dateKey()}T00:00:00`);
    while (!Number.isNaN(cursor.getTime())) {
      const key = cursor.toISOString().slice(0, 10);
      if (!dates.includes(key)) break;
      currentStreak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return {
      totalCheckins: rows.length,
      checkinDays: dates.length,
      currentStreak,
      successCount: rows.filter((row) => row.status === "success").length,
      partialCount: rows.filter((row) => row.status === "partial").length,
      failureCount: rows.filter((row) => row.status === "failure").length,
      habitCount: habits.length,
    };
  };

  return () => {
    Object.assign(target, originals);
  };
}

type ArrayRecord = Record<string, unknown>;
