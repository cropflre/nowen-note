/**
 * Nowen 数据包导入服务
 *
 * 导入 .nowen.zip 私有迁移包，支持 dry-run 预检和正式导入。
 * 通过 oldId → newId 映射重建关系，附件复制到当前实例。
 */

import { getDb, getDbSchemaVersion } from "../db/schema";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import JSZip from "jszip";

// ====== 类型定义 ======

interface ImportParams {
  userId: string;
  workspaceId?: string | null;
  targetNotebookId?: string;
  importMode?: "new-root" | "into-target";
  dryRun?: boolean;
}

interface ImportResult {
  success: boolean;
  dryRun: boolean;
  rootNotebookId?: string;
  package?: {
    format: string;
    formatVersion: number;
    schemaVersion?: number;
    exportedAt: string;
    counts: { notebooks: number; notes: number; tags: number; attachments: number };
    formatStats: { markdown: number; richText: number; html: number };
  };
  counts?: {
    notebooks: number;
    notes: number;
    tags: number;
    noteTags: number;
    attachments: number;
  };
  warnings: ImportWarning[];
  errors: string[];
}

interface ImportWarning {
  type: string;
  message: string;
  id?: string;
  path?: string;
}

interface Manifest {
  format: string;
  formatVersion: number;
  schemaVersion?: number;
  app: string;
  exportedAt: string;
  scope: { type: string; notebookId: string | null };
  counts: { notebooks: number; notes: number; tags: number; noteTags: number; attachments: number };
  formatStats: { markdown: number; richText: number; html: number };
}

interface NotebookMeta {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  isExpanded: number;
  createdAt: string;
  updatedAt: string;
}

interface NoteMeta {
  id: string;
  notebookId: string;
  title: string;
  contentFormat: string;
  contentFile: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
  attachmentIds: string[];
}

interface TagMeta {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

interface AttachmentMeta {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  path: string | null;
  createdAt: string;
  file?: string;
  sha256?: string;
}

interface PendingAttachment {
  oldId: string;
  newId: string;
  oldNoteId: string;
  meta: AttachmentMeta;
  filePath: string;
  sha256: string;
  size: number;
}

// ====== 工具函数 ======

function getDataDir(): string {
  return process.env.NOWEN_DATA_DIR || path.join(process.cwd(), "data");
}

function getAttachmentsDir(): string {
  return path.join(getDataDir(), "attachments");
}

function isSafeZipPath(filePath: string): boolean {
  if (/\.\./.test(filePath)) return false;
  if (path.isAbsolute(filePath)) return false;
  if (/^\/|^[a-zA-Z]:/.test(filePath)) return false;
  return true;
}

/** 重写 content 中的附件引用（只使用有效的附件映射） */
function rewriteAttachmentRefs(
  content: string,
  effectiveMap: Map<string, string>,
): { content: string; unmappedIds: string[] } {
  if (!content) return { content: "", unmappedIds: [] };
  const unmappedIds: string[] = [];
  const seen = new Set<string>();

  const result = content.replace(
    /\/api\/attachments\/([a-f0-9-]+)/gi,
    (match, oldId) => {
      const newId = effectiveMap.get(oldId);
      if (newId) return `/api/attachments/${newId}`;
      if (!seen.has(oldId)) {
        seen.add(oldId);
        unmappedIds.push(oldId);
      }
      return match;
    },
  );

  return { content: result, unmappedIds };
}

/** 保存附件文件到磁盘 */
function saveAttachmentFile(fileBuffer: Buffer, newId: string, filename: string): { filePath: string; sha256: string } {
  const attachmentsDir = getAttachmentsDir();
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const dir = path.join(attachmentsDir, year, month);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ext = path.extname(filename) || ".bin";
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "");
  const fileFullName = `${newId}${safeExt}`;
  const fullPath = path.join(dir, fileFullName);

  fs.writeFileSync(fullPath, fileBuffer);

  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const relativePath = `${year}/${month}/${fileFullName}`;

  return { filePath: relativePath, sha256 };
}

/** 删除已导入的附件文件（事务回滚时使用） */
function cleanupImportedFiles(files: string[]): void {
  for (const file of files) {
    try {
      const fullPath = path.join(getAttachmentsDir(), file);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (err) {
      console.warn("[nowenPackageImport] Failed to cleanup file:", file, err);
    }
  }
}

// ====== 主导入函数 ======

export async function importNowenPackage(zipBuffer: Buffer, params: ImportParams): Promise<ImportResult> {
  const {
    userId,
    workspaceId,
    targetNotebookId,
    importMode = "new-root",
    dryRun = false,
  } = params;

  const warnings: ImportWarning[] = [];
  const errors: string[] = [];

  // ── 1. 解析 zip ──

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (err: any) {
    return { success: false, dryRun, warnings, errors: [`Failed to parse zip: ${err.message}`] };
  }

  // ── 2. 安全检查：禁止敏感文件 ──

  const forbiddenFiles = [
    "db.sqlite", ".jwt_secret", "users.json", "passwordHash",
    "system_settings", "system_settings.json", "shares.json", "shareToken",
  ];
  for (const name of forbiddenFiles) {
    if (zip.file(name)) {
      return { success: false, dryRun, warnings, errors: [`Package contains forbidden file: ${name}`] };
    }
  }

  // ── 3. 检查 zip entry 路径安全 ──

  for (const [name] of Object.entries(zip.files)) {
    if (!isSafeZipPath(name)) {
      return { success: false, dryRun, warnings, errors: [`Unsafe path in package: ${name}`] };
    }
  }

  // ── 4. 读取 manifest.json ──

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    return { success: false, dryRun, warnings, errors: ["manifest.json not found in package"] };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(await manifestFile.async("string"));
  } catch (err: any) {
    return { success: false, dryRun, warnings, errors: [`Failed to parse manifest.json: ${err.message}`] };
  }

  if (manifest.format !== "nowen-package") {
    return { success: false, dryRun, warnings, errors: [`Invalid format: ${manifest.format}`] };
  }
  if (manifest.formatVersion !== 1) {
    return { success: false, dryRun, warnings, errors: [`Unsupported formatVersion: ${manifest.formatVersion}`] };
  }

  // 检查 schemaVersion
  if (manifest.schemaVersion) {
    const currentSchema = getDbSchemaVersion();
    if (manifest.schemaVersion > currentSchema) {
      return {
        success: false, dryRun, warnings,
        errors: [`Package schemaVersion (${manifest.schemaVersion}) is newer than current (${currentSchema}). Please upgrade first.`],
      };
    }
  }

  // ── 5. 读取辅助文件 ──

  async function readJsonFile<T>(name: string): Promise<T | null> {
    const file = zip.file(name);
    if (!file) return null;
    try {
      return JSON.parse(await file.async("string")) as T;
    } catch {
      return null;
    }
  }

  const notebooks = await readJsonFile<NotebookMeta[]>("notebooks.json") || [];
  const tags = await readJsonFile<TagMeta[]>("tags.json") || [];
  const noteTags = await readJsonFile<{ noteId: string; tagId: string }[]>("note_tags.json") || [];

  // dryRun 校验：必要文件缺失应报错
  if (!zip.file("notebooks.json")) errors.push("notebooks.json not found");
  if (!zip.file("tags.json")) errors.push("tags.json not found");
  if (!zip.file("note_tags.json")) errors.push("note_tags.json not found");

  // ── 6. 校验笔记和附件 ──

  const noteContents = new Map<string, { content: string; meta: NoteMeta }>();
  const noteFolder = zip.folder("notes");

  if (noteFolder) {
    for (const [name] of Object.entries(noteFolder.files)) {
      if (!name.endsWith("/meta.json")) continue;
      const noteId = name.split("/")[1];
      if (!noteId) continue;

      const meta = await readJsonFile<NoteMeta>(`notes/${noteId}/meta.json`);
      if (!meta) {
        warnings.push({ type: "invalid_note_meta", id: noteId, message: `Failed to parse notes/${noteId}/meta.json` });
        continue;
      }

      const contentFile = zip.file(`notes/${noteId}/${meta.contentFile}`);
      if (!contentFile) {
        errors.push(`notes/${noteId}/${meta.contentFile} not found`);
        continue;
      }

      const content = await contentFile.async("string");
      noteContents.set(noteId, { content, meta });
    }
  }

  const attachmentData = new Map<string, { meta: AttachmentMeta; buffer: Buffer | null }>();
  const attFolder = zip.folder("attachments");

  if (attFolder) {
    for (const [name] of Object.entries(attFolder.files)) {
      if (!name.endsWith("/meta.json")) continue;
      const attId = name.split("/")[1];
      if (!attId) continue;

      const meta = await readJsonFile<AttachmentMeta>(`attachments/${attId}/meta.json`);
      if (!meta) {
        warnings.push({ type: "invalid_attachment_meta", id: attId, message: `Failed to parse attachments/${attId}/meta.json` });
        continue;
      }

      let buffer: Buffer | null = null;
      if (meta.file) {
        const fileEntry = zip.file(`attachments/${attId}/${meta.file}`);
        if (fileEntry) {
          buffer = Buffer.from(await fileEntry.async("arraybuffer"));
        } else {
          warnings.push({ type: "missing_attachment_file", id: attId, path: meta.file, message: `File not found: attachments/${attId}/${meta.file}` });
        }
      }

      attachmentData.set(attId, { meta, buffer });
    }
  }

  // ── 7. 检查目标笔记本 ──

  const db = getDb();
  let resolvedWorkspaceId: string | null = workspaceId ?? null;

  if (importMode === "into-target" && targetNotebookId) {
    const target = db.prepare(
      "SELECT id, userId, isDeleted, workspaceId FROM notebooks WHERE id = ? AND userId = ?"
    ).get(targetNotebookId, userId) as { id: string; userId: string; isDeleted: number; workspaceId: string | null } | undefined;

    if (!target) {
      return { success: false, dryRun, warnings, errors: ["Target notebook not found or not owned by user"] };
    }
    if (target.isDeleted === 1) {
      return { success: false, dryRun, warnings, errors: ["Target notebook is deleted"] };
    }
    // 以 target notebook 的 workspaceId 为准
    resolvedWorkspaceId = target.workspaceId;
  }

  // ── 8. dryRun 返回 ──

  if (dryRun) {
    return {
      success: errors.length === 0,
      dryRun: true,
      package: {
        format: manifest.format,
        formatVersion: manifest.formatVersion,
        schemaVersion: manifest.schemaVersion,
        exportedAt: manifest.exportedAt,
        counts: manifest.counts,
        formatStats: manifest.formatStats,
      },
      warnings,
      errors,
    };
  }

  // ── 9. 正式导入 ──

  // ID 映射
  const notebookIdMap = new Map<string, string>();
  const noteIdMap = new Map<string, string>();
  const tagIdMap = new Map<string, string>();

  // 有效的附件映射（只包含文件保存成功的附件）
  const effectiveAttachmentIdMap = new Map<string, string>();

  // 待插入附件记录（延迟到 notes 之后）
  const pendingAttachments: PendingAttachment[] = [];

  // 文件回滚列表
  const importedFiles: string[] = [];

  // rootNotebookId 需要在 try 块外声明，以便返回时使用
  let rootNotebookId: string;

  try {
    db.exec("BEGIN TRANSACTION");

    // 9.1 创建导入根笔记本
    const dateStr = new Date().toISOString().slice(0, 10);

    if (importMode === "into-target" && targetNotebookId) {
      rootNotebookId = targetNotebookId;
    } else {
      rootNotebookId = uuid();
      const rootName = `导入的 Nowen 数据包 ${dateStr}`;
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, description, icon, color, sortOrder, isExpanded, isDeleted, createdAt, updatedAt)
        VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, 1, 0, datetime('now'), datetime('now'))
      `).run(rootNotebookId, userId, resolvedWorkspaceId, rootName);
    }

    // 9.2 导入 notebooks（拓扑排序，父级先插入）
    const sortedNotebooks: NotebookMeta[] = [];
    const visited = new Set<string>();
    const notebookMap = new Map(notebooks.map((n) => [n.id, n]));

    function visitNotebook(nb: NotebookMeta) {
      if (visited.has(nb.id)) return;
      visited.add(nb.id);
      if (nb.parentId && notebookMap.has(nb.parentId)) {
        visitNotebook(notebookMap.get(nb.parentId)!);
      }
      sortedNotebooks.push(nb);
    }

    for (const nb of notebooks) {
      visitNotebook(nb);
    }

    for (const nb of sortedNotebooks) {
      const newId = uuid();
      notebookIdMap.set(nb.id, newId);

      let parentId: string | null = null;
      if (nb.parentId) {
        parentId = notebookIdMap.get(nb.parentId) || rootNotebookId;
        if (!notebookIdMap.has(nb.parentId)) {
          warnings.push({ type: "notebook_parent_missing", id: nb.id, message: `Parent ${nb.parentId} not found, attached to root` });
        }
      } else {
        parentId = rootNotebookId;
      }

      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, description, icon, color, sortOrder, isExpanded, isDeleted, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(newId, userId, resolvedWorkspaceId, parentId, nb.name, nb.description, nb.icon, nb.color, nb.sortOrder, nb.isExpanded, nb.createdAt, nb.updatedAt);
    }

    // 9.3 导入 tags（同名复用）
    for (const tag of tags) {
      const existing = db.prepare("SELECT id FROM tags WHERE userId = ? AND name = ?").get(userId, tag.name) as { id: string } | undefined;
      if (existing) {
        tagIdMap.set(tag.id, existing.id);
      } else {
        const newId = uuid();
        tagIdMap.set(tag.id, newId);
        db.prepare("INSERT INTO tags (id, userId, name, color, createdAt) VALUES (?, ?, ?, ?, ?)").run(newId, userId, tag.name, tag.color, tag.createdAt);
      }
    }

    // 9.4 预生成 noteIdMap
    for (const oldId of noteContents.keys()) {
      noteIdMap.set(oldId, uuid());
    }

    // 9.5 复制附件文件，生成 pendingAttachments（不插入 attachments 表）
    for (const [oldId, { meta, buffer }] of attachmentData) {
      const newId = uuid();
      const newNoteId = noteIdMap.get(meta.noteId);

      if (!newNoteId) {
        warnings.push({ type: "attachment_note_missing", id: oldId, message: `Note ${meta.noteId} not found for attachment ${oldId}` });
        continue;
      }

      if (!buffer) {
        // 文件缺失，跳过，不放入 effectiveAttachmentIdMap
        continue;
      }

      try {
        const { filePath, sha256 } = saveAttachmentFile(buffer, newId, meta.filename);
        importedFiles.push(filePath);

        pendingAttachments.push({
          oldId,
          newId,
          oldNoteId: meta.noteId,
          meta,
          filePath,
          sha256,
          size: buffer.length,
        });

        // 只有保存成功的附件才进入 effectiveAttachmentIdMap
        effectiveAttachmentIdMap.set(oldId, newId);
      } catch (err: any) {
        warnings.push({ type: "attachment_save_failed", id: oldId, message: `Failed to save: ${err.message}` });
      }
    }

    // 9.6 导入 notes（使用 effectiveAttachmentIdMap 重写 content）
    for (const [oldId, { content, meta }] of noteContents) {
      const newId = noteIdMap.get(oldId)!;
      const newNotebookId = notebookIdMap.get(meta.notebookId) || rootNotebookId;

      // 重写附件引用（只重写有效附件）
      const { content: rewrittenContent, unmappedIds } = rewriteAttachmentRefs(content, effectiveAttachmentIdMap);
      for (const unmappedId of unmappedIds) {
        warnings.push({ type: "attachment_ref_unmapped", id: unmappedId, message: `Attachment ${unmappedId} not in package or failed to save` });
      }

      // 确定 contentFormat
      const knownFormats = ["markdown", "tiptap-json", "html"];
      const contentFormat = knownFormats.includes(meta.contentFormat) ? meta.contentFormat : "tiptap-json";
      if (!knownFormats.includes(meta.contentFormat)) {
        warnings.push({ type: "unknown_content_format", id: oldId, message: `Unknown contentFormat "${meta.contentFormat}", imported as tiptap-json` });
      }

      db.prepare(`
        INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        newId, userId, resolvedWorkspaceId, newNotebookId,
        meta.title, rewrittenContent, meta.contentText, contentFormat,
        meta.isPinned, meta.isFavorite, meta.isLocked, meta.isArchived,
        meta.version || 1, meta.sortOrder, meta.createdAt, meta.updatedAt,
      );
    }

    // 9.7 插入 attachments 表（notes 已存在，外键安全）
    for (const pa of pendingAttachments) {
      const newNoteId = noteIdMap.get(pa.oldNoteId)!;
      db.prepare(`
        INSERT INTO attachments (id, userId, noteId, filename, mimeType, size, path, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pa.newId, userId, newNoteId, pa.meta.filename, pa.meta.mimeType, pa.size, pa.filePath, pa.meta.createdAt);
    }

    // 9.8 导入 note_tags
    for (const nt of noteTags) {
      const newNoteId = noteIdMap.get(nt.noteId);
      const newTagId = tagIdMap.get(nt.tagId);
      if (newNoteId && newTagId) {
        db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(newNoteId, newTagId);
      } else {
        warnings.push({ type: "note_tag_missing", message: `noteId=${nt.noteId} or tagId=${nt.tagId} not found in mapping` });
      }
    }

    db.exec("COMMIT");
  } catch (err: any) {
    try { db.exec("ROLLBACK"); } catch {}
    cleanupImportedFiles(importedFiles);
    return { success: false, dryRun: false, warnings, errors: [`Import failed: ${err.message}`] };
  }

  // ── 10. 返回结果 ──

  return {
    success: true,
    dryRun: false,
    rootNotebookId,
    counts: {
      notebooks: notebookIdMap.size,
      notes: noteIdMap.size,
      tags: tagIdMap.size,
      noteTags: noteTags.length,
      attachments: effectiveAttachmentIdMap.size,
    },
    warnings,
    errors,
  };
}
