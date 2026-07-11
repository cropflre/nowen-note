import JSZip from "jszip";
import { api } from "@/lib/api";
import type { Task } from "@/types";
import {
  collectTaskBackup,
  createTaskImportSignature,
  importTaskBackup,
  normalizeTaskBackup,
  parseTaskImportFile,
  summarizeTaskBackup,
  type TaskBackupPackage,
  type TaskBackupTask,
  type TaskImportOptions,
  type TaskImportPreview,
  type TaskImportResult,
  type TaskTransferProgress,
} from "@/lib/taskDataTransfer";

export const TASK_ARCHIVE_FORMAT = "nowen-task-archive";
export const TASK_ARCHIVE_VERSION = 1;
export const TASK_ARCHIVE_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const TASK_ARCHIVE_MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const TASK_ARCHIVE_MAX_ATTACHMENTS = 5000;

export interface TaskArchiveAttachment {
  sourceAttachmentId: string;
  taskSourceId: string;
  originalUrl: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
}

interface TaskArchiveManifest {
  format: typeof TASK_ARCHIVE_FORMAT;
  version: typeof TASK_ARCHIVE_VERSION;
  exportedAt: string;
  backup: TaskBackupPackage;
  attachments: TaskArchiveAttachment[];
}

export interface TaskArchivePreview extends Omit<TaskImportPreview, "format"> {
  format: "zip";
  attachments: number;
  attachmentBytes: number;
  archive: {
    zip: JSZip;
    manifest: TaskArchiveManifest;
  };
}

export type AnyTaskImportPreview = TaskImportPreview | TaskArchivePreview;

export interface TaskArchiveImportResult extends TaskImportResult {
  importedAttachments: number;
  skippedAttachments: number;
}

type AttachmentReference = {
  sourceAttachmentId: string;
  taskSourceId: string;
  originalUrl: string;
  filename: string;
};

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const TASK_ATTACHMENT_URL_RE = /(?:https?:\/\/[^/\s)]+)?\/api\/task-attachments\/([A-Za-z0-9_-]+)/i;

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return normalized || fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function extractTaskAttachmentReferences(
  tasks: Array<Pick<TaskBackupTask, "sourceId" | "title" | "description">>,
): AttachmentReference[] {
  const references: AttachmentReference[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    for (const text of [task.title || "", task.description || ""]) {
      MARKDOWN_IMAGE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MARKDOWN_IMAGE_RE.exec(text)) !== null) {
        const originalUrl = match[2];
        const attachmentMatch = originalUrl.match(TASK_ATTACHMENT_URL_RE);
        if (!attachmentMatch) continue;
        const sourceAttachmentId = attachmentMatch[1];
        const key = `${task.sourceId}\u001f${sourceAttachmentId}\u001f${originalUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({
          sourceAttachmentId,
          taskSourceId: task.sourceId,
          originalUrl,
          filename: safeSegment(match[1], `task-image-${sourceAttachmentId}`),
        });
      }
    }
  }

  return references;
}

export function replaceTaskAttachmentReference(
  text: string,
  attachment: Pick<TaskArchiveAttachment, "sourceAttachmentId" | "originalUrl">,
  nextUrl: string,
): { value: string; changed: boolean } {
  if (!text) return { value: text, changed: false };

  let value = text;
  if (attachment.originalUrl && value.includes(attachment.originalUrl)) {
    value = value.split(attachment.originalUrl).join(nextUrl);
  }

  const id = escapeRegExp(attachment.sourceAttachmentId);
  const urlPattern = new RegExp(
    `(?:https?:\\/\\/[^/\\s)]+)?\\/api\\/task-attachments\\/${id}(?:\\?[^)\\s]*)?`,
    "g",
  );
  value = value.replace(urlPattern, nextUrl);
  return { value, changed: value !== text };
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

function buildSourcePathMap(tasks: TaskBackupTask[]): Map<string, string> {
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  const cache = new Map<string, string>();

  const resolve = (id: string): string => {
    if (cache.has(id)) return cache.get(id)!;
    const task = byId.get(id);
    if (!task) return "";
    const parentPath = task.parentSourceId ? resolve(task.parentSourceId) : "";
    const path = parentPath ? `${parentPath} / ${task.title}` : task.title;
    cache.set(id, path);
    return path;
  };

  for (const task of tasks) resolve(task.sourceId);
  return cache;
}

function buildRuntimePathMap(tasks: Task[]): Map<string, string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cache = new Map<string, string>();

  const resolve = (id: string, visiting = new Set<string>()): string => {
    if (cache.has(id)) return cache.get(id)!;
    const task = byId.get(id);
    if (!task) return "";
    if (visiting.has(id)) return task.title;
    visiting.add(id);
    const parentPath = task.parentId ? resolve(task.parentId, visiting) : "";
    visiting.delete(id);
    const path = parentPath ? `${parentPath} / ${task.title}` : task.title;
    cache.set(id, path);
    return path;
  };

  for (const task of tasks) resolve(task.id);
  return cache;
}

function mapNewTasksToSource(
  pkg: TaskBackupPackage,
  beforeTasks: Task[],
  afterTasks: Task[],
  projects: Array<{ id: string; name: string }>,
): Map<string, Task> {
  const beforeIds = new Set(beforeTasks.map((task) => task.id));
  const newTasks = afterTasks.filter((task) => !beforeIds.has(task.id));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const runtimePaths = buildRuntimePathMap(afterTasks);
  const sourcePaths = buildSourcePathMap(pkg.data.tasks);
  const sourceProjectNames = new Map(pkg.data.projects.map((project) => [project.sourceId, project.name]));

  const targetsBySignature = new Map<string, Task[]>();
  for (const task of newTasks) {
    const signature = createTaskImportSignature({
      ...task,
      projectName: task.projectId ? projectNames.get(task.projectId) || "" : "",
      parentPath: task.parentId ? runtimePaths.get(task.parentId) || "" : "",
    });
    const items = targetsBySignature.get(signature) || [];
    items.push(task);
    targetsBySignature.set(signature, items);
  }
  for (const items of targetsBySignature.values()) {
    items.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.id.localeCompare(b.id));
  }

  const mapping = new Map<string, Task>();
  for (const sourceTask of orderedSourceTasks(pkg.data.tasks)) {
    const signature = createTaskImportSignature({
      ...sourceTask,
      projectName: sourceTask.projectSourceId ? sourceProjectNames.get(sourceTask.projectSourceId) || "" : "",
      parentPath: sourceTask.parentSourceId ? sourcePaths.get(sourceTask.parentSourceId) || "" : "",
    });
    const candidates = targetsBySignature.get(signature);
    const target = candidates?.shift();
    if (target) mapping.set(sourceTask.sourceId, target);
  }

  return mapping;
}

async function fetchTaskAttachment(reference: AttachmentReference): Promise<{
  blob: Blob;
  mimeType: string;
  filename: string;
}> {
  const response = await fetch(api.taskAttachments.urlFor(reference.sourceAttachmentId), {
    method: "GET",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`图片“${reference.filename}”下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  if (blob.size > 50 * 1024 * 1024) {
    throw new Error(`图片“${reference.filename}”超过单图 50MB 限制`);
  }
  return {
    blob,
    mimeType: blob.type || response.headers.get("Content-Type") || "application/octet-stream",
    filename: reference.filename,
  };
}

export async function buildTaskArchive(
  onProgress?: (progress: TaskTransferProgress) => void,
): Promise<{ blob: Blob; filename: string; attachmentCount: number; attachmentBytes: number }> {
  const pkg = await collectTaskBackup(onProgress);
  const references = extractTaskAttachmentReferences(pkg.data.tasks);
  if (references.length > TASK_ARCHIVE_MAX_ATTACHMENTS) {
    throw new Error(`任务图片超过 ${TASK_ARCHIVE_MAX_ATTACHMENTS} 张，无法生成完整备份`);
  }

  const zip = new JSZip();
  const attachments: TaskArchiveAttachment[] = [];
  let attachmentBytes = 0;

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    onProgress?.({
      phase: "collect",
      current: index,
      total: references.length,
      message: `正在收集任务图片 ${index + 1}/${references.length}`,
    });
    const downloaded = await fetchTaskAttachment(reference);
    attachmentBytes += downloaded.blob.size;
    if (attachmentBytes > TASK_ARCHIVE_MAX_ATTACHMENT_BYTES) {
      throw new Error(`任务图片总大小超过 ${formatBytes(TASK_ARCHIVE_MAX_ATTACHMENT_BYTES)}，无法生成完整备份`);
    }

    const taskSegment = safeSegment(reference.taskSourceId, "task");
    const filename = safeSegment(downloaded.filename, `task-image-${reference.sourceAttachmentId}`);
    const path = `images/${taskSegment}/${String(index + 1).padStart(4, "0")}-${filename}`;
    zip.file(path, downloaded.blob);
    attachments.push({
      sourceAttachmentId: reference.sourceAttachmentId,
      taskSourceId: reference.taskSourceId,
      originalUrl: reference.originalUrl,
      filename,
      mimeType: downloaded.mimeType,
      size: downloaded.blob.size,
      path,
    });
  }

  const manifest: TaskArchiveManifest = {
    format: TASK_ARCHIVE_FORMAT,
    version: TASK_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    backup: pkg,
    attachments,
  };
  zip.file("tasks.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      platform: "UNIX",
    },
    (metadata) => {
      onProgress?.({
        phase: "collect",
        current: Math.round(metadata.percent),
        total: 100,
        message: `正在压缩完整备份 ${Math.round(metadata.percent)}%`,
      });
    },
  );

  onProgress?.({ phase: "done", current: 1, total: 1, message: "完整备份已准备完成" });
  return {
    blob,
    filename: taskArchiveFilename(),
    attachmentCount: attachments.length,
    attachmentBytes,
  };
}

function parseAttachmentMetadata(value: unknown, index: number): TaskArchiveAttachment {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const sourceAttachmentId = String(row.sourceAttachmentId || "").trim();
  const taskSourceId = String(row.taskSourceId || "").trim();
  const originalUrl = String(row.originalUrl || "").trim();
  const filename = safeSegment(String(row.filename || ""), `task-image-${index + 1}`);
  const mimeType = String(row.mimeType || "application/octet-stream").trim().slice(0, 120);
  const size = Number(row.size);
  const path = String(row.path || "").trim();

  if (!sourceAttachmentId || !taskSourceId || !originalUrl || !path) {
    throw new Error(`完整备份中的第 ${index + 1} 张图片元数据不完整`);
  }
  if (!path.startsWith("images/") || path.includes("..") || path.startsWith("/")) {
    throw new Error(`完整备份中的图片路径不安全：${path}`);
  }
  if (!Number.isFinite(size) || size < 0 || size > 50 * 1024 * 1024) {
    throw new Error(`完整备份中的图片大小无效：${filename}`);
  }

  return { sourceAttachmentId, taskSourceId, originalUrl, filename, mimeType, size, path };
}

async function parseTaskArchiveFile(file: File): Promise<TaskArchivePreview> {
  if (file.size > TASK_ARCHIVE_MAX_FILE_BYTES) {
    throw new Error(`完整备份超过 ${formatBytes(TASK_ARCHIVE_MAX_FILE_BYTES)}，无法导入`);
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error("ZIP 文件损坏或不是有效的待办完整备份");
  }

  const manifestEntry = zip.file("tasks.json");
  if (!manifestEntry) throw new Error("ZIP 中缺少 tasks.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await manifestEntry.async("text"));
  } catch {
    throw new Error("tasks.json 格式错误，无法解析");
  }

  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (root.format !== TASK_ARCHIVE_FORMAT || Number(root.version) !== TASK_ARCHIVE_VERSION) {
    throw new Error("不支持的待办完整备份格式或版本");
  }

  const pkg = normalizeTaskBackup(root.backup);
  const rawAttachments = Array.isArray(root.attachments) ? root.attachments : [];
  if (rawAttachments.length > TASK_ARCHIVE_MAX_ATTACHMENTS) {
    throw new Error(`完整备份中的图片超过 ${TASK_ARCHIVE_MAX_ATTACHMENTS} 张`);
  }
  const attachments = rawAttachments.map(parseAttachmentMetadata);
  let attachmentBytes = 0;
  for (const attachment of attachments) {
    attachmentBytes += attachment.size;
    if (attachmentBytes > TASK_ARCHIVE_MAX_ATTACHMENT_BYTES) {
      throw new Error(`完整备份中的图片总大小超过 ${formatBytes(TASK_ARCHIVE_MAX_ATTACHMENT_BYTES)}`);
    }
    if (!zip.file(attachment.path)) throw new Error(`ZIP 中缺少图片文件：${attachment.path}`);
  }

  const summary = summarizeTaskBackup(pkg);
  const warnings = [...summary.warnings];
  if (attachments.length > 0) {
    warnings.push(`将恢复 ${attachments.length} 张任务图片（${formatBytes(attachmentBytes)}）`);
  }

  return {
    format: "zip",
    fileName: file.name,
    pkg,
    ...summary,
    warnings,
    attachments: attachments.length,
    attachmentBytes,
    archive: {
      zip,
      manifest: {
        format: TASK_ARCHIVE_FORMAT,
        version: TASK_ARCHIVE_VERSION,
        exportedAt: String(root.exportedAt || ""),
        backup: pkg,
        attachments,
      },
    },
  };
}

export async function parseTaskTransferFile(file: File): Promise<AnyTaskImportPreview> {
  const isZip = /\.zip$/i.test(file.name) || /zip/i.test(file.type);
  return isZip ? parseTaskArchiveFile(file) : parseTaskImportFile(file);
}

export async function importTaskArchive(
  preview: TaskArchivePreview,
  options: TaskImportOptions = {},
): Promise<TaskArchiveImportResult> {
  const beforeTasks = await api.getTasks("all");
  const baseResult = await importTaskBackup(preview.pkg, options);
  const result: TaskArchiveImportResult = {
    ...baseResult,
    importedAttachments: 0,
    skippedAttachments: 0,
  };

  if (preview.archive.manifest.attachments.length === 0) return result;

  const [afterTasks, projects] = await Promise.all([
    api.getTasks("all"),
    api.getTaskProjects(),
  ]);
  const sourceToTarget = mapNewTasksToSource(preview.pkg, beforeTasks, afterTasks, projects);
  const targetById = new Map(afterTasks.map((task) => [task.id, task]));
  const warnings = [...result.warnings];
  let missingTargetCount = 0;

  const attachmentsByTask = new Map<string, TaskArchiveAttachment[]>();
  for (const attachment of preview.archive.manifest.attachments) {
    const items = attachmentsByTask.get(attachment.taskSourceId) || [];
    items.push(attachment);
    attachmentsByTask.set(attachment.taskSourceId, items);
  }

  let processed = 0;
  const total = preview.archive.manifest.attachments.length;

  for (const [taskSourceId, attachments] of attachmentsByTask) {
    const target = sourceToTarget.get(taskSourceId);
    if (!target) {
      result.skippedAttachments += attachments.length;
      missingTargetCount += attachments.length;
      processed += attachments.length;
      continue;
    }

    const latest = targetById.get(target.id) || target;
    let nextTitle = latest.title || "";
    let nextDescription = latest.description || "";
    const uploadedIds: string[] = [];
    let pendingImported = 0;

    for (const attachment of attachments) {
      processed += 1;
      options.onProgress?.({
        phase: "relations",
        current: processed,
        total,
        message: `正在恢复任务图片 ${processed}/${total}`,
      });

      try {
        const entry = preview.archive.zip.file(attachment.path);
        if (!entry) throw new Error("压缩包中缺少图片文件");
        const blob = await entry.async("blob");
        if (blob.size !== attachment.size || blob.size > 50 * 1024 * 1024) {
          throw new Error("图片大小校验失败");
        }

        const file = new File([blob], attachment.filename, {
          type: attachment.mimeType || blob.type || "application/octet-stream",
        });
        const uploaded = await api.taskAttachments.upload(file, target.id);
        const titleReplacement = replaceTaskAttachmentReference(nextTitle, attachment, uploaded.url);
        const descriptionReplacement = replaceTaskAttachmentReference(nextDescription, attachment, uploaded.url);

        if (!titleReplacement.changed && !descriptionReplacement.changed) {
          await api.taskAttachments.remove(uploaded.id).catch(() => undefined);
          throw new Error("任务正文中找不到对应图片引用");
        }

        uploadedIds.push(uploaded.id);
        pendingImported += 1;
        nextTitle = titleReplacement.value;
        nextDescription = descriptionReplacement.value;
      } catch (error) {
        result.skippedAttachments += 1;
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`“${attachment.filename}”恢复失败：${message}`);
      }
    }

    if (pendingImported > 0) {
      try {
        const updated = await api.updateTask(target.id, {
          title: nextTitle,
          description: nextDescription,
        });
        targetById.set(target.id, updated.task);
        result.importedAttachments += pendingImported;
      } catch (error) {
        await Promise.all(uploadedIds.map((id) => api.taskAttachments.remove(id).catch(() => undefined)));
        result.skippedAttachments += pendingImported;
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`任务“${target.title}”的图片 URL 更新失败：${message}`);
      }
    }
  }

  if (missingTargetCount > 0) {
    warnings.push(`${missingTargetCount} 张图片对应的任务因重复跳过或未新建，因此未恢复`);
  }
  result.warnings = [...new Set(warnings)].slice(0, 50);
  options.onProgress?.({ phase: "done", current: 1, total: 1, message: "任务与图片导入完成" });
  return result;
}

function isMobileRuntime(): boolean {
  return typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function saveTaskTransferBlob(blob: Blob, filename: string): Promise<void> {
  if (isMobileRuntime() && typeof File !== "undefined" && typeof navigator.share === "function") {
    const file = new File([blob], filename, { type: blob.type || "application/zip" });
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

export function taskArchiveFilename(date = new Date()): string {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("");
  return `nowen-tasks-full-${stamp}.zip`;
}
