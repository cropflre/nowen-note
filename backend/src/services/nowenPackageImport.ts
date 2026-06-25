/**
 * Nowen 数据包导入服务
 *
 * 导入 .nowen.zip 私有迁移包，支持 dry-run 预检和正式导入。
 * 通过 oldId → newId 映射重建关系，附件复制到当前实例。
 */

import { getDb } from "../db/schema";
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
    counts: {
      notebooks: number;
      notes: number;
      tags: number;
      attachments: number;
    };
    formatStats: {
      markdown: number;
      richText: number;
      html: number;
    };
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
  scope: {
    type: string;
    notebookId: string | null;
  };
  counts: {
    notebooks: number;
    notes: number;
    tags: number;
    noteTags: number;
    attachments: number;
  };
  formatStats: {
    markdown: number;
    richText: number;
    html: number;
  };
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

// ====== 工具函数 ======

function getDataDir(): string {
  return process.env.NOWEN_DATA_DIR || path.join(process.cwd(), "data");
}

function getAttachmentsDir(): string {
  return path.join(getDataDir(), "attachments");
}

function isSafePath(filePath: string): boolean {
  if (/\.\./.test(filePath)) return false;
  if (path.isAbsolute(filePath)) return false;
  if (/\\/.test(filePath) && !/\//.test(filePath)) return false;
  return true;
}

/** 重写 content 中的附件引用 */
function rewriteAttachmentRefs(
  content: string,
  attachmentIdMap: Map<string, string>,
): { content: string; unmappedIds: string[] } {
  if (!content) return { content: "", unmappedIds: [] };

  const unmappedIds: string[] = [];
  const seen = new Set<string>();

  // 匹配 /api/attachments/<id> 模式
  const result = content.replace(
    /\/api\/attachments\/([a-f0-9-]+)/gi,
    (match, oldId) => {
      const newId = attachmentIdMap.get(oldId);
      if (newId) {
        return `/api/attachments/${newId}`;
      }
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
function saveAttachmentFile(
  fileBuffer: Buffer,
  newId: string,
  filename: string,
): { filePath: string; sha256: string } {
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

export async function importNowenPackage(
  zipBuffer: Buffer,
  params: ImportParams,
): Promise<ImportResult> {
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
    return {
      success: false,
      dryRun,
      warnings,
      errors: [`Failed to parse zip: ${err.message}`],
    };
  }

  // ── 2. 读取 manifest.json ──

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    return {
      success: false,
      dryRun,
      warnings,
      errors: ["manifest.json not found in package"],
    };
  }

  let manifest: Manifest;
  try {
    const text = await manifestFile.async("string");
    manifest = JSON.parse(text);
  } catch (err: any) {
    return {
      success: false,
      dryRun,
      warnings,
      errors: [`Failed to parse manifest.json: ${err.message}`],
    };
  }

  // 校验 manifest
  if (manifest.format !== "nowen-package") {
    return {
      success: false,
      dryRun,
      warnings,
      errors: [`Invalid format: ${manifest.format}, expected "nowen-package"`],
    };
  }

  if (manifest.formatVersion !== 1) {
    return {
      success: false,
      dryRun,
      warnings,
      errors: [`Unsupported formatVersion: ${manifest.formatVersion}`],
    };
  }

  // ── 3. 读取辅助文件 ──

  async function readJsonFile<T>(name: string): Promise<T | null> {
    const file = zip.file(name);
    if (!file) return null;
    try {
      const text = await file.async("string");
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  const notebooks = await readJsonFile<NotebookMeta[]>("notebooks.json") || [];
  const tags = await readJsonFile<TagMeta[]>("tags.json") || [];
  const noteTags = await readJsonFile<{ noteId: string; tagId: string }[]>("note_tags.json") || [];

  // ── 4. 校验笔记和附件 ──

  const noteEntries = zip.folder("notes");
  const attachmentEntries = zip.folder("attachments");

  const noteIds: string[] = [];
  const noteContents = new Map<string, { content: string; meta: NoteMeta }>();

  if (noteEntries) {
    for (const [name, entry] of Object.entries(noteEntries.files)) {
      if (!entry.dir && name.endsWith("/meta.json")) {
        const noteId = name.split("/")[1];
        if (noteId) noteIds.push(noteId);
      }
    }
  }

  for (const noteId of noteIds) {
    const metaFile = zip.file(`notes/${noteId}/meta.json`);
    if (!metaFile) {
      warnings.push({
        type: "missing_note_meta",
        id: noteId,
        message: `notes/${noteId}/meta.json not found`,
      });
      continue;
    }

    const meta = await readJsonFile<NoteMeta>(`notes/${noteId}/meta.json`);
    if (!meta) {
      warnings.push({
        type: "invalid_note_meta",
        id: noteId,
        message: `Failed to parse notes/${noteId}/meta.json`,
      });
      continue;
    }

    const contentFile = zip.file(`notes/${noteId}/${meta.contentFile}`);
    if (!contentFile) {
      warnings.push({
        type: "missing_note_content",
        id: noteId,
        message: `notes/${noteId}/${meta.contentFile} not found`,
      });
      continue;
    }

    const content = await contentFile.async("string");
    noteContents.set(noteId, { content, meta });
  }

  // 校验附件
  const attachmentIds: string[] = [];
  const attachmentData = new Map<string, { meta: AttachmentMeta; buffer: Buffer | null }>();

  if (attachmentEntries) {
    for (const [name, entry] of Object.entries(attachmentEntries.files)) {
      if (!entry.dir && name.endsWith("/meta.json")) {
        const attId = name.split("/")[1];
        if (attId) attachmentIds.push(attId);
      }
    }
  }

  for (const attId of attachmentIds) {
    const meta = await readJsonFile<AttachmentMeta>(`attachments/${attId}/meta.json`);
    if (!meta) {
      warnings.push({
        type: "invalid_attachment_meta",
        id: attId,
        message: `Failed to parse attachments/${attId}/meta.json`,
      });
      continue;
    }

    let buffer: Buffer | null = null;
    if (meta.file) {
      const fileEntry = zip.file(`attachments/${attId}/${meta.file}`);
      if (fileEntry) {
        buffer = Buffer.from(await fileEntry.async("arraybuffer"));
      } else {
        warnings.push({
          type: "missing_attachment_file",
          id: attId,
          path: meta.file,
          message: `Attachment file not found: attachments/${attId}/${meta.file}`,
        });
      }
    }

    attachmentData.set(attId, { meta, buffer });
  }

  // ── 5. 安全检查 ──

  const forbiddenFiles = ["db.sqlite", ".jwt_secret", "users.json", "passwordHash", "system_settings"];
  for (const name of forbiddenFiles) {
    if (zip.file(name)) {
      return {
        success: false,
        dryRun,
        warnings,
        errors: [`Package contains forbidden file: ${name}`],
      };
    }
  }

  // ── 6. 检查目标笔记本 ──

  if (importMode === "into-target" && targetNotebookId) {
    const db = getDb();
    const target = db.prepare(
      "SELECT id, userId, isDeleted FROM notebooks WHERE id = ? AND userId = ?"
    ).get(targetNotebookId, userId) as { id: string; userId: string; isDeleted: number } | undefined;

    if (!target) {
      return {
        success: false,
        dryRun,
        warnings,
        errors: ["Target notebook not found or not owned by user"],
      };
    }
    if (target.isDeleted === 1) {
      return {
        success: false,
        dryRun,
        warnings,
        errors: ["Target notebook is deleted"],
      };
    }
  }

  // ── 7. dryRun 返回 ──

  if (dryRun) {
    return {
      success: true,
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

  // ── 8. 正式导入 ──

  const db = getDb();

  // ID 映射
  const notebookIdMap = new Map<string, string>();
  const noteIdMap = new Map<string, string>();
  const tagIdMap = new Map<string, string>();
  const attachmentIdMap = new Map<string, string>();

  // 文件回滚列表
  const importedFiles: string[] = [];

  try {
    db.exec("BEGIN TRANSACTION");

    // 8.1 创建导入根笔记本
    let rootNotebookId: string;
    const dateStr = new Date().toISOString().slice(0, 10);

    if (importMode === "into-target" && targetNotebookId) {
      rootNotebookId = targetNotebookId;
    } else {
      rootNotebookId = uuid();
      const rootName = `导入的 Nowen 数据包 ${dateStr}`;
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, description, icon, color, sortOrder, isExpanded, isDeleted, createdAt, updatedAt)
        VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, 1, 0, datetime('now'), datetime('now'))
      `).run(rootNotebookId, userId, workspaceId || null, rootName);
    }

    // 8.2 导入 notebooks
    // 按 parentId 拓扑排序，保证父级先插入
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
          warnings.push({
            type: "notebook_parent_missing",
            id: nb.id,
            message: `Parent notebook ${nb.parentId} not found, attached to root`,
          });
        }
      } else {
        parentId = rootNotebookId;
      }

      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, description, icon, color, sortOrder, isExpanded, isDeleted, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        newId, userId, workspaceId || null, parentId,
        nb.name, nb.description, nb.icon, nb.color,
        nb.sortOrder, nb.isExpanded, nb.createdAt, nb.updatedAt,
      );
    }

    // 8.3 导入 tags
    for (const tag of tags) {
      // 检查是否已有同名标签
      const existing = db.prepare(
        "SELECT id FROM tags WHERE userId = ? AND name = ?"
      ).get(userId, tag.name) as { id: string } | undefined;

      if (existing) {
        tagIdMap.set(tag.id, existing.id);
      } else {
        const newId = uuid();
        tagIdMap.set(tag.id, newId);
        db.prepare(`
          INSERT INTO tags (id, userId, name, color, createdAt)
          VALUES (?, ?, ?, ?, ?)
        `).run(newId, userId, tag.name, tag.color, tag.createdAt);
      }
    }

    // 8.4 预生成 noteIdMap 和 attachmentIdMap
    for (const oldId of noteContents.keys()) {
      noteIdMap.set(oldId, uuid());
    }
    for (const oldId of attachmentData.keys()) {
      attachmentIdMap.set(oldId, uuid());
    }

    // 8.5 复制附件文件
    for (const [oldId, { meta, buffer }] of attachmentData) {
      const newId = attachmentIdMap.get(oldId)!;

      if (buffer) {
        try {
          const { filePath, sha256 } = saveAttachmentFile(buffer, newId, meta.filename);
          importedFiles.push(filePath);

          // 插入 attachments 表
          const newNoteId = noteIdMap.get(meta.noteId);
          if (!newNoteId) {
            warnings.push({
              type: "attachment_note_missing",
              id: oldId,
              message: `Note ${meta.noteId} not found for attachment ${oldId}`,
            });
            continue;
          }

          db.prepare(`
            INSERT INTO attachments (id, userId, noteId, filename, mimeType, size, path, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newId, userId, newNoteId, meta.filename,
            meta.mimeType, buffer.length, filePath, meta.createdAt,
          );
        } catch (err: any) {
          warnings.push({
            type: "attachment_save_failed",
            id: oldId,
            message: `Failed to save attachment: ${err.message}`,
          });
        }
      }
    }

    // 8.6 导入 notes
    for (const [oldId, { content, meta }] of noteContents) {
      const newId = noteIdMap.get(oldId)!;
      const newNotebookId = notebookIdMap.get(meta.notebookId) || rootNotebookId;

      // 重写附件引用
      const { content: rewrittenContent, unmappedIds } = rewriteAttachmentRefs(content, attachmentIdMap);

      if (unmappedIds.length > 0) {
        for (const unmappedId of unmappedIds) {
          warnings.push({
            type: "attachment_ref_unmapped",
            id: unmappedId,
            message: `Attachment ${unmappedId} referenced in content but not in package`,
          });
        }
      }

      // 确定 contentFormat
      const knownFormats = ["markdown", "tiptap-json", "html"];
      const contentFormat = knownFormats.includes(meta.contentFormat) ? meta.contentFormat : "tiptap-json";
      if (!knownFormats.includes(meta.contentFormat)) {
        warnings.push({
          type: "unknown_content_format",
          id: oldId,
          message: `Unknown contentFormat "${meta.contentFormat}", imported as tiptap-json`,
        });
      }

      db.prepare(`
        INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        newId, userId, workspaceId || null, newNotebookId,
        meta.title, rewrittenContent, meta.contentText, contentFormat,
        meta.isPinned, meta.isFavorite, meta.isLocked, meta.isArchived,
        meta.version || 1, meta.sortOrder, meta.createdAt, meta.updatedAt,
      );
    }

    // 8.7 导入 note_tags
    for (const nt of noteTags) {
      const newNoteId = noteIdMap.get(nt.noteId);
      const newTagId = tagIdMap.get(nt.tagId);
      if (newNoteId && newTagId) {
        db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(newNoteId, newTagId);
      } else {
        warnings.push({
          type: "note_tag_missing",
          message: `noteId=${nt.noteId} or tagId=${nt.tagId} not found in mapping`,
        });
      }
    }

    db.exec("COMMIT");
  } catch (err: any) {
    // 回滚数据库
    try {
      db.exec("ROLLBACK");
    } catch {}

    // 清理已写入的文件
    cleanupImportedFiles(importedFiles);

    return {
      success: false,
      dryRun: false,
      warnings,
      errors: [`Import failed: ${err.message}`],
    };
  }

  // ── 9. 返回结果 ──

  return {
    success: true,
    dryRun: false,
    rootNotebookId: importMode === "into-target" ? targetNotebookId : undefined,
    counts: {
      notebooks: notebookIdMap.size,
      notes: noteIdMap.size,
      tags: tagIdMap.size,
      noteTags: noteTags.length,
      attachments: attachmentIdMap.size,
    },
    warnings,
    errors,
  };
}
