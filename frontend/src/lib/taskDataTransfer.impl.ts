import { api, getCurrentWorkspace } from "@/lib/api";
import type { Task, TaskPriority, TaskReminder, TaskStatus } from "@/types";

export const TASK_BACKUP_FORMAT = "nowen-task-backup";
export const TASK_BACKUP_VERSION = 1;
export const TASK_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const TASK_IMPORT_MAX_TASKS = 5000;
export const TASK_IMPORT_MAX_PROJECTS = 500;
export const TASK_IMPORT_MAX_RELATIONS = 20000;

export type TaskTransferProgress = {
  phase: "collect" | "projects" | "tasks" | "relations" | "done";
  current: number;
  total: number;
  message: string;
};

export interface TaskBackupProject {
  sourceId: string;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskBackupTask {
  sourceId: string;
  title: string;
  description: string;
  isCompleted: number;
  priority: TaskPriority;
  dueDate: string | null;
  dueAt: string | null;
  startDate: string | null;
  /** Kept in the backup for diagnostics; imports deliberately detach source note links. */
  noteId: string | null;
  parentSourceId: string | null;
  projectSourceId: string | null;
  sortOrder: number;
  status: TaskStatus;
  createdAt?: string;
  updatedAt?: string;
  repeatRule: "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
  repeatInterval: number;
  repeatEndDate: string | null;
  repeatEndCount: number | null;
  repeatGroupId: string | null;
  repeatGeneratedFromSourceId: string | null;
  repeatRuleJson: Record<string, unknown> | null;
}

export interface TaskBackupDependency {
  predecessorSourceId: string;
  successorSourceId: string;
  type: "finish_to_start";
}

export interface TaskBackupReminder {
  taskSourceId: string;
  offsetMinutes: number;
  enabled: number;
  snoozedUntil: string | null;
}

export interface TaskBackupPackage {
  format: typeof TASK_BACKUP_FORMAT;
  version: typeof TASK_BACKUP_VERSION;
  exportedAt: string;
  source: {
    workspace: string;
    app: "nowen-note";
  };
  data: {
    projects: TaskBackupProject[];
    tasks: TaskBackupTask[];
    dependencies: TaskBackupDependency[];
    reminders: TaskBackupReminder[];
  };
}

export interface TaskImportPreview {
  format: "json" | "csv";
  fileName: string;
  projects: number;
  tasks: number;
  subtasks: number;
  completed: number;
  dependencies: number;
  reminders: number;
  warnings: string[];
  pkg: TaskBackupPackage;
}

export interface TaskImportResult {
  createdProjects: number;
  reusedProjects: number;
  createdTasks: number;
  skippedTasks: number;
  createdDependencies: number;
  skippedDependencies: number;
  createdReminders: number;
  skippedReminders: number;
  warnings: string[];
}

export type TaskImportOptions = {
  duplicateMode?: "skip" | "append";
  onProgress?: (progress: TaskTransferProgress) => void;
};

const CSV_HEADERS = [
  "id",
  "parentId",
  "title",
  "description",
  "status",
  "priority",
  "startDate",
  "dueDate",
  "dueAt",
  "project",
  "parentPath",
  "repeatRule",
  "repeatInterval",
  "repeatEndDate",
  "repeatEndCount",
  "isCompleted",
  "sortOrder",
] as const;

function normalizeText(value: unknown, maxLength: number): string {
  if (value == null) return "";
  return String(value).replace(/\u0000/g, "").slice(0, maxLength);
}

function nullableText(value: unknown, maxLength = 128): string | null {
  const normalized = normalizeText(value, maxLength).trim();
  return normalized || null;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizeStatus(value: unknown): TaskStatus {
  const raw = String(value ?? "todo").trim().toLowerCase();
  if (["done", "completed", "complete", "已完成", "完成"].includes(raw)) return "done";
  if (["doing", "in-progress", "in progress", "进行中"].includes(raw)) return "doing";
  if (["blocked", "阻塞", "已阻塞"].includes(raw)) return "blocked";
  return "todo";
}

function normalizePriority(value: unknown): TaskPriority {
  const raw = String(value ?? "2").trim().toLowerCase();
  if (raw === "3" || raw === "high" || raw === "高") return 3;
  if (raw === "1" || raw === "low" || raw === "低") return 1;
  return 2;
}

function normalizeRepeatRule(value: unknown): TaskBackupTask["repeatRule"] {
  const raw = String(value ?? "none").trim().toLowerCase();
  return ["daily", "weekly", "monthly", "yearly", "custom"].includes(raw)
    ? raw as TaskBackupTask["repeatRule"]
    : "none";
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeBooleanNumber(value: unknown): number {
  if (value === true || value === 1) return 1;
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "done", "completed", "是", "已完成"].includes(raw) ? 1 : 0;
}

function normalizeRepeatRuleJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function randomId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function parseCsvRows(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }

  if (quoted) throw new Error("CSV 存在未闭合的引号");
  row.push(field.replace(/\r$/, ""));
  if (row.some((item) => item.length > 0)) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  id: "id",
  taskid: "id",
  任务id: "id",
  parentid: "parentId",
  父任务id: "parentId",
  title: "title",
  task: "title",
  标题: "title",
  任务: "title",
  description: "description",
  描述: "description",
  备注: "description",
  status: "status",
  状态: "status",
  priority: "priority",
  优先级: "priority",
  startdate: "startDate",
  开始日期: "startDate",
  duedate: "dueDate",
  截止日期: "dueDate",
  dueat: "dueAt",
  截止时间: "dueAt",
  project: "project",
  项目: "project",
  parentpath: "parentPath",
  父任务路径: "parentPath",
  repeatrule: "repeatRule",
  循环规则: "repeatRule",
  repeatinterval: "repeatInterval",
  循环间隔: "repeatInterval",
  repeatenddate: "repeatEndDate",
  循环结束日期: "repeatEndDate",
  repeatendcount: "repeatEndCount",
  循环次数: "repeatEndCount",
  iscompleted: "isCompleted",
  已完成: "isCompleted",
  sortorder: "sortOrder",
  排序: "sortOrder",
};

function normalizeHeader(value: string): string {
  const key = value.trim().replace(/[\s_-]+/g, "").toLocaleLowerCase();
  return HEADER_ALIASES[key] || value.trim();
}

function buildTaskPathMap(tasks: Array<{ sourceId: string; parentSourceId: string | null; title: string }>): Map<string, string> {
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  const cache = new Map<string, string>();
  const resolve = (id: string, visiting = new Set<string>()): string => {
    if (cache.has(id)) return cache.get(id)!;
    const task = byId.get(id);
    if (!task) return "";
    if (visiting.has(id)) throw new Error(`任务层级存在循环引用：${task.title}`);
    visiting.add(id);
    const parentPath = task.parentSourceId ? resolve(task.parentSourceId, visiting) : "";
    visiting.delete(id);
    const path = parentPath ? `${parentPath} / ${task.title}` : task.title;
    cache.set(id, path);
    return path;
  };
  for (const task of tasks) resolve(task.sourceId);
  return cache;
}

export function buildTaskCsv(pkg: TaskBackupPackage): string {
  const normalized = normalizeTaskBackup(pkg);
  const projectNames = new Map(normalized.data.projects.map((project) => [project.sourceId, project.name]));
  const paths = buildTaskPathMap(normalized.data.tasks);
  const rows = normalized.data.tasks.map((task) => [
    task.sourceId,
    task.parentSourceId || "",
    task.title,
    task.description,
    task.status,
    task.priority,
    task.startDate || "",
    task.dueDate || "",
    task.dueAt || "",
    task.projectSourceId ? projectNames.get(task.projectSourceId) || "" : "",
    task.parentSourceId ? paths.get(task.parentSourceId) || "" : "",
    task.repeatRule,
    task.repeatInterval,
    task.repeatEndDate || "",
    task.repeatEndCount ?? "",
    task.isCompleted,
    task.sortOrder,
  ].map(csvEscape).join(","));
  return `\uFEFF${CSV_HEADERS.join(",")}\r\n${rows.join("\r\n")}`;
}

export function taskBackupFromCsv(text: string): TaskBackupPackage {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error("CSV 中没有可导入的任务");
  const headers = rows[0].map(normalizeHeader);
  if (!headers.includes("title")) throw new Error("CSV 缺少 title/标题 列");

  const projects = new Map<string, TaskBackupProject>();
  const tasks: TaskBackupTask[] = [];
  const rawParentPaths = new Map<string, string>();

  rows.slice(1).forEach((values, index) => {
    const record: Record<string, string> = {};
    headers.forEach((header, column) => { record[header] = values[column] ?? ""; });
    const title = normalizeText(record.title, 500).trim();
    if (!title) return;

    const sourceId = normalizeText(record.id, 200).trim() || `csv-task-${index + 1}`;
    const projectName = normalizeText(record.project, 200).trim();
    let projectSourceId: string | null = null;
    if (projectName) {
      projectSourceId = `csv-project-${normalizedName(projectName)}`;
      if (!projects.has(projectSourceId)) {
        projects.set(projectSourceId, {
          sourceId: projectSourceId,
          name: projectName,
          icon: "📁",
          color: "#6366f1",
          sortOrder: projects.size,
        });
      }
    }

    const status = normalizeStatus(record.status || (normalizeBooleanNumber(record.isCompleted) ? "done" : "todo"));
    const repeatRule = normalizeRepeatRule(record.repeatRule);
    tasks.push({
      sourceId,
      title,
      description: normalizeText(record.description, 50000),
      isCompleted: status === "done" || normalizeBooleanNumber(record.isCompleted) ? 1 : 0,
      priority: normalizePriority(record.priority),
      dueDate: nullableText(record.dueDate),
      dueAt: nullableText(record.dueAt),
      startDate: nullableText(record.startDate),
      noteId: null,
      parentSourceId: nullableText(record.parentId, 200),
      projectSourceId,
      sortOrder: normalizeInteger(record.sortOrder, index, -1_000_000, 1_000_000),
      status,
      repeatRule,
      repeatInterval: normalizeInteger(record.repeatInterval, 1, 1, 999),
      repeatEndDate: repeatRule === "none" ? null : nullableText(record.repeatEndDate),
      repeatEndCount: repeatRule === "none" || !record.repeatEndCount?.trim()
        ? null
        : normalizeInteger(record.repeatEndCount, 1, 1, 999),
      repeatGroupId: null,
      repeatGeneratedFromSourceId: null,
      repeatRuleJson: null,
    });
    rawParentPaths.set(sourceId, normalizeText(record.parentPath, 4000).trim());
  });

  if (tasks.length === 0) throw new Error("CSV 中没有有效标题");
  const fullPathToId = new Map<string, string>();
  for (const task of tasks) {
    const parentPath = rawParentPaths.get(task.sourceId) || "";
    const fullPath = parentPath ? `${parentPath} / ${task.title}` : task.title;
    const key = normalizedName(fullPath);
    if (!fullPathToId.has(key)) fullPathToId.set(key, task.sourceId);
  }
  for (const task of tasks) {
    if (task.parentSourceId) continue;
    const parentPath = rawParentPaths.get(task.sourceId) || "";
    if (parentPath) task.parentSourceId = fullPathToId.get(normalizedName(parentPath)) || null;
  }

  return normalizeTaskBackup({
    format: TASK_BACKUP_FORMAT,
    version: TASK_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: { workspace: getCurrentWorkspace(), app: "nowen-note" },
    data: { projects: [...projects.values()], tasks, dependencies: [], reminders: [] },
  });
}

function sanitizeProject(input: unknown, index: number): TaskBackupProject {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const name = normalizeText(row.name, 200).trim();
  if (!name) throw new Error(`第 ${index + 1} 个项目缺少名称`);
  return {
    sourceId: normalizeText(row.sourceId ?? row.id, 200).trim() || `project-${index + 1}`,
    name,
    icon: normalizeText(row.icon, 20).trim() || "📁",
    color: normalizeText(row.color, 32).trim() || "#6366f1",
    sortOrder: normalizeInteger(row.sortOrder, index, -1_000_000, 1_000_000),
    createdAt: nullableText(row.createdAt, 64) || undefined,
    updatedAt: nullableText(row.updatedAt, 64) || undefined,
  };
}

function sanitizeTask(input: unknown, index: number): TaskBackupTask {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const title = normalizeText(row.title, 500).trim();
  if (!title) throw new Error(`第 ${index + 1} 个任务缺少标题`);
  const status = normalizeStatus(row.status ?? (normalizeBooleanNumber(row.isCompleted) ? "done" : "todo"));
  const repeatRule = normalizeRepeatRule(row.repeatRule);
  return {
    sourceId: normalizeText(row.sourceId ?? row.id, 200).trim() || `task-${index + 1}`,
    title,
    description: normalizeText(row.description, 50000),
    isCompleted: status === "done" || normalizeBooleanNumber(row.isCompleted) ? 1 : 0,
    priority: normalizePriority(row.priority),
    dueDate: nullableText(row.dueDate),
    dueAt: nullableText(row.dueAt),
    startDate: nullableText(row.startDate),
    noteId: nullableText(row.noteId, 200),
    parentSourceId: nullableText(row.parentSourceId ?? row.parentId, 200),
    projectSourceId: nullableText(row.projectSourceId ?? row.projectId, 200),
    sortOrder: normalizeInteger(row.sortOrder, index, -1_000_000, 1_000_000),
    status,
    createdAt: nullableText(row.createdAt, 64) || undefined,
    updatedAt: nullableText(row.updatedAt, 64) || undefined,
    repeatRule,
    repeatInterval: normalizeInteger(row.repeatInterval, 1, 1, 999),
    repeatEndDate: repeatRule === "none" ? null : nullableText(row.repeatEndDate),
    repeatEndCount: repeatRule === "none" || row.repeatEndCount == null || row.repeatEndCount === ""
      ? null
      : normalizeInteger(row.repeatEndCount, 1, 1, 999),
    repeatGroupId: nullableText(row.repeatGroupId, 200),
    repeatGeneratedFromSourceId: nullableText(row.repeatGeneratedFromSourceId ?? row.repeatGeneratedFromId, 200),
    repeatRuleJson: normalizeRepeatRuleJson(row.repeatRuleJson),
  };
}

function validateTaskHierarchy(tasks: TaskBackupTask[]): void {
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  const completed = new Set<string>();

  for (const task of tasks) {
    if (completed.has(task.sourceId)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: TaskBackupTask | undefined = task;

    while (current && !completed.has(current.sourceId)) {
      const position = positions.get(current.sourceId);
      if (position !== undefined) {
        const cycle = path.slice(position).map((id) => byId.get(id)?.title || id).join(" → ");
        throw new Error(`任务层级存在循环引用：${cycle}`);
      }
      positions.set(current.sourceId, path.length);
      path.push(current.sourceId);
      current = current.parentSourceId ? byId.get(current.parentSourceId) : undefined;
    }
    path.forEach((id) => completed.add(id));
  }
}

export function normalizeTaskBackup(input: unknown): TaskBackupPackage {
  if (!input || typeof input !== "object") throw new Error("不是有效的待办备份文件");
  const root = input as Record<string, unknown>;
  if (root.format !== TASK_BACKUP_FORMAT) throw new Error("不支持的备份格式");
  const version = Number(root.version);
  if (!Number.isFinite(version) || version < 1 || version > TASK_BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${String(root.version)}`);
  }

  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : {};
  const rawProjects = Array.isArray(data.projects) ? data.projects : [];
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
  const rawDependencies = Array.isArray(data.dependencies) ? data.dependencies : [];
  const rawReminders = Array.isArray(data.reminders) ? data.reminders : [];
  if (rawProjects.length > TASK_IMPORT_MAX_PROJECTS) throw new Error(`项目数量超过 ${TASK_IMPORT_MAX_PROJECTS}`);
  if (rawTasks.length > TASK_IMPORT_MAX_TASKS) throw new Error(`任务数量超过 ${TASK_IMPORT_MAX_TASKS}`);
  if (rawDependencies.length > TASK_IMPORT_MAX_RELATIONS || rawReminders.length > TASK_IMPORT_MAX_RELATIONS) {
    throw new Error(`依赖或提醒数量超过 ${TASK_IMPORT_MAX_RELATIONS}`);
  }

  const projects = rawProjects.map(sanitizeProject);
  const tasks = rawTasks.map(sanitizeTask);
  const projectIds = new Set<string>();
  for (const project of projects) {
    if (projectIds.has(project.sourceId)) throw new Error(`项目 ID 重复：${project.sourceId}`);
    projectIds.add(project.sourceId);
  }
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.sourceId)) throw new Error(`任务 ID 重复：${task.sourceId}`);
    taskIds.add(task.sourceId);
  }
  validateTaskHierarchy(tasks);

  const dependencies: TaskBackupDependency[] = rawDependencies.map((value, index) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const predecessorSourceId = normalizeText(row.predecessorSourceId ?? row.predecessorTaskId, 200).trim();
    const successorSourceId = normalizeText(row.successorSourceId ?? row.successorTaskId, 200).trim();
    if (!predecessorSourceId || !successorSourceId) throw new Error(`第 ${index + 1} 条依赖缺少任务 ID`);
    return { predecessorSourceId, successorSourceId, type: "finish_to_start" };
  });

  const reminders: TaskBackupReminder[] = rawReminders.map((value, index) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const taskSourceId = normalizeText(row.taskSourceId ?? row.taskId, 200).trim();
    if (!taskSourceId) throw new Error(`第 ${index + 1} 条提醒缺少任务 ID`);
    return {
      taskSourceId,
      offsetMinutes: normalizeInteger(row.offsetMinutes, 0, -525600, 525600),
      enabled: row.enabled === undefined ? 1 : normalizeBooleanNumber(row.enabled),
      snoozedUntil: nullableText(row.snoozedUntil, 64),
    };
  });

  return {
    format: TASK_BACKUP_FORMAT,
    version: TASK_BACKUP_VERSION,
    exportedAt: nullableText(root.exportedAt, 64) || new Date().toISOString(),
    source: {
      workspace: normalizeText((root.source as Record<string, unknown> | undefined)?.workspace, 200) || "personal",
      app: "nowen-note",
    },
    data: { projects, tasks, dependencies, reminders },
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function collectTaskBackup(onProgress?: TaskImportOptions["onProgress"]): Promise<TaskBackupPackage> {
  onProgress?.({ phase: "collect", current: 0, total: 3, message: "正在读取任务、项目与依赖…" });
  const [tasks, projects, dependencies] = await Promise.all([
    api.getTasks("all"),
    api.getTaskProjects(),
    api.getTaskDependencies(),
  ]);
  onProgress?.({ phase: "collect", current: 2, total: 3, message: "正在读取任务提醒…" });

  // A backup must not silently convert a failed reminder request into an empty reminder list.
  const reminderLists = await mapWithConcurrency(tasks, 8, (task) => api.getTaskReminders(task.id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const projectIds = new Set(projects.map((project) => project.id));

  const pkg: TaskBackupPackage = {
    format: TASK_BACKUP_FORMAT,
    version: TASK_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: { workspace: getCurrentWorkspace(), app: "nowen-note" },
    data: {
      projects: projects.map((project) => ({
        sourceId: project.id,
        name: project.name,
        icon: project.icon || "📁",
        color: project.color || "#6366f1",
        sortOrder: project.sortOrder || 0,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
      tasks: tasks.map((task) => ({
        sourceId: task.id,
        title: task.title,
        description: task.description || "",
        isCompleted: task.isCompleted ? 1 : 0,
        priority: normalizePriority(task.priority),
        dueDate: task.dueDate || null,
        dueAt: task.dueAt || null,
        startDate: task.startDate || null,
        noteId: task.noteId || null,
        parentSourceId: task.parentId && taskIds.has(task.parentId) ? task.parentId : null,
        projectSourceId: task.projectId && projectIds.has(task.projectId) ? task.projectId : null,
        sortOrder: task.sortOrder || 0,
        status: normalizeStatus(task.status),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        repeatRule: normalizeRepeatRule(task.repeatRule),
        repeatInterval: normalizeInteger(task.repeatInterval, 1, 1, 999),
        repeatEndDate: task.repeatEndDate || null,
        repeatEndCount: task.repeatEndCount ?? null,
        repeatGroupId: task.repeatGroupId || null,
        repeatGeneratedFromSourceId: task.repeatGeneratedFromId && taskIds.has(task.repeatGeneratedFromId)
          ? task.repeatGeneratedFromId
          : null,
        repeatRuleJson: normalizeRepeatRuleJson(task.repeatRuleJson),
      })),
      dependencies: dependencies
        .filter((dependency) => taskIds.has(dependency.predecessorTaskId) && taskIds.has(dependency.successorTaskId))
        .map((dependency) => ({
          predecessorSourceId: dependency.predecessorTaskId,
          successorSourceId: dependency.successorTaskId,
          type: "finish_to_start",
        })),
      reminders: reminderLists.flatMap((items, index) => items.map((reminder) => ({
        taskSourceId: tasks[index].id,
        offsetMinutes: reminder.offsetMinutes,
        enabled: reminder.enabled ? 1 : 0,
        snoozedUntil: reminder.snoozedUntil || null,
      }))),
    },
  };
  onProgress?.({ phase: "done", current: 3, total: 3, message: "备份数据已准备完成" });
  return normalizeTaskBackup(pkg);
}

export function summarizeTaskBackup(pkg: TaskBackupPackage): Omit<TaskImportPreview, "format" | "fileName" | "pkg"> {
  const taskIds = new Set(pkg.data.tasks.map((task) => task.sourceId));
  const projectIds = new Set(pkg.data.projects.map((project) => project.sourceId));
  const warnings: string[] = [];
  const missingParents = pkg.data.tasks.filter((task) => task.parentSourceId && !taskIds.has(task.parentSourceId)).length;
  const missingProjects = pkg.data.tasks.filter((task) => task.projectSourceId && !projectIds.has(task.projectSourceId)).length;
  const linkedNotes = pkg.data.tasks.filter((task) => !!task.noteId).length;
  if (missingParents) warnings.push(`${missingParents} 个任务的父任务不在文件中，将作为顶级任务导入`);
  if (missingProjects) warnings.push(`${missingProjects} 个任务引用了缺失项目，将导入到“无项目”`);
  if (linkedNotes) warnings.push(`${linkedNotes} 个任务关联了源笔记；导入时将解除旧关联，避免跨空间错误链接`);
  return {
    projects: pkg.data.projects.length,
    tasks: pkg.data.tasks.length,
    subtasks: pkg.data.tasks.filter((task) => !!task.parentSourceId).length,
    completed: pkg.data.tasks.filter((task) => task.status === "done" || task.isCompleted).length,
    dependencies: pkg.data.dependencies.length,
    reminders: pkg.data.reminders.length,
    warnings,
  };
}

export async function parseTaskImportFile(file: File): Promise<TaskImportPreview> {
  if (file.size > TASK_IMPORT_MAX_FILE_BYTES) throw new Error("文件超过 10MB，无法导入");
  const text = await file.text();
  const isCsv = /\.csv$/i.test(file.name) || /csv/i.test(file.type);
  let pkg: TaskBackupPackage;
  if (isCsv) pkg = taskBackupFromCsv(text);
  else {
    try {
      pkg = normalizeTaskBackup(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("JSON 文件格式错误，无法解析");
      throw error;
    }
  }
  return { format: isCsv ? "csv" : "json", fileName: file.name, pkg, ...summarizeTaskBackup(pkg) };
}

export function createTaskImportSignature(input: {
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  dueAt?: string | null;
  projectName?: string | null;
  parentPath?: string | null;
}): string {
  return [
    normalizedName(input.title || ""),
    normalizeText(input.description, 50000).trim(),
    normalizeStatus(input.status),
    normalizePriority(input.priority),
    input.startDate || "",
    input.dueDate || "",
    input.dueAt || "",
    normalizedName(input.projectName || ""),
    normalizedName(input.parentPath || ""),
  ].join("\u001f");
}

function taskPathForRuntime(taskId: string, tasks: Task[], cache: Map<string, string>, visiting = new Set<string>()): string {
  if (cache.has(taskId)) return cache.get(taskId)!;
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return "";
  if (visiting.has(taskId)) return task.title;
  visiting.add(taskId);
  const parent = task.parentId ? taskPathForRuntime(task.parentId, tasks, cache, visiting) : "";
  visiting.delete(taskId);
  const path = parent ? `${parent} / ${task.title}` : task.title;
  cache.set(taskId, path);
  return path;
}

function orderedSourceTasks(tasks: TaskBackupTask[]): TaskBackupTask[] {
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  const emitted = new Set<string>();
  const ordered: TaskBackupTask[] = [];
  const visit = (task: TaskBackupTask) => {
    if (emitted.has(task.sourceId)) return;
    const parent = task.parentSourceId ? byId.get(task.parentSourceId) : undefined;
    if (parent) visit(parent);
    emitted.add(task.sourceId);
    ordered.push(task);
  };
  [...tasks]
    .sort((a, b) => a.sortOrder - b.sortOrder || String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .forEach(visit);
  return ordered;
}

function importedParentPath(task: TaskBackupTask, byId: Map<string, TaskBackupTask>, cache: Map<string, string>): string {
  if (!task.parentSourceId) return "";
  if (cache.has(task.parentSourceId)) return cache.get(task.parentSourceId)!;
  const parent = byId.get(task.parentSourceId);
  if (!parent) return "";
  const ancestor = importedParentPath(parent, byId, cache);
  const path = ancestor ? `${ancestor} / ${parent.title}` : parent.title;
  cache.set(parent.sourceId, path);
  return path;
}

async function rollbackImport(created: {
  dependencies: string[];
  reminders: string[];
  tasks: string[];
  projects: string[];
}): Promise<void> {
  for (const id of [...created.dependencies].reverse()) await api.deleteTaskDependency(id).catch(() => undefined);
  for (const id of [...created.reminders].reverse()) await api.deleteTaskReminder(id).catch(() => undefined);
  for (const id of [...created.tasks].reverse()) await api.deleteTask(id).catch(() => undefined);
  for (const id of [...created.projects].reverse()) await api.deleteTaskProject(id).catch(() => undefined);
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export async function importTaskBackup(rawPackage: TaskBackupPackage, options: TaskImportOptions = {}): Promise<TaskImportResult> {
  const pkg = normalizeTaskBackup(rawPackage);
  const duplicateMode = options.duplicateMode || "skip";
  const warnings = [...summarizeTaskBackup(pkg).warnings];
  const result: TaskImportResult = {
    createdProjects: 0,
    reusedProjects: 0,
    createdTasks: 0,
    skippedTasks: 0,
    createdDependencies: 0,
    skippedDependencies: 0,
    createdReminders: 0,
    skippedReminders: 0,
    warnings,
  };
  const created = { dependencies: [] as string[], reminders: [] as string[], tasks: [] as string[], projects: [] as string[] };

  try {
    const [existingTasks, existingProjects, existingDependencies] = await Promise.all([
      api.getTasks("all"),
      api.getTaskProjects(),
      api.getTaskDependencies(),
    ]);

    options.onProgress?.({ phase: "projects", current: 0, total: pkg.data.projects.length, message: "正在合并项目…" });
    const projectIdMap = new Map<string, string>();
    const projectsByName = new Map(existingProjects.map((project) => [normalizedName(project.name), project]));
    const projectNameById = new Map(existingProjects.map((project) => [project.id, project.name]));

    for (let index = 0; index < pkg.data.projects.length; index += 1) {
      const project = pkg.data.projects[index];
      const existing = projectsByName.get(normalizedName(project.name));
      if (existing) {
        projectIdMap.set(project.sourceId, existing.id);
        result.reusedProjects += 1;
      } else {
        let createdProject = await api.createTaskProject({ name: project.name, icon: project.icon, color: project.color });
        created.projects.push(createdProject.id);
        if (createdProject.sortOrder !== project.sortOrder) {
          try {
            createdProject = await api.updateTaskProject(createdProject.id, { sortOrder: project.sortOrder });
          } catch {
            warnings.push(`项目“${project.name}”已导入，但排序位置未能恢复`);
          }
        }
        projectIdMap.set(project.sourceId, createdProject.id);
        projectsByName.set(normalizedName(project.name), createdProject);
        projectNameById.set(createdProject.id, project.name);
        result.createdProjects += 1;
      }
      options.onProgress?.({ phase: "projects", current: index + 1, total: pkg.data.projects.length, message: `正在合并项目 ${index + 1}/${pkg.data.projects.length}` });
    }
    for (const project of pkg.data.projects) {
      const targetId = projectIdMap.get(project.sourceId);
      if (targetId) projectNameById.set(targetId, project.name);
    }

    const taskBySourceId = new Map(pkg.data.tasks.map((task) => [task.sourceId, task]));
    const orderedTasks = orderedSourceTasks(pkg.data.tasks);
    const sourceToTargetTaskId = new Map<string, string>();
    const runtimePathCache = new Map<string, string>();
    const existingSignatureMap = new Map<string, string>();

    for (const task of existingTasks) {
      const parentPath = task.parentId ? taskPathForRuntime(task.parentId, existingTasks, runtimePathCache) : "";
      const signature = createTaskImportSignature({
        ...task,
        projectName: task.projectId ? projectNameById.get(task.projectId) || "" : "",
        parentPath,
      });
      if (!existingSignatureMap.has(signature)) existingSignatureMap.set(signature, task.id);
    }

    const repeatGroupMap = new Map<string, string>();
    const importedPathCache = new Map<string, string>();
    options.onProgress?.({ phase: "tasks", current: 0, total: orderedTasks.length, message: "正在导入任务…" });

    for (let index = 0; index < orderedTasks.length; index += 1) {
      const task = orderedTasks[index];
      const parentId = task.parentSourceId ? sourceToTargetTaskId.get(task.parentSourceId) || null : null;
      if (task.parentSourceId && !parentId) warnings.push(`“${task.title}”的父任务缺失，已作为顶级任务导入`);
      const projectId = task.projectSourceId ? projectIdMap.get(task.projectSourceId) || null : null;
      const projectName = projectId ? projectNameById.get(projectId) || "" : "";
      const parentPath = importedParentPath(task, taskBySourceId, importedPathCache);
      const signature = createTaskImportSignature({ ...task, projectName, parentPath });

      if (duplicateMode === "skip" && existingSignatureMap.has(signature)) {
        sourceToTargetTaskId.set(task.sourceId, existingSignatureMap.get(signature)!);
        result.skippedTasks += 1;
        options.onProgress?.({ phase: "tasks", current: index + 1, total: orderedTasks.length, message: `正在检查任务 ${index + 1}/${orderedTasks.length}` });
        continue;
      }

      let repeatRule = task.repeatRule;
      let repeatRuleJson = task.repeatRuleJson;
      if (repeatRule !== "none" && !task.dueDate && !task.dueAt) {
        warnings.push(`“${task.title}”缺少截止日期，循环规则已降级为不循环`);
        repeatRule = "none";
        repeatRuleJson = null;
      }
      if (repeatRule === "custom" && !repeatRuleJson) {
        warnings.push(`“${task.title}”的自定义循环规则无效，已降级为不循环`);
        repeatRule = "none";
      }

      let repeatGroupId: string | null = null;
      if (task.repeatGroupId) {
        if (!repeatGroupMap.has(task.repeatGroupId)) repeatGroupMap.set(task.repeatGroupId, randomId("repeat"));
        repeatGroupId = repeatGroupMap.get(task.repeatGroupId)!;
      }
      const repeatGeneratedFromId = task.repeatGeneratedFromSourceId
        ? sourceToTargetTaskId.get(task.repeatGeneratedFromSourceId) || null
        : null;
      if (task.repeatGeneratedFromSourceId && !repeatGeneratedFromId) {
        warnings.push(`“${task.title}”的循环来源尚未创建，来源关联未恢复`);
      }

      const createdTask = await api.createTask({
        title: task.title,
        description: task.description,
        status: task.status,
        isCompleted: task.status === "done" || task.isCompleted ? 1 : 0,
        priority: task.priority,
        dueDate: task.dueDate,
        dueAt: task.dueAt,
        startDate: task.startDate,
        // Source note IDs are scoped to another database/workspace and may violate the FK.
        noteId: null,
        parentId,
        projectId,
        sortOrder: task.sortOrder,
        repeatRule,
        repeatInterval: task.repeatInterval,
        repeatEndDate: repeatRule === "none" ? null : task.repeatEndDate,
        repeatEndCount: repeatRule === "none" ? null : task.repeatEndCount,
        repeatGroupId,
        repeatGeneratedFromId,
        repeatRuleJson: repeatRule === "custom" ? repeatRuleJson : null,
      } as Partial<Task>);
      sourceToTargetTaskId.set(task.sourceId, createdTask.id);
      created.tasks.push(createdTask.id);
      result.createdTasks += 1;
      existingTasks.push(createdTask);
      existingSignatureMap.set(signature, createdTask.id);
      options.onProgress?.({ phase: "tasks", current: index + 1, total: orderedTasks.length, message: `正在导入任务 ${index + 1}/${orderedTasks.length}` });
    }

    // Never reorder pre-existing tasks that were only matched as duplicates.
    const createdTaskIds = new Set(created.tasks);
    const reorderGroups = new Map<string, Map<string, number>>();
    for (const task of pkg.data.tasks) {
      const id = sourceToTargetTaskId.get(task.sourceId);
      if (!id || !createdTaskIds.has(id)) continue;
      const parentId = task.parentSourceId ? sourceToTargetTaskId.get(task.parentSourceId) || "" : "";
      const key = parentId || "__root__";
      const group = reorderGroups.get(key) || new Map<string, number>();
      group.set(id, task.sortOrder);
      reorderGroups.set(key, group);
    }
    for (const group of reorderGroups.values()) {
      const items = [...group.entries()]
        .map(([id, sortOrder]) => ({ id, sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      for (const batch of chunks(items, 200)) {
        await api.reorderTasks(batch).catch(() => undefined);
      }
    }

    const relationTotal = pkg.data.dependencies.length + pkg.data.reminders.length;
    let relationCurrent = 0;
    options.onProgress?.({ phase: "relations", current: 0, total: relationTotal, message: "正在恢复依赖与提醒…" });
    const existingDependencyKeys = new Set(existingDependencies.map((dependency) => `${dependency.predecessorTaskId}\u001f${dependency.successorTaskId}`));

    for (const dependency of pkg.data.dependencies) {
      const predecessorTaskId = sourceToTargetTaskId.get(dependency.predecessorSourceId);
      const successorTaskId = sourceToTargetTaskId.get(dependency.successorSourceId);
      relationCurrent += 1;
      if (!predecessorTaskId || !successorTaskId || predecessorTaskId === successorTaskId) {
        result.skippedDependencies += 1;
        continue;
      }
      const key = `${predecessorTaskId}\u001f${successorTaskId}`;
      if (existingDependencyKeys.has(key)) {
        result.skippedDependencies += 1;
        continue;
      }
      const createdDependency = await api.createTaskDependency({ predecessorTaskId, successorTaskId, type: "finish_to_start" });
      created.dependencies.push(createdDependency.id);
      existingDependencyKeys.add(key);
      result.createdDependencies += 1;
      options.onProgress?.({ phase: "relations", current: relationCurrent, total: relationTotal, message: `正在恢复关联 ${relationCurrent}/${relationTotal}` });
    }

    const reminderCache = new Map<string, TaskReminder[]>();
    for (const reminder of pkg.data.reminders) {
      relationCurrent += 1;
      const taskId = sourceToTargetTaskId.get(reminder.taskSourceId);
      if (!taskId) {
        result.skippedReminders += 1;
        continue;
      }
      if (!reminderCache.has(taskId)) reminderCache.set(taskId, await api.getTaskReminders(taskId));
      const existing = reminderCache.get(taskId)!;
      if (existing.some((item) => item.offsetMinutes === reminder.offsetMinutes)) {
        result.skippedReminders += 1;
        continue;
      }
      let createdReminder = await api.createTaskReminder(taskId, reminder.offsetMinutes);
      created.reminders.push(createdReminder.id);
      if (!reminder.enabled || reminder.snoozedUntil) {
        createdReminder = await api.updateTaskReminder(createdReminder.id, {
          enabled: !!reminder.enabled,
          snoozedUntil: reminder.snoozedUntil,
        });
      }
      existing.push(createdReminder);
      result.createdReminders += 1;
      options.onProgress?.({ phase: "relations", current: relationCurrent, total: relationTotal, message: `正在恢复关联 ${relationCurrent}/${relationTotal}` });
    }

    result.warnings = [...new Set(warnings)].slice(0, 50);
    options.onProgress?.({ phase: "done", current: 1, total: 1, message: "导入完成" });
    return result;
  } catch (error) {
    await rollbackImport(created);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`导入失败，本次新建数据已尽量回滚：${message}`);
  }
}

function isMobileRuntime(): boolean {
  return typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function saveTaskTransferFile(content: string, filename: string, mimeType: string): Promise<void> {
  const blob = new Blob([content], { type: mimeType });
  if (isMobileRuntime() && typeof File !== "undefined" && typeof navigator.share === "function") {
    const file = new File([blob], filename, { type: mimeType });
    try {
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function taskBackupFilename(extension: "json" | "csv", date = new Date()): string {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("");
  return `nowen-tasks-${stamp}.${extension}`;
}
