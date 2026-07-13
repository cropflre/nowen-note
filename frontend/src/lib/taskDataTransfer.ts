export * from "./taskDataTransfer.impl";

import { api } from "@/lib/api";
import type { Task } from "@/types";
import {
  TASK_BACKUP_FORMAT,
  TASK_IMPORT_MAX_FILE_BYTES,
  buildTaskCsv as buildTaskCsvImpl,
  collectTaskBackup as collectTaskBackupImpl,
  createTaskImportSignature,
  importTaskBackup as importTaskBackupImpl,
  normalizeTaskBackup as normalizeTaskBackupImpl,
  parseCsvRows,
  summarizeTaskBackup as summarizeTaskBackupImpl,
  taskBackupFromCsv as taskBackupFromCsvImpl,
  type TaskBackupPackage as BaseTaskBackupPackage,
  type TaskBackupTask as BaseTaskBackupTask,
  type TaskImportOptions,
  type TaskImportPreview as BaseTaskImportPreview,
  type TaskImportResult,
} from "./taskDataTransfer.impl";

export const TASK_BACKUP_VERSION = 2;

export type TaskBackupTask = BaseTaskBackupTask & {
  completedAt?: string | null;
};

export type TaskBackupPackage = Omit<BaseTaskBackupPackage, "version" | "data"> & {
  version: typeof TASK_BACKUP_VERSION;
  data: Omit<BaseTaskBackupPackage["data"], "tasks"> & {
    tasks: TaskBackupTask[];
  };
};

export type TaskImportPreview = Omit<BaseTaskImportPreview, "pkg"> & {
  pkg: TaskBackupPackage;
};

function normalizeCompletedAt(value: unknown, completed: boolean): string | null {
  if (!completed || typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function rawTasksFrom(input: unknown): Array<Record<string, unknown>> {
  if (!input || typeof input !== "object") return [];
  const data = (input as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return [];
  const tasks = (data as Record<string, unknown>).tasks;
  return Array.isArray(tasks)
    ? tasks.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

function attachCompletedAt(
  base: BaseTaskBackupPackage,
  rawInput: unknown,
): TaskBackupPackage {
  const rawTasks = rawTasksFrom(rawInput);
  const bySourceId = new Map<string, Record<string, unknown>>();
  rawTasks.forEach((row) => {
    const id = String(row.sourceId ?? row.id ?? "").trim();
    if (id && !bySourceId.has(id)) bySourceId.set(id, row);
  });

  const tasks = base.data.tasks.map((task, index) => {
    const raw = bySourceId.get(task.sourceId) || rawTasks[index] || {};
    const completed = task.status === "done" || !!task.isCompleted;
    return {
      ...task,
      completedAt: normalizeCompletedAt(raw.completedAt, completed),
    };
  });

  return {
    ...base,
    version: TASK_BACKUP_VERSION,
    data: { ...base.data, tasks },
  } as TaskBackupPackage;
}

export function normalizeTaskBackup(input: unknown): TaskBackupPackage {
  if (!input || typeof input !== "object") {
    throw new Error("不是有效的待办备份文件");
  }
  const root = input as Record<string, unknown>;
  const version = Number(root.version);
  if (!Number.isFinite(version) || version < 1 || version > TASK_BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${String(root.version)}`);
  }
  // The historical implementation validates the stable v1 shape. completedAt is
  // optional and backwards compatible, so validate through v1 then reattach it.
  const base = normalizeTaskBackupImpl({ ...root, version: 1 });
  return attachCompletedAt(base, input);
}

export async function collectTaskBackup(
  onProgress?: TaskImportOptions["onProgress"],
): Promise<TaskBackupPackage> {
  const [base, tasks] = await Promise.all([
    collectTaskBackupImpl(onProgress),
    api.getTasks("all"),
  ]);
  const completedAtById = new Map(tasks.map((task) => [task.id, task.completedAt || null]));
  return normalizeTaskBackup({
    ...base,
    version: TASK_BACKUP_VERSION,
    data: {
      ...base.data,
      tasks: base.data.tasks.map((task) => ({
        ...task,
        completedAt: completedAtById.get(task.sourceId) || null,
      })),
    },
  });
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildPathMap(tasks: TaskBackupTask[]): Map<string, string> {
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  const cache = new Map<string, string>();
  const resolve = (id: string, visiting = new Set<string>()): string => {
    if (cache.has(id)) return cache.get(id)!;
    const task = byId.get(id);
    if (!task) return "";
    if (visiting.has(id)) return task.title;
    visiting.add(id);
    const parentPath = task.parentSourceId ? resolve(task.parentSourceId, visiting) : "";
    visiting.delete(id);
    const path = parentPath ? `${parentPath} / ${task.title}` : task.title;
    cache.set(id, path);
    return path;
  };
  tasks.forEach((task) => resolve(task.sourceId));
  return cache;
}

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
  "completedAt",
  "project",
  "parentPath",
  "repeatRule",
  "repeatInterval",
  "repeatEndDate",
  "repeatEndCount",
  "isCompleted",
  "sortOrder",
] as const;

export function buildTaskCsv(pkg: TaskBackupPackage): string {
  const normalized = normalizeTaskBackup(pkg);
  const projectNames = new Map(
    normalized.data.projects.map((project) => [project.sourceId, project.name]),
  );
  const paths = buildPathMap(normalized.data.tasks);
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
    task.completedAt || "",
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
  const base = taskBackupFromCsvImpl(text);
  const rows = parseCsvRows(text);
  const headers = rows[0]?.map((value) => value.trim().replace(/[\s_-]+/g, "").toLowerCase()) || [];
  const completedAtIndex = headers.findIndex((value) =>
    value === "completedat" || value === "completiontime" || value === "完成时间"
  );
  if (completedAtIndex < 0) return normalizeTaskBackup(base);

  const idIndex = headers.findIndex((value) => value === "id" || value === "任务id");
  const completedById = new Map<string, string>();
  const completedByOrder: string[] = [];
  for (const values of rows.slice(1)) {
    const value = values[completedAtIndex] || "";
    completedByOrder.push(value);
    if (idIndex >= 0 && values[idIndex]) completedById.set(values[idIndex], value);
  }
  return normalizeTaskBackup({
    ...base,
    version: TASK_BACKUP_VERSION,
    data: {
      ...base.data,
      tasks: base.data.tasks.map((task, index) => ({
        ...task,
        completedAt: completedById.get(task.sourceId) ?? completedByOrder[index] ?? null,
      })),
    },
  });
}

export function summarizeTaskBackup(pkg: TaskBackupPackage): ReturnType<typeof summarizeTaskBackupImpl> {
  return summarizeTaskBackupImpl({ ...pkg, version: 1 } as unknown as BaseTaskBackupPackage);
}

export async function parseTaskImportFile(file: File): Promise<TaskImportPreview> {
  if (file.size > TASK_IMPORT_MAX_FILE_BYTES) throw new Error("文件超过 10MB，无法导入");
  const text = await file.text();
  const isCsv = /\.csv$/i.test(file.name) || /csv/i.test(file.type);
  let pkg: TaskBackupPackage;
  if (isCsv) {
    pkg = taskBackupFromCsv(text);
  } else {
    try {
      pkg = normalizeTaskBackup(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("JSON 文件格式错误，无法解析");
      throw error;
    }
  }
  return {
    format: isCsv ? "csv" : "json",
    fileName: file.name,
    pkg,
    ...summarizeTaskBackup(pkg),
  };
}

function importMatchKey(input: Partial<Task> | TaskBackupTask): string {
  return [
    String(input.title || "").trim(),
    String(input.description || ""),
    String(input.status || "todo"),
    Number(input.priority || 2),
    input.startDate || "",
    input.dueDate || "",
    input.dueAt || "",
    Number(input.sortOrder || 0),
  ].join("\u001f");
}

export async function importTaskBackup(
  rawPackage: TaskBackupPackage,
  options: TaskImportOptions = {},
): Promise<TaskImportResult> {
  const pkg = normalizeTaskBackup(rawPackage);
  const queues = new Map<string, TaskBackupTask[]>();
  for (const task of pkg.data.tasks) {
    const key = importMatchKey(task);
    const queue = queues.get(key) || [];
    queue.push(task);
    queues.set(key, queue);
  }

  const nativeCreateTask = api.createTask;
  api.createTask = (async (data: Partial<Task>) => {
    const queue = queues.get(importMatchKey(data));
    const source = queue?.shift();
    return nativeCreateTask({
      ...data,
      completedAt: source?.completedAt || null,
    });
  }) as typeof api.createTask;

  try {
    return await importTaskBackupImpl(
      { ...pkg, version: 1 } as unknown as BaseTaskBackupPackage,
      options,
    );
  } finally {
    api.createTask = nativeCreateTask;
  }
}

// Keep direct callers working while avoiding accidental use of the old CSV builder.
void buildTaskCsvImpl;
void createTaskImportSignature;
