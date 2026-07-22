import crypto from "crypto";
import path from "path";
import JSZip from "jszip";
import { v4 as uuid } from "uuid";
import { getDb, getDbSchemaVersion } from "../db/schema";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  writeAttachmentObject,
} from "./attachment-storage";

interface ImportParams {
  userId: string;
  workspaceId?: string | null;
  targetNotebookId?: string;
  importMode?: "new-root" | "into-target";
  dryRun?: boolean;
}

interface ImportWarning {
  type: string;
  message: string;
  id?: string;
  path?: string;
}

interface ImportResult {
  success: boolean;
  dryRun: boolean;
  rootNotebookId?: string;
  rootNotebookIds?: string[];
  package?: {
    format: string;
    formatVersion: number;
    schemaVersion?: number;
    exportedAt: string;
    counts: { notebooks: number; notes: number; tags: number; attachments: number };
    formatStats: { markdown: number; richText: number; html: number };
    packageKind?: string;
  };
  counts?: {
    notebooks: number;
    notes: number;
    tags: number;
    noteTags: number;
    attachments: number;
    renamedRoots?: number;
  };
  conflicts?: Array<{ sourceId: string; originalName: string; importedName: string; parentId: string | null }>;
  warnings: ImportWarning[];
  errors: string[];
}

interface Manifest {
  format: string;
  formatVersion: number;
  schemaVersion?: number;
  app: string;
  exportedAt: string;
  packageKind?: string;
  scope?: {
    type?: string;
    notebookId?: string | null;
    rootSourceIds?: string[];
  };
  counts: { notebooks: number; notes: number; tags: number; noteTags?: number; attachments: number };
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

interface TreeFile {
  version?: number;
  roots?: string[];
  nodes?: Array<{
    sourceId: string;
    parentSourceId: string | null;
    name: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    sortOrder?: number;
    isExpanded?: number;
    createdAt?: string;
    updatedAt?: string;
  }>;
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
  createdAt: string;
  file?: string;
  sha256?: string;
  packagePath?: string;
  referencedInContent?: boolean;
  synthetic?: boolean;
}

interface ValidAttachment {
  oldId: string;
  newId: string;
  oldNoteId: string;
  newNoteId: string;
  meta: AttachmentMeta;
  buffer: Buffer;
  storagePath: string;
  sha256: string;
}

function isSafeZipPath(filePath: string): boolean {
  if (!filePath || /\.\./.test(filePath)) return false;
  if (path.isAbsolute(filePath)) return false;
  if (/^\/|^[a-zA-Z]:/.test(filePath)) return false;
  return !filePath.split(/[\\/]+/).some((segment) => segment === ".." || segment === ".");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteIdReferences(content: string, attachmentMap: Map<string, string>, noteMap: Map<string, string>): {
  content: string;
  unmappedAttachmentIds: string[];
} {
  let out = String(content || "");
  const unmapped = new Set<string>();
  out = out.replace(/\/api\/attachments\/([^/?#\s)"'<>]+)/gi, (match, encodedId: string) => {
    let oldId = encodedId;
    try { oldId = decodeURIComponent(encodedId); } catch { /* keep raw */ }
    const newId = attachmentMap.get(oldId);
    if (!newId) {
      unmapped.add(oldId);
      return match;
    }
    return `/api/attachments/${newId}`;
  });

  for (const [oldId, newId] of noteMap) {
    const escaped = escapeRegExp(oldId);
    out = out
      .replace(new RegExp(`note:${escaped}(?=[$#?\\s)\"'<>]|$)`, "g"), `note:${newId}`)
      .replace(new RegExp(`nowen:\\/\\/note\\/${escaped}(?=[$#?\\s)\"'<>]|$)`, "g"), `nowen://note/${newId}`);
  }
  return { content: out, unmappedAttachmentIds: Array.from(unmapped) };
}

function safeExtension(filename: string): string {
  const ext = path.extname(filename || "") || ".bin";
  const cleaned = ext.replace(/[^a-zA-Z0-9.]/g, "");
  return cleaned && cleaned !== "." ? cleaned : ".bin";
}

function assertWorkspaceWritable(userId: string, workspaceId: string | null): void {
  if (!workspaceId || isSystemAdmin(userId)) return;
  if (!hasRole(getUserWorkspaceRole(workspaceId, userId), "editor")) {
    throw new Error("No permission to import into this workspace");
  }
}

function sortNotebooks(notebooks: NotebookMeta[]): NotebookMeta[] {
  const byId = new Map(notebooks.map((item) => [item.id, item]));
  const result: NotebookMeta[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (item: NotebookMeta): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) throw new Error(`Notebook cycle detected at ${item.id}`);
    visiting.add(item.id);
    if (item.parentId && byId.has(item.parentId)) visit(byId.get(item.parentId)!);
    visiting.delete(item.id);
    visited.add(item.id);
    result.push(item);
  };
  for (const item of notebooks) visit(item);
  return result;
}

function uniqueSiblingName(
  db: ReturnType<typeof getDb>,
  userId: string,
  workspaceId: string | null,
  parentId: string | null,
  desired: string,
  reserved: Set<string>,
): string {
  const existingRows = workspaceId
    ? db.prepare(`
        SELECT name FROM notebooks
         WHERE workspaceId = ? AND parentId IS ? AND (isDeleted IS NULL OR isDeleted = 0)
      `).all(workspaceId, parentId) as Array<{ name: string }>
    : db.prepare(`
        SELECT name FROM notebooks
         WHERE userId = ? AND workspaceId IS NULL AND parentId IS ? AND (isDeleted IS NULL OR isDeleted = 0)
      `).all(userId, parentId) as Array<{ name: string }>;
  const used = new Set(existingRows.map((row) => row.name));
  for (const name of reserved) used.add(name);
  if (!used.has(desired)) {
    reserved.add(desired);
    return desired;
  }
  let index = 2;
  while (used.has(`${desired} (${index})`)) index += 1;
  const result = `${desired} (${index})`;
  reserved.add(result);
  return result;
}

async function readJson<T>(zip: JSZip, filename: string): Promise<T | null> {
  const entry = zip.file(filename);
  if (!entry) return null;
  try {
    return JSON.parse(await entry.async("string")) as T;
  } catch {
    return null;
  }
}

async function readAttachmentEntries(
  zip: JSZip,
  manifestVersion: number,
  warnings: ImportWarning[],
  errors: string[],
): Promise<Map<string, { meta: AttachmentMeta; buffer: Buffer | null }>> {
  const result = new Map<string, { meta: AttachmentMeta; buffer: Buffer | null }>();
  const attachmentManifest = await readJson<{ items?: AttachmentMeta[] }>(zip, "attachments.json");
  if (manifestVersion >= 2 && Array.isArray(attachmentManifest?.items)) {
    for (const meta of attachmentManifest!.items!) {
      if (!meta?.id || !meta.noteId || !meta.packagePath || !isSafeZipPath(meta.packagePath)) {
        errors.push(`Invalid attachment manifest entry: ${meta?.id || "unknown"}`);
        continue;
      }
      const entry = zip.file(meta.packagePath);
      if (!entry) {
        errors.push(`Attachment file not found: ${meta.packagePath}`);
        result.set(meta.id, { meta, buffer: null });
        continue;
      }
      const buffer = Buffer.from(await entry.async("arraybuffer"));
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      if (meta.sha256 && meta.sha256 !== sha256) {
        errors.push(`Attachment checksum mismatch: ${meta.filename || meta.id}`);
      }
      if (meta.size != null && Number(meta.size) !== buffer.length) {
        errors.push(`Attachment size mismatch: ${meta.filename || meta.id}`);
      }
      result.set(meta.id, { meta: { ...meta, sha256 }, buffer });
    }
    return result;
  }

  const folder = zip.folder("attachments");
  if (!folder) return result;
  for (const name of Object.keys(folder.files)) {
    if (!name.endsWith("/meta.json")) continue;
    const attachmentId = name.split("/")[1];
    if (!attachmentId) continue;
    const meta = await readJson<AttachmentMeta>(zip, `attachments/${attachmentId}/meta.json`);
    if (!meta) {
      warnings.push({ type: "invalid_attachment_meta", id: attachmentId, message: `Failed to parse ${name}` });
      continue;
    }
    let buffer: Buffer | null = null;
    if (meta.file) {
      const packagePath = `attachments/${attachmentId}/${meta.file}`;
      const entry = zip.file(packagePath);
      if (!entry) {
        errors.push(`Attachment file not found: ${packagePath}`);
      } else {
        buffer = Buffer.from(await entry.async("arraybuffer"));
        const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
        if (meta.sha256 && meta.sha256 !== sha256) errors.push(`Attachment checksum mismatch: ${meta.filename || meta.id}`);
        meta.packagePath = packagePath;
        meta.sha256 = sha256;
      }
    }
    result.set(meta.id, { meta, buffer });
  }
  return result;
}

export async function importNowenPackage(zipBuffer: Buffer, params: ImportParams): Promise<ImportResult> {
  const {
    userId,
    workspaceId = null,
    targetNotebookId,
    importMode = "new-root",
    dryRun = false,
  } = params;
  const warnings: ImportWarning[] = [];
  const errors: string[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (error) {
    return { success: false, dryRun, warnings, errors: [`Failed to parse ZIP: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const forbiddenFiles = [
    "db.sqlite", ".jwt_secret", "users.json", "passwordHash",
    "system_settings", "system_settings.json", "shares.json", "shareToken",
  ];
  for (const filename of forbiddenFiles) {
    if (zip.file(filename)) return { success: false, dryRun, warnings, errors: [`Package contains forbidden file: ${filename}`] };
  }
  for (const filename of Object.keys(zip.files)) {
    if (!isSafeZipPath(filename)) return { success: false, dryRun, warnings, errors: [`Unsafe path in package: ${filename}`] };
  }

  const manifest = await readJson<Manifest>(zip, "manifest.json");
  if (!manifest) return { success: false, dryRun, warnings, errors: ["manifest.json not found or invalid"] };
  if (manifest.format !== "nowen-package") return { success: false, dryRun, warnings, errors: [`Invalid package format: ${manifest.format}`] };
  if (![1, 2].includes(manifest.formatVersion)) {
    return { success: false, dryRun, warnings, errors: [`Unsupported formatVersion: ${manifest.formatVersion}`] };
  }
  if (manifest.schemaVersion && manifest.schemaVersion > getDbSchemaVersion()) {
    return { success: false, dryRun, warnings, errors: [`Package schemaVersion (${manifest.schemaVersion}) is newer than current (${getDbSchemaVersion()}). Please upgrade first.`] };
  }

  let notebooks = await readJson<NotebookMeta[]>(zip, "notebooks.json") || [];
  if (manifest.formatVersion >= 2) {
    const tree = await readJson<TreeFile>(zip, "tree.json");
    if (Array.isArray(tree?.nodes)) {
      notebooks = tree!.nodes!.map((node) => ({
        id: node.sourceId,
        parentId: node.parentSourceId || null,
        name: node.name,
        description: node.description || null,
        icon: node.icon || null,
        color: node.color || null,
        sortOrder: Number(node.sortOrder) || 0,
        isExpanded: Number(node.isExpanded) || 0,
        createdAt: node.createdAt || new Date().toISOString(),
        updatedAt: node.updatedAt || node.createdAt || new Date().toISOString(),
      }));
    }
  }
  const tags = await readJson<TagMeta[]>(zip, "tags.json") || [];
  const noteTags = await readJson<Array<{ noteId: string; tagId: string }>>(zip, "note_tags.json") || [];
  if (!zip.file("notebooks.json") && !zip.file("tree.json")) errors.push("Notebook tree manifest is missing");

  const noteContents = new Map<string, { content: string; meta: NoteMeta }>();
  const notesFolder = zip.folder("notes");
  if (notesFolder) {
    for (const name of Object.keys(notesFolder.files)) {
      if (!name.endsWith("/meta.json")) continue;
      const noteId = name.split("/")[1];
      if (!noteId) continue;
      const meta = await readJson<NoteMeta>(zip, `notes/${noteId}/meta.json`);
      if (!meta) {
        errors.push(`Invalid note metadata: ${noteId}`);
        continue;
      }
      if (!isSafeZipPath(meta.contentFile)) {
        errors.push(`Unsafe note content path: ${meta.contentFile}`);
        continue;
      }
      const contentPath = `notes/${noteId}/${meta.contentFile}`;
      const entry = zip.file(contentPath);
      if (!entry) {
        errors.push(`Note content not found: ${contentPath}`);
        continue;
      }
      noteContents.set(noteId, { meta, content: await entry.async("string") });
    }
  }
  const attachmentData = await readAttachmentEntries(zip, manifest.formatVersion, warnings, errors);

  const db = getDb();
  let resolvedWorkspaceId = workspaceId;
  try {
    assertWorkspaceWritable(userId, resolvedWorkspaceId);
  } catch (error) {
    return { success: false, dryRun, warnings, errors: [error instanceof Error ? error.message : String(error)] };
  }

  let targetParentId: string | null = null;
  if (importMode === "into-target") {
    if (!targetNotebookId) errors.push("Target notebook is required for into-target mode");
    else {
      const target = db.prepare(`
        SELECT id, userId, workspaceId, isDeleted FROM notebooks WHERE id = ?
      `).get(targetNotebookId) as { id: string; userId: string; workspaceId: string | null; isDeleted: number } | undefined;
      if (!target || target.isDeleted === 1) errors.push("Target notebook not found or deleted");
      else if (!target.workspaceId && target.userId !== userId) errors.push("No permission to import into target notebook");
      else {
        resolvedWorkspaceId = target.workspaceId || null;
        try { assertWorkspaceWritable(userId, resolvedWorkspaceId); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        targetParentId = target.id;
      }
    }
  }

  let sortedNotebooks: NotebookMeta[] = [];
  try {
    sortedNotebooks = sortNotebooks(notebooks);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const sourceNotebookIds = new Set(notebooks.map((item) => item.id));
  const rootNotebooks = sortedNotebooks.filter((item) => !item.parentId || !sourceNotebookIds.has(item.parentId));
  const reservedRootNames = new Set<string>();
  const rootNamePlan = new Map<string, string>();
  const conflicts: Array<{ sourceId: string; originalName: string; importedName: string; parentId: string | null }> = [];
  for (const root of rootNotebooks) {
    const planned = uniqueSiblingName(db, userId, resolvedWorkspaceId, targetParentId, root.name, reservedRootNames);
    rootNamePlan.set(root.id, planned);
    if (planned !== root.name) conflicts.push({ sourceId: root.id, originalName: root.name, importedName: planned, parentId: targetParentId });
  }

  for (const [attachmentId, item] of attachmentData) {
    if (!noteContents.has(item.meta.noteId)) errors.push(`Attachment ${attachmentId} points to missing note ${item.meta.noteId}`);
    if (!item.buffer) errors.push(`Attachment file is missing: ${item.meta.filename || attachmentId}`);
  }

  const packagePreview = {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    counts: {
      notebooks: notebooks.length,
      notes: noteContents.size,
      tags: tags.length,
      attachments: Array.from(attachmentData.values()).filter((item) => !!item.buffer).length,
    },
    formatStats: manifest.formatStats || { markdown: 0, richText: 0, html: 0 },
    packageKind: manifest.packageKind,
  };

  if (dryRun || errors.length) {
    return {
      success: errors.length === 0,
      dryRun,
      package: packagePreview,
      conflicts,
      warnings,
      errors,
    };
  }

  const notebookIdMap = new Map<string, string>();
  const noteIdMap = new Map<string, string>();
  const tagIdMap = new Map<string, string>();
  const attachmentIdMap = new Map<string, string>();
  for (const notebook of sortedNotebooks) notebookIdMap.set(notebook.id, uuid());
  for (const noteId of noteContents.keys()) noteIdMap.set(noteId, uuid());

  const validAttachments: ValidAttachment[] = [];
  const writtenStoragePaths: string[] = [];
  try {
    for (const [oldId, { meta, buffer }] of attachmentData) {
      if (!buffer) continue;
      const newNoteId = noteIdMap.get(meta.noteId);
      if (!newNoteId) continue;
      const newId = uuid();
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      const storagePath = `${getUploadMonthPath()}/${newId}${safeExtension(meta.filename)}`;
      await writeAttachmentObject(storagePath, buffer, meta.mimeType || "application/octet-stream");
      writtenStoragePaths.push(storagePath);
      attachmentIdMap.set(oldId, newId);
      validAttachments.push({
        oldId,
        newId,
        oldNoteId: meta.noteId,
        newNoteId,
        meta,
        buffer,
        storagePath,
        sha256,
      });
    }
  } catch (error) {
    await Promise.all(writtenStoragePaths.map((storagePath) => deleteAttachmentObject(storagePath).catch(() => undefined)));
    return { success: false, dryRun: false, package: packagePreview, conflicts, warnings, errors: [`Attachment restore failed: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const importedRootIds: string[] = [];
  try {
    db.exec("BEGIN TRANSACTION");

    for (const notebook of sortedNotebooks) {
      const newId = notebookIdMap.get(notebook.id)!;
      const sourceParentMapped = notebook.parentId ? notebookIdMap.get(notebook.parentId) : null;
      const parentId = sourceParentMapped || targetParentId;
      const name = rootNamePlan.get(notebook.id) || notebook.name;
      db.prepare(`
        INSERT INTO notebooks (
          id, userId, workspaceId, parentId, name, description, icon, color,
          sortOrder, isExpanded, isDeleted, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        newId, userId, resolvedWorkspaceId, parentId, name, notebook.description,
        notebook.icon, notebook.color, notebook.sortOrder, notebook.isExpanded,
        notebook.createdAt, notebook.updatedAt,
      );
      if (!sourceParentMapped) importedRootIds.push(newId);
    }

    // A malformed package may contain notes without a notebook tree. Keep it recoverable under one
    // unique fallback root rather than silently dropping the notes.
    let fallbackRootId = importedRootIds[0] || targetParentId || null;
    if (!fallbackRootId && noteContents.size) {
      fallbackRootId = uuid();
      const fallbackName = uniqueSiblingName(db, userId, resolvedWorkspaceId, null, "导入的内容", new Set());
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder, isExpanded, isDeleted)
        VALUES (?, ?, ?, NULL, ?, ?, 0, 1, 0)
      `).run(fallbackRootId, userId, resolvedWorkspaceId, fallbackName, "📥");
      importedRootIds.push(fallbackRootId);
    }

    for (const tag of tags) {
      const existing = db.prepare("SELECT id FROM tags WHERE userId = ? AND name = ?").get(userId, tag.name) as { id: string } | undefined;
      if (existing) tagIdMap.set(tag.id, existing.id);
      else {
        const newId = uuid();
        tagIdMap.set(tag.id, newId);
        db.prepare("INSERT INTO tags (id, userId, name, color, createdAt) VALUES (?, ?, ?, ?, ?)")
          .run(newId, userId, tag.name, tag.color, tag.createdAt);
      }
    }

    const rewrittenByNewNoteId = new Map<string, string>();
    for (const [oldId, { content, meta }] of noteContents) {
      const newId = noteIdMap.get(oldId)!;
      const notebook = notebookIdMap.get(meta.notebookId) || fallbackRootId;
      if (!notebook) throw new Error(`No target notebook for note ${oldId}`);
      const rewritten = rewriteIdReferences(content, attachmentIdMap, noteIdMap);
      for (const attachmentId of rewritten.unmappedAttachmentIds) {
        warnings.push({ type: "attachment_ref_unmapped", id: attachmentId, message: `Attachment ${attachmentId} was not restored` });
      }
      const knownFormats = new Set(["markdown", "tiptap-json", "html"]);
      const contentFormat = knownFormats.has(meta.contentFormat) ? meta.contentFormat : "tiptap-json";
      db.prepare(`
        INSERT INTO notes (
          id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
          isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        newId, userId, resolvedWorkspaceId, notebook, meta.title, rewritten.content,
        meta.contentText || "", contentFormat, meta.isPinned || 0, meta.isFavorite || 0,
        meta.isLocked || 0, meta.isArchived || 0, meta.version || 1, meta.sortOrder || 0,
        meta.createdAt, meta.updatedAt,
      );
      rewrittenByNewNoteId.set(newId, rewritten.content);
    }

    for (const attachment of validAttachments) {
      db.prepare(`
        INSERT INTO attachments (id, userId, noteId, filename, mimeType, size, path, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachment.newId, userId, attachment.newNoteId, attachment.meta.filename,
        attachment.meta.mimeType, attachment.buffer.length, attachment.storagePath,
        attachment.meta.createdAt,
      );
    }

    for (const relation of noteTags) {
      const newNoteId = noteIdMap.get(relation.noteId);
      const newTagId = tagIdMap.get(relation.tagId);
      if (newNoteId && newTagId) {
        db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(newNoteId, newTagId);
      } else {
        warnings.push({ type: "note_tag_missing", message: `Unable to restore note/tag relation ${relation.noteId}/${relation.tagId}` });
      }
    }

    for (const [noteId, content] of rewrittenByNewNoteId) {
      if (!content.includes("/api/attachments/")) continue;
      try { syncAttachmentReferences(db, noteId, content); }
      catch (error) { warnings.push({ type: "attachment_reference_index_failed", id: noteId, message: error instanceof Error ? error.message : String(error) }); }
    }

    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    await Promise.all(writtenStoragePaths.map((storagePath) => deleteAttachmentObject(storagePath).catch(() => undefined)));
    return {
      success: false,
      dryRun: false,
      package: packagePreview,
      conflicts,
      warnings,
      errors: [`Import failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return {
    success: true,
    dryRun: false,
    rootNotebookId: importedRootIds[0],
    rootNotebookIds: importedRootIds,
    package: packagePreview,
    conflicts,
    counts: {
      notebooks: notebookIdMap.size + (notebooks.length === 0 && noteContents.size ? 1 : 0),
      notes: noteIdMap.size,
      tags: tagIdMap.size,
      noteTags: noteTags.length,
      attachments: validAttachments.length,
      renamedRoots: conflicts.length,
    },
    warnings,
    errors: [],
  };
}
