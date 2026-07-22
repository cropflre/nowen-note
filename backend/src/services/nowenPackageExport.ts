import crypto from "crypto";
import JSZip from "jszip";
import path from "path";
import { getDb, getDbSchemaVersion } from "../db/schema";
import { getUserWorkspaceRole, isSystemAdmin } from "../middleware/acl";
import { readAttachmentObject } from "./attachment-storage";

/**
 * Nowen v2 round-trip package.
 *
 * Native packages keep the original content format. Markdown packages reuse the same private
 * manifest and attachment graph, while also exposing a human-readable folder tree at ZIP root.
 */

export interface PreparedMarkdownPackageNote {
  id: string;
  title: string;
  notebookName: string | null;
  createdAt: string;
  updatedAt: string;
  contentFormat?: string;
  markdown: string;
  inlineAssets?: Array<{ relPath: string; base64: string }>;
}

interface ExportParams {
  userId: string;
  workspaceId?: string | null;
  notebookId?: string;
  includeSubNotebooks?: boolean;
  includeTrashed?: boolean;
  /** Exact note selection used by Markdown/single-note export. */
  noteIds?: string[];
  preparedMarkdown?: PreparedMarkdownPackageNote[];
  packageKind?: "nowen" | "markdown";
  includeHumanReadableTree?: boolean;
  inlineImages?: boolean;
  layout?: "notebooks" | "flat";
  filenameBase?: string;
}

interface ExportStats {
  notes: number;
  notebooks: number;
  tags: number;
  noteTags: number;
  attachments: number;
  warnings: number;
}

interface ExportWarning {
  type: string;
  attachmentId?: string;
  noteId?: string;
  path?: string;
  message: string;
}

interface ExportNotebook {
  id: string;
  userId?: string;
  workspaceId?: string | null;
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

interface ExportNote {
  id: string;
  userId?: string;
  workspaceId?: string | null;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string | null;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface ExportTag {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

interface ExportAttachment {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  path: string | null;
  createdAt: string;
}

interface PackageAttachmentMeta {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string | null;
  size: number;
  createdAt: string;
  sha256: string;
  packagePath: string;
  referencedInContent: boolean;
  synthetic?: boolean;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function sanitizeSegment(value: string, fallback = "未命名"): string {
  let out = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!out) out = fallback;
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  const chars = Array.from(out);
  if (chars.length > 80) {
    const hash = crypto.createHash("sha1").update(out).digest("hex").slice(0, 8);
    out = `${chars.slice(0, 68).join("")}~${hash}`;
  }
  return out;
}

function normalizeInlinePath(value: string): string | null {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.map((part) => sanitizeSegment(part)).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAttachmentUrl(content: string, attachmentId: string, replacement: string): string {
  const escaped = escapeRegExp(attachmentId);
  return content.replace(
    new RegExp(`(?:https?:\\/\\/[^\\s)\"'<>]+)?\\/api\\/attachments\\/${escaped}(?:\\?[^\\s)\"'<>]*)?`, "gi"),
    replacement,
  );
}

function contentReferencesAttachment(content: string, id: string): boolean {
  return new RegExp(`\\/api\\/attachments\\/${escapeRegExp(id)}(?:[/?#\\s)\"'<>]|$)`, "i").test(content || "");
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base} (${index})`)) index += 1;
  const value = `${base} (${index})`;
  used.add(value);
  return value;
}

function assertWorkspaceReadable(userId: string, workspaceId: string | null | undefined): void {
  if (!workspaceId || isSystemAdmin(userId)) return;
  if (!getUserWorkspaceRole(workspaceId, userId)) {
    throw new Error("No permission to export this workspace");
  }
}

function queryScopeNotebooks(userId: string, workspaceId: string | null | undefined): ExportNotebook[] {
  const db = getDb();
  if (workspaceId) {
    return db.prepare(`
      SELECT id, userId, workspaceId, parentId, name, description, icon, color,
             sortOrder, isExpanded, createdAt, updatedAt
        FROM notebooks
       WHERE workspaceId = ? AND (isDeleted IS NULL OR isDeleted = 0)
       ORDER BY parentId, sortOrder, createdAt, id
    `).all(workspaceId) as ExportNotebook[];
  }
  return db.prepare(`
    SELECT id, userId, workspaceId, parentId, name, description, icon, color,
           sortOrder, isExpanded, createdAt, updatedAt
      FROM notebooks
     WHERE userId = ? AND workspaceId IS NULL AND (isDeleted IS NULL OR isDeleted = 0)
     ORDER BY parentId, sortOrder, createdAt, id
  `).all(userId) as ExportNotebook[];
}

function collectDescendants(rootId: string, byParent: Map<string | null, ExportNotebook[]>): Set<string> {
  const ids = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop()!;
    if (ids.has(current)) continue;
    ids.add(current);
    for (const child of byParent.get(current) || []) stack.push(child.id);
  }
  return ids;
}

function selectNotebooks(
  all: ExportNotebook[],
  params: Pick<ExportParams, "notebookId" | "includeSubNotebooks" | "noteIds">,
  selectedNoteNotebookIds: Set<string>,
  allScopeNoteCount: number,
  selectedNoteCount: number,
): ExportNotebook[] {
  const byId = new Map(all.map((item) => [item.id, item]));
  const byParent = new Map<string | null, ExportNotebook[]>();
  for (const item of all) {
    const key = item.parentId && byId.has(item.parentId) ? item.parentId : null;
    const bucket = byParent.get(key) || [];
    bucket.push(item);
    byParent.set(key, bucket);
  }

  if (params.notebookId) {
    if (!byId.has(params.notebookId)) return [];
    const ids = params.includeSubNotebooks === false
      ? new Set([params.notebookId])
      : collectDescendants(params.notebookId, byParent);
    return all.filter((item) => ids.has(item.id));
  }

  if (!params.noteIds || selectedNoteCount === allScopeNoteCount) return all;

  const ids = new Set<string>(selectedNoteNotebookIds);
  // Keep all ancestors so a re-import has the same path.
  for (const notebookId of Array.from(selectedNoteNotebookIds)) {
    let cursor = byId.get(notebookId);
    while (cursor?.parentId && byId.has(cursor.parentId)) {
      ids.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
    }
  }
  // Preserve empty descendants below selected notebooks where they can be inferred safely.
  for (const notebookId of selectedNoteNotebookIds) {
    for (const id of collectDescendants(notebookId, byParent)) ids.add(id);
  }
  return all.filter((item) => ids.has(item.id));
}

function buildExportPaths(notebooks: ExportNotebook[]): {
  pathById: Map<string, string>;
  exportNameById: Map<string, string>;
  roots: string[];
} {
  const byId = new Map(notebooks.map((item) => [item.id, item]));
  const byParent = new Map<string | null, ExportNotebook[]>();
  for (const item of notebooks) {
    const parent = item.parentId && byId.has(item.parentId) ? item.parentId : null;
    const bucket = byParent.get(parent) || [];
    bucket.push(item);
    byParent.set(parent, bucket);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  const exportNameById = new Map<string, string>();
  for (const bucket of byParent.values()) {
    const used = new Set<string>();
    for (const item of bucket) exportNameById.set(item.id, uniqueName(sanitizeSegment(item.name), used));
  }

  const pathById = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (id: string): string => {
    const cached = pathById.get(id);
    if (cached !== undefined) return cached;
    if (resolving.has(id)) return exportNameById.get(id) || sanitizeSegment(byId.get(id)?.name || "未命名");
    resolving.add(id);
    const item = byId.get(id);
    const own = exportNameById.get(id) || sanitizeSegment(item?.name || "未命名");
    const parentPath = item?.parentId && byId.has(item.parentId) ? resolve(item.parentId) : "";
    const result = parentPath ? `${parentPath}/${own}` : own;
    pathById.set(id, result);
    resolving.delete(id);
    return result;
  };
  for (const item of notebooks) resolve(item.id);
  const roots = notebooks
    .filter((item) => !item.parentId || !byId.has(item.parentId))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((item) => item.id);
  return { pathById, exportNameById, roots };
}

function extractDataImages(
  content: string,
  noteId: string,
): { content: string; assets: Array<{ id: string; filename: string; mimeType: string; buffer: Buffer }> } {
  const assets: Array<{ id: string; filename: string; mimeType: string; buffer: Buffer }> = [];
  let index = 0;
  const rewritten = String(content || "").replace(
    /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g,
    (full, mime: string, base64: string) => {
      try {
        const buffer = Buffer.from(base64, "base64");
        if (!buffer.length) return full;
        index += 1;
        const ext = mime.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "png";
        const id = `inline-${noteId}-${index}`;
        assets.push({ id, filename: `inline-${index}.${ext}`, mimeType: mime, buffer });
        return `/api/attachments/${id}`;
      } catch {
        return full;
      }
    },
  );
  return { content: rewritten, assets };
}

function replaceInlineAssetReference(content: string, relPath: string, replacement: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const escaped = escapeRegExp(normalized);
  return content
    .replace(new RegExp(`\\.\\/${escaped}`, "g"), replacement)
    .replace(new RegExp(`(?<![A-Za-z0-9_./-])${escaped}`, "g"), replacement);
}

export async function createNowenPackageExport(params: ExportParams): Promise<{
  buffer: Buffer;
  filename: string;
  stats: ExportStats;
}> {
  const db = getDb();
  const {
    userId,
    workspaceId = null,
    notebookId,
    includeSubNotebooks = true,
    includeTrashed = false,
    noteIds,
    preparedMarkdown = [],
    packageKind = "nowen",
    includeHumanReadableTree = packageKind === "markdown",
    layout = "notebooks",
    filenameBase,
  } = params;

  assertWorkspaceReadable(userId, workspaceId);
  const warnings: ExportWarning[] = [];
  const allScopeNotebooks = queryScopeNotebooks(userId, workspaceId);
  const allScopeNotebookIds = new Set(allScopeNotebooks.map((item) => item.id));

  const trashedSql = includeTrashed ? "" : "AND isTrashed = 0";
  const scopeNotes = allScopeNotebookIds.size
    ? db.prepare(`
        SELECT id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
               isPinned, isFavorite, isLocked, isArchived, version, sortOrder, createdAt, updatedAt
          FROM notes
         WHERE notebookId IN (${Array.from(allScopeNotebookIds).map(() => "?").join(",")}) ${trashedSql}
         ORDER BY notebookId, sortOrder, createdAt, id
      `).all(...allScopeNotebookIds) as ExportNote[]
    : [];

  const selectedIdSet = noteIds ? new Set(noteIds) : null;
  let notes = selectedIdSet ? scopeNotes.filter((note) => selectedIdSet.has(note.id)) : scopeNotes;
  if (selectedIdSet && notes.length !== selectedIdSet.size) {
    throw new Error("Some selected notes do not exist or are outside the export scope");
  }

  const selectedNoteNotebookIds = new Set(notes.map((note) => note.notebookId));
  const notebooks = selectNotebooks(
    allScopeNotebooks,
    { notebookId, includeSubNotebooks, noteIds },
    selectedNoteNotebookIds,
    scopeNotes.length,
    notes.length,
  );
  const notebookIds = new Set(notebooks.map((item) => item.id));
  if (notebookId) notes = notes.filter((note) => notebookIds.has(note.notebookId));
  if (!notebooks.length && notes.length) throw new Error("No notebooks found for selected notes");
  if (!notebooks.length && !notes.length) throw new Error("No data found in export scope");

  const preparedById = new Map(preparedMarkdown.map((item) => [item.id, item]));
  if (packageKind === "markdown" && preparedById.size !== notes.length) {
    throw new Error("Markdown conversion result is incomplete");
  }

  const noteIdList = notes.map((note) => note.id);
  const notePlaceholders = noteIdList.map(() => "?").join(",") || "NULL";
  const noteTags = noteIdList.length
    ? db.prepare(`SELECT noteId, tagId FROM note_tags WHERE noteId IN (${notePlaceholders})`).all(...noteIdList) as Array<{ noteId: string; tagId: string }>
    : [];
  const tagIds = Array.from(new Set(noteTags.map((item) => item.tagId)));
  const tags = tagIds.length
    ? db.prepare(`SELECT id, name, color, createdAt FROM tags WHERE id IN (${tagIds.map(() => "?").join(",")})`).all(...tagIds) as ExportTag[]
    : [];
  const dbAttachments = noteIdList.length
    ? db.prepare(`
        SELECT id, noteId, filename, mimeType, size, path, createdAt
          FROM attachments
         WHERE noteId IN (${notePlaceholders})
         ORDER BY noteId, createdAt, id
      `).all(...noteIdList) as ExportAttachment[]
    : [];

  const { pathById, exportNameById, roots } = buildExportPaths(notebooks);
  const zip = new JSZip();
  const packageAttachments: PackageAttachmentMeta[] = [];
  const attachmentBufferById = new Map<string, Buffer>();
  const attachmentById = new Map(dbAttachments.map((item) => [item.id, item]));

  for (const attachment of dbAttachments) {
    if (!attachment.path) {
      warnings.push({ type: "attachment_no_path", attachmentId: attachment.id, noteId: attachment.noteId, message: "Attachment has no storage path" });
      continue;
    }
    try {
      const buffer = await readAttachmentObject(attachment.path);
      if (!buffer) {
        warnings.push({ type: "missing_attachment_file", attachmentId: attachment.id, noteId: attachment.noteId, path: attachment.path, message: "Attachment object not found" });
        continue;
      }
      attachmentBufferById.set(attachment.id, buffer);
    } catch (error) {
      warnings.push({ type: "attachment_read_failed", attachmentId: attachment.id, noteId: attachment.noteId, path: attachment.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const humanUsedNotePaths = new Set<string>();
  const formatStats = { markdown: 0, richText: 0, html: 0 };
  const noteManifest: Array<Record<string, unknown>> = [];
  const attachmentIdsByNote = new Map<string, string[]>();

  // Empty directories are explicit ZIP entries and are also represented by tree.json.
  if (includeHumanReadableTree && layout !== "flat") {
    for (const notebook of notebooks) zip.folder(pathById.get(notebook.id) || sanitizeSegment(notebook.name));
  }

  for (const note of notes) {
    const prepared = preparedById.get(note.id);
    const sourceFormat = note.contentFormat || "tiptap-json";
    const effectiveFormat = packageKind === "markdown" ? "markdown" : sourceFormat;
    let privateContent = packageKind === "markdown" ? prepared!.markdown : (note.content || "");
    let humanMarkdown = packageKind === "markdown" ? prepared!.markdown : "";
    const noteAttachmentIds = new Set<string>();

    for (const attachment of dbAttachments.filter((item) => item.noteId === note.id)) {
      const buffer = attachmentBufferById.get(attachment.id);
      if (!buffer) continue;
      noteAttachmentIds.add(attachment.id);
      const ext = path.extname(attachment.filename) || ".bin";
      const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
      let packagePath: string;
      if (includeHumanReadableTree) {
        const folder = layout === "flat" ? "" : (pathById.get(note.notebookId) || "未分类");
        const assetName = `att-${sanitizeSegment(attachment.id)}-${sanitizeSegment(attachment.filename)}`;
        packagePath = `${folder ? `${folder}/` : ""}assets/${assetName}`;
        if (packageKind === "markdown") {
          humanMarkdown = replaceAttachmentUrl(humanMarkdown, attachment.id, `./assets/${assetName}`);
        }
      } else {
        packagePath = `attachments/${sanitizeSegment(attachment.id)}/file${safeExt}`;
      }
      zip.file(packagePath, buffer);
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      packageAttachments.push({
        id: attachment.id,
        noteId: attachment.noteId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: buffer.length,
        createdAt: attachment.createdAt,
        sha256,
        packagePath,
        referencedInContent: contentReferencesAttachment(note.content || "", attachment.id) || contentReferencesAttachment(privateContent, attachment.id),
      });
      if (!includeHumanReadableTree) {
        zip.file(`attachments/${sanitizeSegment(attachment.id)}/meta.json`, JSON.stringify({
          ...attachment,
          file: path.basename(packagePath),
          sha256,
          packagePath,
        }, null, 2));
      }
    }

    if (packageKind === "markdown" && prepared) {
      let inlineIndex = 0;
      for (const asset of prepared.inlineAssets || []) {
        const relPath = normalizeInlinePath(asset.relPath);
        if (!relPath) {
          warnings.push({ type: "invalid_inline_asset_path", noteId: note.id, path: asset.relPath, message: "Inline asset path is invalid" });
          continue;
        }
        let buffer: Buffer;
        try {
          buffer = Buffer.from(asset.base64, "base64");
        } catch {
          warnings.push({ type: "invalid_inline_asset", noteId: note.id, path: relPath, message: "Inline asset is not valid base64" });
          continue;
        }
        if (!buffer.length) continue;
        inlineIndex += 1;
        const syntheticId = `inline-${note.id}-${inlineIndex}`;
        const folder = layout === "flat" ? "" : (pathById.get(note.notebookId) || "未分类");
        const packagePath = `${folder ? `${folder}/` : ""}${relPath}`;
        zip.file(packagePath, buffer);
        privateContent = replaceInlineAssetReference(privateContent, relPath, `/api/attachments/${syntheticId}`);
        noteAttachmentIds.add(syntheticId);
        packageAttachments.push({
          id: syntheticId,
          noteId: note.id,
          filename: path.basename(relPath),
          mimeType: null,
          size: buffer.length,
          createdAt: note.updatedAt,
          sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
          packagePath,
          referencedInContent: true,
          synthetic: true,
        });
      }

      const extracted = extractDataImages(privateContent, note.id);
      privateContent = extracted.content;
      for (const asset of extracted.assets) {
        const folder = layout === "flat" ? "" : (pathById.get(note.notebookId) || "未分类");
        const packagePath = `${folder ? `${folder}/` : ""}assets/${sanitizeSegment(asset.id)}-${sanitizeSegment(asset.filename)}`;
        zip.file(packagePath, asset.buffer);
        noteAttachmentIds.add(asset.id);
        packageAttachments.push({
          id: asset.id,
          noteId: note.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          size: asset.buffer.length,
          createdAt: note.updatedAt,
          sha256: crypto.createHash("sha256").update(asset.buffer).digest("hex"),
          packagePath,
          referencedInContent: true,
          synthetic: true,
        });
      }
    }

    const contentFileName = effectiveFormat === "markdown"
      ? "content.md"
      : effectiveFormat === "html"
        ? "content.html"
        : "content.tiptap.json";
    if (effectiveFormat === "markdown") formatStats.markdown += 1;
    else if (effectiveFormat === "html") formatStats.html += 1;
    else formatStats.richText += 1;

    const noteDir = `notes/${sanitizeSegment(note.id)}`;
    zip.file(`${noteDir}/${contentFileName}`, privateContent);
    const meta = {
      id: note.id,
      notebookId: note.notebookId,
      title: note.title,
      contentFormat: effectiveFormat,
      sourceContentFormat: sourceFormat,
      contentFile: contentFileName,
      contentText: note.contentText || "",
      isPinned: note.isPinned,
      isFavorite: note.isFavorite,
      isLocked: note.isLocked,
      isArchived: note.isArchived,
      version: note.version,
      sortOrder: note.sortOrder,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      tagIds: noteTags.filter((item) => item.noteId === note.id).map((item) => item.tagId),
      attachmentIds: Array.from(noteAttachmentIds),
    };
    zip.file(`${noteDir}/meta.json`, JSON.stringify(meta, null, 2));
    noteManifest.push({ ...meta, contentPath: `${noteDir}/${contentFileName}` });
    attachmentIdsByNote.set(note.id, Array.from(noteAttachmentIds));

    if (includeHumanReadableTree) {
      const folder = layout === "flat" ? "" : (pathById.get(note.notebookId) || "未分类");
      const prefix = folder ? `${folder}/` : "";
      const baseName = sanitizeSegment(note.title);
      let fileName = `${baseName}.md`;
      let index = 2;
      while (humanUsedNotePaths.has(`${prefix}${fileName}`)) fileName = `${baseName} (${index++}).md`;
      humanUsedNotePaths.add(`${prefix}${fileName}`);
      const frontmatter = [
        "---",
        `title: ${JSON.stringify(note.title)}`,
        `contentFormat: ${JSON.stringify("markdown")}`,
        `sourceContentFormat: ${JSON.stringify(sourceFormat)}`,
        `sourceId: ${JSON.stringify(note.id)}`,
        `created: ${note.createdAt}`,
        `updated: ${note.updatedAt}`,
        "---",
        "",
      ].join("\n");
      zip.file(`${prefix}${fileName}`, frontmatter + humanMarkdown);
    }
  }

  const tree = notebooks.map((notebook) => ({
    sourceId: notebook.id,
    type: "notebook",
    parentSourceId: notebook.parentId && notebookIds.has(notebook.parentId) ? notebook.parentId : null,
    name: notebook.name,
    exportName: exportNameById.get(notebook.id) || sanitizeSegment(notebook.name),
    exportPath: pathById.get(notebook.id) || sanitizeSegment(notebook.name),
    description: notebook.description,
    icon: notebook.icon,
    color: notebook.color,
    sortOrder: notebook.sortOrder,
    isExpanded: notebook.isExpanded,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
  }));

  // Compatibility files remain for v1 clients; v2 readers use tree/notes/attachments manifests.
  zip.file("notebooks.json", JSON.stringify(notebooks, null, 2));
  zip.file("tree.json", JSON.stringify({ version: 1, roots, nodes: tree }, null, 2));
  zip.file("notes.json", JSON.stringify({ version: 1, items: noteManifest }, null, 2));
  zip.file("attachments.json", JSON.stringify({ version: 1, items: packageAttachments }, null, 2));
  zip.file("tags.json", JSON.stringify(tags, null, 2));
  zip.file("note_tags.json", JSON.stringify(noteTags, null, 2));

  const stats: ExportStats = {
    notes: notes.length,
    notebooks: notebooks.length,
    tags: tags.length,
    noteTags: noteTags.length,
    attachments: packageAttachments.length,
    warnings: warnings.length,
  };
  zip.file("warnings.json", JSON.stringify({ version: 1, items: warnings }, null, 2));
  const now = new Date().toISOString();
  const exportBatchId = crypto.randomUUID();
  const manifest = {
    format: "nowen-package",
    formatVersion: 2,
    packageKind,
    app: "nowen-note",
    schemaVersion: getDbSchemaVersion(),
    exportedAt: now,
    exportBatchId,
    sourceInstanceId: process.env.NOWEN_INSTANCE_ID || null,
    scope: {
      type: notebookId ? "notebook" : noteIds ? "selection" : "all",
      workspaceId: workspaceId || null,
      notebookId: notebookId || null,
      includeSubNotebooks,
      includeTrashed,
      rootSourceIds: roots,
    },
    counts: {
      notebooks: stats.notebooks,
      notes: stats.notes,
      tags: stats.tags,
      noteTags: stats.noteTags,
      attachments: stats.attachments,
    },
    formatStats,
    warnings: {
      total: warnings.length,
      missingAttachments: warnings.filter((item) => item.type.includes("attachment") && item.type.includes("missing")).length,
    },
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  if (includeHumanReadableTree) {
    zip.file("metadata.json", JSON.stringify({
      version: "3.0",
      packageVersion: 2,
      app: "nowen-note",
      roundTripPackage: true,
      exportedAt: now,
      totalNotes: notes.length,
      totalNotebooks: notebooks.length,
      totalAttachments: packageAttachments.length,
      warnings: warnings.length,
    }, null, 2));
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const date = now.slice(0, 10);
  const filename = filenameBase
    ? `${sanitizeSegment(filenameBase)}.zip`
    : packageKind === "markdown"
      ? `nowen-note_backup_${date}.zip`
      : `nowen-package-${date}.nowen.zip`;
  return { buffer, filename, stats };
}
