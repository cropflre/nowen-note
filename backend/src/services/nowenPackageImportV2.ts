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
import { synchronizeRecoveredBlockAuthority } from "./blockAuthorityRecovery";

export type RoundTripImportMode = "new-root" | "into-target" | "merge";
export type RoundTripConflictStrategy = "copy" | "merge";

export interface ImportParams {
  userId: string;
  workspaceId?: string | null;
  targetNotebookId?: string;
  importMode?: RoundTripImportMode;
  dryRun?: boolean;
}

interface ImportWarning {
  type: string;
  message: string;
  id?: string;
  path?: string;
}

export interface ImportConflict {
  action: "rename-root" | "merge-directory" | "rename-note";
  resourceType: "notebook" | "note";
  sourceId: string;
  originalName: string;
  importedName: string;
  parentId: string | null;
  targetId?: string;
}

interface ImportResult {
  success: boolean;
  dryRun: boolean;
  strategy?: RoundTripConflictStrategy;
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
    mergedNotebooks?: number;
    renamedNotes?: number;
  };
  conflicts?: ImportConflict[];
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

interface NotebookPlan {
  source: NotebookMeta;
  targetId: string;
  parentTargetId: string | null;
  importedName: string;
  create: boolean;
}

const KNOWN_CONTENT_FORMATS = new Set(["markdown", "tiptap-json", "html"]);

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

function uniqueName(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  let index = 2;
  while (used.has(`${desired} (${index})`)) index += 1;
  const value = `${desired} (${index})`;
  used.add(value);
  return value;
}

function siblingNotebookRows(
  db: ReturnType<typeof getDb>,
  userId: string,
  workspaceId: string | null,
  parentId: string | null,
): Array<{ id: string; name: string }> {
  return workspaceId
    ? db.prepare(`
        SELECT id, name FROM notebooks
         WHERE workspaceId = ? AND parentId IS ? AND (isDeleted IS NULL OR isDeleted = 0)
         ORDER BY sortOrder, createdAt, id
      `).all(workspaceId, parentId) as Array<{ id: string; name: string }>
    : db.prepare(`
        SELECT id, name FROM notebooks
         WHERE userId = ? AND workspaceId IS NULL AND parentId IS ? AND (isDeleted IS NULL OR isDeleted = 0)
         ORDER BY sortOrder, createdAt, id
      `).all(userId, parentId) as Array<{ id: string; name: string }>;
}

function uniqueSiblingNotebookName(
  db: ReturnType<typeof getDb>,
  userId: string,
  workspaceId: string | null,
  parentId: string | null,
  desired: string,
  reserved: Set<string>,
): string {
  const used = new Set(siblingNotebookRows(db, userId, workspaceId, parentId).map((row) => row.name));
  for (const name of reserved) used.add(name);
  const value = uniqueName(desired, used);
  reserved.add(value);
  return value;
}

function findExistingNotebook(
  db: ReturnType<typeof getDb>,
  userId: string,
  workspaceId: string | null,
  parentId: string | null,
  name: string,
): { id: string; name: string } | undefined {
  return siblingNotebookRows(db, userId, workspaceId, parentId).find((row) => row.name === name);
}

function noteTitlesInNotebook(db: ReturnType<typeof getDb>, notebookId: string): string[] {
  return (db.prepare(`
    SELECT title FROM notes
     WHERE notebookId = ? AND (isTrashed IS NULL OR isTrashed = 0)
     ORDER BY sortOrder, createdAt, id
  `).all(notebookId) as Array<{ title: string }>).map((row) => row.title);
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
      if (meta.sha256 && meta.sha256 !== sha256) errors.push(`Attachment checksum mismatch: ${meta.filename || meta.id}`);
      if (meta.size != null && Number(meta.size) !== buffer.length) errors.push(`Attachment size mismatch: ${meta.filename || meta.id}`);
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
      if (!entry) errors.push(`Attachment file not found: ${packagePath}`);
      else {
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

function validateTargetNotebook(
  db: ReturnType<typeof getDb>,
  userId: string,
  targetNotebookId: string,
  expectedWorkspaceId: string | null,
): { id: string; workspaceId: string | null } {
  const target = db.prepare(`
    SELECT id, userId, workspaceId, isDeleted FROM notebooks WHERE id = ?
  `).get(targetNotebookId) as {
    id: string;
    userId: string;
    workspaceId: string | null;
    isDeleted: number;
  } | undefined;
  if (!target || target.isDeleted === 1) throw new Error("Target notebook not found or deleted");
  if (!target.workspaceId && target.userId !== userId) throw new Error("No permission to import into target notebook");
  const targetWorkspaceId = target.workspaceId || null;
  if (expectedWorkspaceId !== targetWorkspaceId) throw new Error("Target notebook is outside the selected import scope");
  assertWorkspaceWritable(userId, targetWorkspaceId);
  return { id: target.id, workspaceId: targetWorkspaceId };
}

function buildNotebookPlan(params: {
  db: ReturnType<typeof getDb>;
  sortedNotebooks: NotebookMeta[];
  userId: string;
  workspaceId: string | null;
  targetParentId: string | null;
  strategy: RoundTripConflictStrategy;
  conflicts: ImportConflict[];
}): { plans: NotebookPlan[]; idMap: Map<string, string>; rootSourceIds: Set<string> } {
  const { db, sortedNotebooks, userId, workspaceId, targetParentId, strategy, conflicts } = params;
  const sourceIds = new Set(sortedNotebooks.map((item) => item.id));
  const rootSourceIds = new Set(sortedNotebooks
    .filter((item) => !item.parentId || !sourceIds.has(item.parentId))
    .map((item) => item.id));
  const idMap = new Map<string, string>();
  const plans: NotebookPlan[] = [];
  const reservedRootNames = new Set<string>();

  for (const source of sortedNotebooks) {
    const parentTargetId = source.parentId && idMap.has(source.parentId)
      ? idMap.get(source.parentId)!
      : targetParentId;
    const isRoot = rootSourceIds.has(source.id);

    if (strategy === "merge") {
      const existing = findExistingNotebook(db, userId, workspaceId, parentTargetId, source.name);
      if (existing) {
        idMap.set(source.id, existing.id);
        plans.push({ source, targetId: existing.id, parentTargetId, importedName: existing.name, create: false });
        conflicts.push({
          action: "merge-directory",
          resourceType: "notebook",
          sourceId: source.id,
          originalName: source.name,
          importedName: existing.name,
          parentId: parentTargetId,
          targetId: existing.id,
        });
        continue;
      }
    }

    const targetId = uuid();
    const importedName = strategy === "copy" && isRoot
      ? uniqueSiblingNotebookName(db, userId, workspaceId, targetParentId, source.name, reservedRootNames)
      : source.name;
    idMap.set(source.id, targetId);
    plans.push({ source, targetId, parentTargetId, importedName, create: true });
    if (strategy === "copy" && importedName !== source.name) {
      conflicts.push({
        action: "rename-root",
        resourceType: "notebook",
        sourceId: source.id,
        originalName: source.name,
        importedName,
        parentId: targetParentId,
      });
    }
  }
  return { plans, idMap, rootSourceIds };
}

function buildNoteTitlePlan(params: {
  db: ReturnType<typeof getDb>;
  noteContents: Map<string, { content: string; meta: NoteMeta }>;
  notebookIdMap: Map<string, string>;
  fallbackRootId: string | null;
  strategy: RoundTripConflictStrategy;
  conflicts: ImportConflict[];
}): Map<string, string> {
  const { db, noteContents, notebookIdMap, fallbackRootId, strategy, conflicts } = params;
  const plan = new Map<string, string>();
  if (strategy !== "merge") {
    for (const [noteId, item] of noteContents) plan.set(noteId, item.meta.title);
    return plan;
  }

  const usedByNotebook = new Map<string, Set<string>>();
  for (const [noteId, item] of noteContents) {
    const targetNotebookId = notebookIdMap.get(item.meta.notebookId) || fallbackRootId;
    if (!targetNotebookId) continue;
    let used = usedByNotebook.get(targetNotebookId);
    if (!used) {
      used = new Set(noteTitlesInNotebook(db, targetNotebookId));
      usedByNotebook.set(targetNotebookId, used);
    }
    const importedName = uniqueName(item.meta.title, used);
    plan.set(noteId, importedName);
    if (importedName !== item.meta.title) {
      conflicts.push({
        action: "rename-note",
        resourceType: "note",
        sourceId: noteId,
        originalName: item.meta.title,
        importedName,
        parentId: targetNotebookId,
      });
    }
  }
  return plan;
}

export async function importNowenPackageV2(zipBuffer: Buffer, params: ImportParams): Promise<ImportResult> {
  const {
    userId,
    workspaceId = null,
    targetNotebookId,
    importMode = "new-root",
    dryRun = false,
  } = params;
  const strategy: RoundTripConflictStrategy = importMode === "merge" ? "merge" : "copy";
  const warnings: ImportWarning[] = [];
  const errors: string[] = [];
  const conflicts: ImportConflict[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (error) {
    return { success: false, dryRun, strategy, warnings, errors: [`Failed to parse ZIP: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const forbiddenFiles = [
    "db.sqlite", ".jwt_secret", "users.json", "passwordHash",
    "system_settings", "system_settings.json", "shares.json", "shareToken",
  ];
  for (const filename of forbiddenFiles) {
    if (zip.file(filename)) return { success: false, dryRun, strategy, warnings, errors: [`Package contains forbidden file: ${filename}`] };
  }
  for (const filename of Object.keys(zip.files)) {
    if (!isSafeZipPath(filename)) return { success: false, dryRun, strategy, warnings, errors: [`Unsafe path in package: ${filename}`] };
  }

  const manifest = await readJson<Manifest>(zip, "manifest.json");
  if (!manifest) return { success: false, dryRun, strategy, warnings, errors: ["manifest.json not found or invalid"] };
  if (manifest.format !== "nowen-package") return { success: false, dryRun, strategy, warnings, errors: [`Invalid package format: ${manifest.format}`] };
  if (![1, 2].includes(manifest.formatVersion)) {
    return { success: false, dryRun, strategy, warnings, errors: [`Unsupported formatVersion: ${manifest.formatVersion}`] };
  }
  if (manifest.schemaVersion && manifest.schemaVersion > getDbSchemaVersion()) {
    return { success: false, dryRun, strategy, warnings, errors: [`Package schemaVersion (${manifest.schemaVersion}) is newer than current (${getDbSchemaVersion()}). Please upgrade first.`] };
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
  for (const name of Object.keys(zip.files)) {
    const match = name.match(/^notes\/([^/]+)\/meta\.json$/);
    if (!match) continue;
    const noteId = match[1];
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
  const attachmentData = await readAttachmentEntries(zip, manifest.formatVersion, warnings, errors);

  const db = getDb();
  let resolvedWorkspaceId = workspaceId;
  let targetParentId: string | null = null;
  try {
    assertWorkspaceWritable(userId, resolvedWorkspaceId);
    if (importMode === "into-target" && !targetNotebookId) throw new Error("Target notebook is required for into-target mode");
    if (targetNotebookId) {
      const target = validateTargetNotebook(db, userId, targetNotebookId, resolvedWorkspaceId);
      resolvedWorkspaceId = target.workspaceId;
      targetParentId = target.id;
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let sortedNotebooks: NotebookMeta[] = [];
  try {
    sortedNotebooks = sortNotebooks(notebooks);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const notebookPlan = buildNotebookPlan({
    db,
    sortedNotebooks,
    userId,
    workspaceId: resolvedWorkspaceId,
    targetParentId,
    strategy,
    conflicts,
  });

  let fallbackRootId = notebookPlan.plans.find((plan) => notebookPlan.rootSourceIds.has(plan.source.id))?.targetId
    || targetParentId
    || null;
  let fallbackRootNeedsCreate = false;
  let fallbackRootName = "导入的内容";
  if (!fallbackRootId && noteContents.size) {
    if (strategy === "merge") {
      const existing = findExistingNotebook(db, userId, resolvedWorkspaceId, null, fallbackRootName);
      if (existing) {
        fallbackRootId = existing.id;
        conflicts.push({
          action: "merge-directory",
          resourceType: "notebook",
          sourceId: "__fallback__",
          originalName: fallbackRootName,
          importedName: existing.name,
          parentId: null,
          targetId: existing.id,
        });
      }
    }
    if (!fallbackRootId) {
      fallbackRootId = uuid();
      fallbackRootNeedsCreate = true;
      if (strategy === "copy") {
        fallbackRootName = uniqueSiblingNotebookName(db, userId, resolvedWorkspaceId, null, fallbackRootName, new Set());
      }
    }
  }

  const noteTitlePlan = buildNoteTitlePlan({
    db,
    noteContents,
    notebookIdMap: notebookPlan.idMap,
    fallbackRootId,
    strategy,
    conflicts,
  });

  for (const [attachmentId, item] of attachmentData) {
    if (!noteContents.has(item.meta.noteId)) errors.push(`Attachment ${attachmentId} points to missing note ${item.meta.noteId}`);
    if (!item.buffer) errors.push(`Attachment file is missing: ${item.meta.filename || attachmentId}`);
  }

  const createdNotebookCount = notebookPlan.plans.filter((plan) => plan.create).length + (fallbackRootNeedsCreate ? 1 : 0);
  const mergedNotebookCount = conflicts.filter((item) => item.action === "merge-directory").length;
  const renamedRootCount = conflicts.filter((item) => item.action === "rename-root").length;
  const renamedNoteCount = conflicts.filter((item) => item.action === "rename-note").length;
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
  const actionCounts = {
    notebooks: createdNotebookCount,
    notes: noteContents.size,
    tags: tags.length,
    noteTags: noteTags.length,
    attachments: Array.from(attachmentData.values()).filter((item) => !!item.buffer).length,
    renamedRoots: renamedRootCount,
    mergedNotebooks: mergedNotebookCount,
    renamedNotes: renamedNoteCount,
  };

  if (dryRun || errors.length) {
    return {
      success: errors.length === 0,
      dryRun,
      strategy,
      package: packagePreview,
      counts: actionCounts,
      conflicts,
      warnings,
      errors,
    };
  }

  const noteIdMap = new Map<string, string>();
  const tagIdMap = new Map<string, string>();
  const attachmentIdMap = new Map<string, string>();
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
    return {
      success: false,
      dryRun: false,
      strategy,
      package: packagePreview,
      counts: actionCounts,
      conflicts,
      warnings,
      errors: [`Attachment restore failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const importedRootIds = notebookPlan.plans
    .filter((plan) => notebookPlan.rootSourceIds.has(plan.source.id))
    .map((plan) => plan.targetId);
  if (!importedRootIds.length && fallbackRootId) importedRootIds.push(fallbackRootId);

  try {
    db.exec("BEGIN TRANSACTION");

    for (const plan of notebookPlan.plans) {
      if (!plan.create) continue;
      const notebook = plan.source;
      db.prepare(`
        INSERT INTO notebooks (
          id, userId, workspaceId, parentId, name, description, icon, color,
          sortOrder, isExpanded, isDeleted, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        plan.targetId, userId, resolvedWorkspaceId, plan.parentTargetId, plan.importedName,
        notebook.description, notebook.icon, notebook.color, notebook.sortOrder,
        notebook.isExpanded, notebook.createdAt, notebook.updatedAt,
      );
    }

    if (fallbackRootNeedsCreate && fallbackRootId) {
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder, isExpanded, isDeleted)
        VALUES (?, ?, ?, NULL, ?, ?, 0, 1, 0)
      `).run(fallbackRootId, userId, resolvedWorkspaceId, fallbackRootName, "📥");
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
      const notebookId = notebookPlan.idMap.get(meta.notebookId) || fallbackRootId;
      if (!notebookId) throw new Error(`No target notebook for note ${oldId}`);
      const rewritten = rewriteIdReferences(content, attachmentIdMap, noteIdMap);
      for (const attachmentId of rewritten.unmappedAttachmentIds) {
        warnings.push({ type: "attachment_ref_unmapped", id: attachmentId, message: `Attachment ${attachmentId} was not restored` });
      }
      const contentFormat = KNOWN_CONTENT_FORMATS.has(meta.contentFormat) ? meta.contentFormat : "tiptap-json";
      db.prepare(`
        INSERT INTO notes (
          id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
          isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        newId, userId, resolvedWorkspaceId, notebookId, noteTitlePlan.get(oldId) || meta.title,
        rewritten.content, meta.contentText || "", contentFormat, meta.isPinned || 0,
        meta.isFavorite || 0, meta.isLocked || 0, meta.isArchived || 0,
        meta.version || 1, meta.sortOrder || 0, meta.createdAt, meta.updatedAt,
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
      catch (error) {
        warnings.push({
          type: "attachment_reference_index_failed",
          id: noteId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const recovery = synchronizeRecoveredBlockAuthority(db, rewrittenByNewNoteId.keys());
    for (const failure of recovery.failures) {
      warnings.push({
        type: "block_authority_recovery_failed",
        id: failure.noteId,
        message: `Block 权威状态同步失败，已保留兼容快照：${failure.error}`,
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    await Promise.all(writtenStoragePaths.map((storagePath) => deleteAttachmentObject(storagePath).catch(() => undefined)));
    return {
      success: false,
      dryRun: false,
      strategy,
      package: packagePreview,
      counts: actionCounts,
      conflicts,
      warnings,
      errors: [`Import failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return {
    success: true,
    dryRun: false,
    strategy,
    rootNotebookId: importedRootIds[0],
    rootNotebookIds: importedRootIds,
    package: packagePreview,
    counts: {
      ...actionCounts,
      tags: tagIdMap.size,
      attachments: validAttachments.length,
    },
    conflicts,
    warnings,
    errors: [],
  };
}
