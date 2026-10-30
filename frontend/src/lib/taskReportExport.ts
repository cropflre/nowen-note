import { api } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { buildTaskTree, calculateTaskProgress } from "@/components/tasks/taskProgress";
import { createTableXlsx, XLSX_MIME } from "@/lib/sheetXlsx";
import { sheetCellKey, type SheetDataModel } from "@/lib/sheetModel";
import { saveTaskTransferBlob } from "@/lib/taskDataTransferArchive";
import { taskBackupFilename } from "@/lib/taskDataTransfer";
import { isAndroidNative, saveBlobToSystemFile } from "@/lib/nativeImageSave";
import type { Task, TaskProject } from "@/types";

type Translate = (key: string) => string;
const FIELDS = ["id", "parentId", "path", "project", "title", "status", "progress", "completedChildren", "totalChildren", "description", "priority", "startDate", "dueDate", "dueAt", "completedAt", "archivedAt"] as const;
type ReportRow = Record<typeof FIELDS[number], string | number> & { depth: number; completed: boolean };

export function taskReportRows(tasks: Task[], projects: TaskProject[], t: Translate): ReportRow[] {
  const names = new Map(projects.map(project => [project.id, project.name]));
  const rows: ReportRow[] = [];
  const visit = (nodes: ReturnType<typeof buildTaskTree>, parentPath: string, depth: number) => {
    for (const node of nodes) {
      const progress = calculateTaskProgress(node);
      const path = parentPath ? `${parentPath} / ${node.title}` : node.title;
      rows.push({
        id: node.id, parentId: node.parentId || "", path, depth, title: node.title,
        project: names.get(node.projectId || "") || "",
        status: t(node.archivedAt ? "tasks.lifecycle.archived" : ({ todo: "tasks.statusTodo", doing: "tasks.statusDoing", blocked: "tasks.statusBlocked", done: "tasks.statusDone" })[node.isCompleted ? "done" : node.status]),
        completed: node.isCompleted === 1,
        progress: progress.progress, completedChildren: progress.completedChildren, totalChildren: progress.totalChildren,
        description: node.description || "", priority: t(({ 1: "tasks.low", 2: "tasks.medium", 3: "tasks.high" })[node.priority]),
        startDate: node.startDate || "", dueDate: node.dueDate || "", dueAt: node.dueAt || "",
        completedAt: node.completedAt || "", archivedAt: node.archivedAt || "",
      });
      visit(node.children, path, depth + 1);
    }
  };
  visit(buildTaskTree(tasks), "", 0);
  return rows;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

export function buildTaskMarkdown(tasks: Task[], projects: TaskProject[], t: Translate, subtree = false): string {
  const rows = taskReportRows(tasks, projects, t);
  const lines = [`# ${t("tasks.report.title")}`, "", t(subtree ? "tasks.report.subtreeScope" : "tasks.report.scope"), ""];
  for (const row of rows) {
    const indent = "  ".repeat(row.depth);
    lines.push(`${indent}- [${row.completed ? "x" : " "}] **${escapeMarkdown(String(row.title))}**`);
    for (const field of ["status", "progress", "project", "priority", "startDate", "dueDate", "dueAt", "completedAt", "archivedAt"] as const) {
      if (row[field] !== "") lines.push(`${indent}  ${t(`tasks.report.fields.${field}`)}: ${escapeMarkdown(String(row[field]))}${field === "progress" ? "%" : ""}  `);
    }
    if (row.totalChildren) lines.push(`${indent}  ${t("tasks.report.fields.completedChildren")}: ${row.completedChildren}/${row.totalChildren}  `);
    if (row.description) {
      lines.push("", `${indent}  **${t("tasks.report.fields.description")}**`, "");
      lines.push(...String(row.description).split(/\r?\n/).map(line => `${indent}  ${line}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function buildTaskExcel(tasks: Task[], projects: TaskProject[], t: Translate): Promise<Blob> {
  const rows = taskReportRows(tasks, projects, t);
  // Excel cannot store more than 32767 characters in a cell. Never silently trim a description.
  if (rows.some(row => FIELDS.some(field => String(row[field]).length > 32767))) {
    throw new Error(t("tasks.report.excelCellLimit"));
  }
  const data: SheetDataModel = {
    version: 1,
    rows: rows.map((_, index) => ({ id: `r${index}`, height: 40 })),
    columns: FIELDS.map(field => ({ id: field, title: t(`tasks.report.fields.${field}`), width: field === "description" ? 420 : 160, type: ["progress", "completedChildren", "totalChildren"].includes(field) ? "number" : "text", align: "left" })),
    cells: {},
  };
  rows.forEach((row, index) => FIELDS.forEach(field => { data.cells[sheetCellKey(`r${index}`, field)] = String(row[field]); }));
  return new Blob([await createTableXlsx(data, t("tasks.report.title"))], { type: XLSX_MIME });
}

export async function exportTaskReport(format: "xlsx" | "md", t: Translate, taskId?: string): Promise<void> {
  const scope = getOfflineQueueStorageKey();
  const [tasks, projects] = await Promise.all([api.getTasks("history"), api.getTaskProjects()]);
  if (scope !== getOfflineQueueStorageKey()) throw new Error(t("tasks.lifecycle.scopeChanged"));
  let reportTasks = tasks;
  if (taskId) {
    if (!tasks.some(task => task.id === taskId)) throw new Error(t("tasks.report.taskUnavailable"));
    const ids = new Set([taskId]);
    const children = new Map<string, string[]>();
    tasks.forEach(task => {
      if (task.parentId) children.set(task.parentId, [...(children.get(task.parentId) || []), task.id]);
    });
    // Read the full subtree, including collapsed, completed and archived descendants.
    for (const id of ids) for (const child of children.get(id) || []) ids.add(child);
    reportTasks = tasks.filter(task => ids.has(task.id));
  }
  const blob = format === "xlsx" ? await buildTaskExcel(reportTasks, projects, t)
    : new Blob([buildTaskMarkdown(reportTasks, projects, t, !!taskId)], { type: "text/markdown;charset=utf-8" });
  if (scope !== getOfflineQueueStorageKey()) throw new Error(t("tasks.lifecycle.scopeChanged"));
  const filename = taskId ? taskBackupFilename(format).replace("nowen-tasks-", `nowen-task-${taskId.replace(/[^\w-]/g, "_")}-`) : taskBackupFilename(format);
  if (isAndroidNative()) {
    await saveBlobToSystemFile({ blob, fileName: filename, mimeType: blob.type.split(";")[0] });
  } else {
    await saveTaskTransferBlob(blob, filename);
  }
}
