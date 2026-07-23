import crypto from "crypto";
import path from "path";
import JSZip from "jszip";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  writeAttachmentObject,
} from "./attachment-storage";
import { ensureRoundTripImportLinksSchema } from "../db/roundtripImportLinksMigration";
import {
  importNowenPackageV2,
  type ImportConflict,
  type ImportParams as V2ImportParams,
} from "./nowenPackageImportV2";

export type RoundTripSyncImportMode = "new-root" | "into-target" | "merge" | "sync";
export type RoundTripSyncStrategy = "copy" | "merge" | "sync";

export interface RoundTripImportParams extends Omit<V2ImportParams, "importMode"> {
  importMode?: RoundTripSyncImportMode;
}

interface Manifest {
  format: string;
  formatVersion: number;
  app: string;
  exportedAt: string;
  exportBatchId?: string;
  sourceInstanceId?: string | null;
  packageKind?: string;
  schemaVersion?: number;
  formatStats?: { markdown?: number; richText?: number; html?: number };
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
  createdAt: string;
  sha256?: string;
  packagePath?: string;
}

interface SourceNote {
  meta: NoteMeta;
  content: string;
  sourceHash: string;
}

interface SourceAttachment {
  meta: AttachmentMeta;
  buffer: Buffer;
  sourceHash: string;
}

interface PackageModel {
  manifest: Manifest;
  notebooks: NotebookMeta[];
  notes: Map<string, SourceNote>;
  tags: TagMeta[];
  noteTags: Array<{ noteId: string; tagId: string }>;
  attachments: Map<string, SourceAttachment>;
}

interface LinkRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  workspaceScope: string;
  sourceInstanceId: string;
  resourceType: "notebook" | "note" | "attachment";
  sourceResourceId: string;
  targetResourceId: string;
  sourceHash: string | null;
  targetHash: string | null;
  lastExportBatchId: string | null;
  metadata: string | null;
}

interface NotebookRow {
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

interface NoteRow {
  id: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  rowid?: number;
}

interface AttachmentRow {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
  createdAt: string;
  rowid?: number;
}

export interface ImportTargetSnapshot {
  notebookIds: Set<string>;
  noteIds: Set<string>;
  attachmentIds: Set<string>;
}

interface SyncNotebookPlan {
  source: NotebookMeta;
  sourceHash: string;
  targetId: string;
  parentTargetId: string | null;
  importedName: string;
  action: "create" | "recreate" | "update" | "unchanged" | "local-conflict";
  link?: LinkRow;
}

interface SyncNotePlan {
  source: SourceNote;
  targetId: string;
  notebookId: string;
  importedTitle: string;
  action: "create" | "recreate" | "update" | "unchanged" | "local-conflict";
  link?: LinkRow;
}

interface SyncAttachmentPlan {
  source: SourceAttachment;
  targetId: string;
  targetNoteId: string;
  action: "create" | "replace" | "reuse" | "ignore";
  storagePath?: string;
  oldTargetId?: string;
  link?: LinkRow;
}

const KNOWN_CONTENT_FORMATS = new Set(["markdown", "tiptap-json", "html"]);
const SOURCE_INSTANCE_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

function workspaceScope(workspaceId: string | null | undefined): string {
  return workspaceId || "personal";
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceNotebookHash(item: NotebookMeta): string {
  return hash({
    parentId: item.parentId,
    name: item.name,
    description: item.description,
    icon: item.icon,
    color: item.color,
    sortOrder: item.sortOrder,
    isExpanded: item.isExpanded,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}

function targetNotebookHash(item: NotebookRow): string {
  return hash({
    parentId: item.parentId,
    name: item.name,
    description: item.description,
    icon: item.icon,
    color: item.color,
    sortOrder: item.sortOrder,
    isExpanded: item.isExpanded,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}

function sourceNoteHash(
  meta: NoteMeta,
  content: string,
  attachments: SourceAttachment[],
): string {
  return hash({
    notebookId: meta.notebookId,
    title: meta.title,
    content,
    contentText: meta.contentText,
    contentFormat: meta.contentFormat,
    isPinned: meta.isPinned,
    isFavorite: meta.isFavorite,
    isLocked: meta.isLocked,
    isArchived: meta.isArchived,
    sortOrder: meta.sortOrder,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    tagIds: [...(meta.tagIds || [])].sort(),
    attachments: attachments
      .map((item) => ({
        id: item.meta.id,
        filename: item.meta.filename,
        mimeType: item.meta.mimeType,
        size: item.meta.size,
        sha256: item.sourceHash,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function targetNoteHash(db: ReturnType<typeof getDb>, noteId: string): string | null {
  const note = db.prepare(`
    SELECT id, notebookId, title, content, contentText, contentFormat,
           isPinned, isFavorite, isLocked, isArchived, sortOrder, createdAt, updatedAt
      FROM notes
     WHERE id = ? AND (isTrashed IS NULL OR isTrashed = 0)
  `).get(noteId) as NoteRow | undefined;
  if (!note) return null;
  const attachments = db.prepare(`
    SELECT id, filename, mimeType, size, path, hash, createdAt
      FROM attachments
     WHERE noteId = ?
     ORDER BY id
  `).all(noteId) as Array<Omit<AttachmentRow, "noteId">>;
  return hash({
    notebookId: note.notebookId,
    title: note.title,
    content: note.content,
    contentText: note.contentText,
    contentFormat: note.contentFormat,
    isPinned: note.isPinned,
    isFavorite: note.isFavorite,
    isLocked: note.isLocked,
    isArchived: note.isArchived,
    sortOrder: note.sortOrder,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    attachments: attachments.map((item) => ({
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size,
      identity: item.hash || item.path,
      createdAt: item.createdAt,
    })),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteIdReferences(
  content: string,
  attachmentMap: Map<string, string>,
  noteMap: Map<string, string>,
): { content: string; unmappedAttachmentIds: string[] } {
  let out = String(content || "");
  const unmapped = new Set<string>();
  out = out.replace(/\/api\/attachments\/([^/?#\s)"'<>]+)/gi, (match, encodedId: string) => {
    let sourceId = encodedId;
    try { sourceId = decodeURIComponent(encodedId); } catch { /* keep raw */ }
    const targetId = attachmentMap.get(sourceId);
    if (!targetId) {
      unmapped.add(sourceId);
      return match;
    }
    return `/api/attachments/${targetId}`;
  });
  for (const [sourceId, targetId] of noteMap) {
    const escaped = escapeRegExp(sourceId);
    out = out
      .replace(new RegExp(`note:${escaped}(?=[$#?\\s)\"'<>]|$)`, "g"), `note:${targetId}`)
      .replace(new RegExp(`nowen:\\/\\/note\\/${escaped}(?=[$#?\\s)\"'<>]|$)`, "g"), `nowen://note/${targetId}`);
  }
  return { content: out, unmappedAttachmentIds: Array.from(unmapped) };
}

function safeExtension(filename: string): string {
  const ext = path.extname(filename || "") || ".bin";
  const cleaned = ext.replace(/[^a-zA-Z0-9.]/g, "");
  return cleaned && cleaned !== "." ? cleaned : ".bin";
}

async function readJson<T>(zip: JSZip, filename: string): Promise<T | null> {
  const entry = zip.file(filename);
  if (!entry) return null;
  try { return JSON.parse(await entry.async("string")) as T; }
  catch { return null; }
}

function sortNotebooks(items: NotebookMeta[]): NotebookMeta[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const output: NotebookMeta[] = [];
  const visit = (item: NotebookMeta): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) throw new Error(`Notebook cycle detected at ${item.id}`);
    visiting.add(item.id);
    if (item.parentId && byId.has(item.parentId)) visit(byId.get(item.parentId)!);
    visiting.delete(item.id);
    visited.add(item.id);
    output.push(item);
  };
  for (const item of items) visit(item);
  return output;
}

async function parsePackage(zipBuffer: Buffer): Promise<PackageModel> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const manifest = await readJson<Manifest>(zip, "manifest.json");
  if (!manifest || manifest.format !== "nowen-package" || manifest.app !== "nowen-note") {
    throw new Error("Invalid Nowen round-trip package manifest");
  }

  const tree = await readJson<{ nodes?: Array<Record<string, unknown>> }>(zip, "tree.json");
  let notebooks: NotebookMeta[] = [];
  if (Array.isArray(tree?.nodes)) {
    notebooks = tree!.nodes!.map((raw) => ({
      id: String(raw.sourceId || ""),
      parentId: raw.parentSourceId ? String(raw.parentSourceId) : null,
      name: String(raw.name || "未命名"),
      description: raw.description == null ? null : String(raw.description),
      icon: raw.icon == null ? null : String(raw.icon),
      color: raw.color == null ? null : String(raw.color),
      sortOrder: Number(raw.sortOrder) || 0,
      isExpanded: Number(raw.isExpanded) || 0,
      createdAt: String(raw.createdAt || ""),
      updatedAt: String(raw.updatedAt || raw.createdAt || ""),
    })).filter((item) => item.id);
  } else {
    notebooks = (await readJson<NotebookMeta[]>(zip, "notebooks.json")) || [];
  }
  notebooks = sortNotebooks(notebooks);

  const attachmentManifest = await readJson<{ items?: AttachmentMeta[] }>(zip, "attachments.json");
  const attachments = new Map<string, SourceAttachment>();
  for (const meta of attachmentManifest?.items || []) {
    if (!meta.id || !meta.noteId || !meta.packagePath) continue;
    const entry = zip.file(meta.packagePath);
    if (!entry) throw new Error(`Attachment file not found: ${meta.packagePath}`);
    const buffer = Buffer.from(await entry.async("arraybuffer"));
    const sourceHash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (meta.sha256 && meta.sha256 !== sourceHash) {
      throw new Error(`Attachment checksum mismatch: ${meta.filename || meta.id}`);
    }
    attachments.set(meta.id, { meta: { ...meta, sha256: sourceHash }, buffer, sourceHash });
  }

  const notes = new Map<string, SourceNote>();
  for (const filename of Object.keys(zip.files)) {
    const match = filename.match(/^notes\/([^/]+)\/meta\.json$/);
    if (!match) continue;
    const sourceId = match[1];
    const meta = await readJson<NoteMeta>(zip, `notes/${sourceId}/meta.json`);
    if (!meta) throw new Error(`Invalid note metadata: ${sourceId}`);
    const contentEntry = zip.file(`notes/${sourceId}/${meta.contentFile}`);
    if (!contentEntry) throw new Error(`Note content not found: ${sourceId}/${meta.contentFile}`);
    const content = await contentEntry.async("string");
    const noteAttachments = Array.from(attachments.values()).filter((item) => item.meta.noteId === sourceId);
    notes.set(sourceId, {
      meta,
      content,
      sourceHash: sourceNoteHash(meta, content, noteAttachments),
    });
  }

  return {
    manifest,
    notebooks,
    notes,
    tags: (await readJson<TagMeta[]>(zip, "tags.json")) || [],
    noteTags: (await readJson<Array<{ noteId: string; tagId: string }>>(zip, "note_tags.json")) || [],
    attachments,
  };
}

function scopeWhere(workspaceId: string | null): { sql: string; params: unknown[] } {
  return workspaceId
    ? { sql: "workspaceId = ?", params: [workspaceId] }
    : { sql: "workspaceId IS NULL", params: [] };
}

export function captureRoundTripImportSnapshot(
  userId: string,
  workspaceId: string | null,
): ImportTargetSnapshot {
  const db = getDb();
  const scope = scopeWhere(workspaceId);
  const notebooks = db.prepare(`SELECT id FROM notebooks WHERE userId = ? AND ${scope.sql}`).all(userId, ...scope.params) as Array<{ id: string }>;
  const notes = db.prepare(`SELECT id FROM notes WHERE userId = ? AND ${scope.sql}`).all(userId, ...scope.params) as Array<{ id: string }>;
  const attachments = db.prepare(`
    SELECT a.id
      FROM attachments a
      JOIN notes n ON n.id = a.noteId
     WHERE n.userId = ? AND n.${scope.sql}
  `).all(userId, ...scope.params) as Array<{ id: string }>;
  return {
    notebookIds: new Set(notebooks.map((item) => item.id)),
    noteIds: new Set(notes.map((item) => item.id)),
    attachmentIds: new Set(attachments.map((item) => item.id)),
  };
}

function loadLinks(
  db: ReturnType<typeof getDb>,
  userId: string,
  workspaceId: string | null,
  sourceInstanceId: string,
): LinkRow[] {
  ensureRoundTripImportLinksSchema(db);
  return db.prepare(`
    SELECT * FROM roundtrip_import_links
     WHERE userId = ? AND workspaceScope = ? AND sourceInstanceId = ?
  `).all(userId, workspaceScope(workspaceId), sourceInstanceId) as LinkRow[];
}

function linkKey(resourceType: LinkRow["resourceType"], sourceResourceId: string): string {
  return `${resourceType}:${sourceResourceId}`;
}

function linkMap(rows: LinkRow[]): Map<string, LinkRow> {
  return new Map(rows.map((row) => [linkKey(row.resourceType, row.sourceResourceId), row]));
}

function upsertLink(db: ReturnType<typeof getDb>, args: {
  userId: string;
  workspaceId: string | null;
  sourceInstanceId: string;
  resourceType: LinkRow["resourceType"];
  sourceResourceId: string;
  targetResourceId: string;
  sourceHash: string;
  targetHash: string;
  exportBatchId?: string;
  metadata?: Record<string, unknown>;
}): void {
  db.prepare(`
    INSERT INTO roundtrip_import_links (
      id, userId, workspaceId, workspaceScope, sourceInstanceId, resourceType,
      sourceResourceId, targetResourceId, sourceHash, targetHash,
      lastExportBatchId, importedAt, updatedAt, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
    ON CONFLICT(userId, workspaceScope, sourceInstanceId, resourceType, sourceResourceId)
    DO UPDATE SET
      workspaceId = excluded.workspaceId,
      targetResourceId = excluded.targetResourceId,
      sourceHash = excluded.sourceHash,
      targetHash = excluded.targetHash,
      lastExportBatchId = excluded.lastExportBatchId,
      updatedAt = datetime('now'),
      metadata = excluded.metadata
  `).run(
    uuid(), args.userId, args.workspaceId, workspaceScope(args.workspaceId),
    args.sourceInstanceId, args.resourceType, args.sourceResourceId, args.targetResourceId,
    args.sourceHash, args.targetHash, args.exportBatchId || null,
    JSON.stringify(args.metadata || {}),
  );
}

function touchLinkBatch(db: ReturnType<typeof getDb>, link: LinkRow, exportBatchId?: string): void {
  db.prepare(`
    UPDATE roundtrip_import_links
       SET lastExportBatchId = ?, updatedAt = datetime('now')
     WHERE id = ?
  `).run(exportBatchId || null, link.id);
}

function notebookRowsForScope(userId: string, workspaceId: string | null): NotebookRow[] {
  const scope = scopeWhere(workspaceId);
  return getDb().prepare(`
    SELECT id, parentId, name, description, icon, color, sortOrder, isExpanded, createdAt, updatedAt
      FROM notebooks
     WHERE userId = ? AND ${scope.sql} AND (isDeleted IS NULL OR isDeleted = 0)
  `).all(userId, ...scope.params) as NotebookRow[];
}

function noteRowsForScope(userId: string, workspaceId: string | null): NoteRow[] {
  const scope = scopeWhere(workspaceId);
  return getDb().prepare(`
    SELECT rowid, id, notebookId, title, content, contentText, contentFormat,
           isPinned, isFavorite, isLocked, isArchived, version, sortOrder, createdAt, updatedAt
      FROM notes
     WHERE userId = ? AND ${scope.sql} AND (isTrashed IS NULL OR isTrashed = 0)
     ORDER BY rowid
  `).all(userId, ...scope.params) as NoteRow[];
}

function attachmentRowsForScope(userId: string, workspaceId: string | null): AttachmentRow[] {
  const scope = scopeWhere(workspaceId);
  return getDb().prepare(`
    SELECT a.rowid, a.id, a.noteId, a.filename, a.mimeType, a.size, a.path, a.hash, a.createdAt
      FROM attachments a
      JOIN notes n ON n.id = a.noteId
     WHERE n.userId = ? AND n.${scope.sql}
     ORDER BY a.rowid
  `).all(userId, ...scope.params) as AttachmentRow[];
}

function withSyncAvailability(result: any, model: PackageModel, userId: string, workspaceId: string | null): any {
  const sourceInstanceId = String(model.manifest.sourceInstanceId || "").trim();
  const validIdentity = SOURCE_INSTANCE_PATTERN.test(sourceInstanceId);
  const linkedResources = validIdentity
    ? loadLinks(getDb(), userId, workspaceId, sourceInstanceId).length
    : 0;
  const packageKind = model.manifest.packageKind || "nowen";
  const available = packageKind !== "markdown" && validIdentity && linkedResources > 0;
  result.package = {
    ...(result.package || {}),
    sourceInstanceId: validIdentity ? sourceInstanceId : null,
    exportBatchId: model.manifest.exportBatchId || null,
    sync: {
      available,
      linkedResources,
      reason: packageKind === "markdown"
        ? "Markdown 往返包发生过格式转换，不支持覆盖同步"
        : !validIdentity
          ? "数据包没有稳定的 sourceInstanceId，请重新导出"
          : linkedResources === 0
            ? "当前空间尚未导入过该来源，请先创建副本或合并导入"
            : null,
    },
  };
  return result;
}

function rootsOf(model: PackageModel): NotebookMeta[] {
  const ids = new Set(model.notebooks.map((item) => item.id));
  return model.notebooks.filter((item) => !item.parentId || !ids.has(item.parentId));
}

export async function recordRoundTripLinksAfterImport(args: {
  zipBuffer: Buffer;
  userId: string;
  workspaceId: string | null;
  snapshot: ImportTargetSnapshot;
  result: any;
}): Promise<void> {
  const model = await parsePackage(args.zipBuffer);
  const sourceInstanceId = String(model.manifest.sourceInstanceId || "").trim();
  if (model.manifest.packageKind === "markdown" || !SOURCE_INSTANCE_PATTERN.test(sourceInstanceId)) return;

  const db = getDb();
  ensureRoundTripImportLinksSchema(db);
  const conflicts = (args.result.conflicts || []) as ImportConflict[];
  const mergedBySource = new Map(conflicts
    .filter((item) => item.action === "merge-directory" && item.targetId)
    .map((item) => [item.sourceId, item.targetId!]));
  const renamedNoteBySource = new Map(conflicts
    .filter((item) => item.action === "rename-note")
    .map((item) => [item.sourceId, item.importedName]));

  const allNotebooks = notebookRowsForScope(args.userId, args.workspaceId);
  const newNotebookIds = new Set(allNotebooks.filter((item) => !args.snapshot.notebookIds.has(item.id)).map((item) => item.id));
  const targetNotebookById = new Map(allNotebooks.map((item) => [item.id, item]));
  const notebookMap = new Map<string, string>();
  const usedNotebookTargets = new Set<string>();
  const roots = rootsOf(model);
  const importedRoots = (args.result.rootNotebookIds || []) as string[];
  roots.forEach((source, index) => {
    const targetId = mergedBySource.get(source.id) || importedRoots[index];
    if (targetId) {
      notebookMap.set(source.id, targetId);
      usedNotebookTargets.add(targetId);
    }
  });

  for (const source of model.notebooks) {
    if (notebookMap.has(source.id)) continue;
    const explicit = mergedBySource.get(source.id);
    if (explicit) {
      notebookMap.set(source.id, explicit);
      usedNotebookTargets.add(explicit);
      continue;
    }
    const parentId = source.parentId ? notebookMap.get(source.parentId) : null;
    const candidates = allNotebooks.filter((item) =>
      !usedNotebookTargets.has(item.id)
      && newNotebookIds.has(item.id)
      && item.parentId === (parentId || null)
      && item.name === source.name,
    ).sort((a, b) =>
      Number(a.sortOrder === source.sortOrder ? -1 : 0)
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id),
    );
    const target = candidates[0];
    if (target) {
      notebookMap.set(source.id, target.id);
      usedNotebookTargets.add(target.id);
    }
  }

  const allNotes = noteRowsForScope(args.userId, args.workspaceId);
  const newNotes = allNotes.filter((item) => !args.snapshot.noteIds.has(item.id));
  const usedNotes = new Set<string>();
  const noteMap = new Map<string, string>();
  for (const [sourceId, source] of model.notes) {
    const notebookId = notebookMap.get(source.meta.notebookId);
    if (!notebookId) continue;
    const title = renamedNoteBySource.get(sourceId) || source.meta.title;
    const candidate = newNotes.find((item) =>
      !usedNotes.has(item.id)
      && item.notebookId === notebookId
      && item.title === title
      && item.contentFormat === (KNOWN_CONTENT_FORMATS.has(source.meta.contentFormat) ? source.meta.contentFormat : "tiptap-json")
      && item.sortOrder === (source.meta.sortOrder || 0),
    ) || newNotes.find((item) => !usedNotes.has(item.id) && item.notebookId === notebookId && item.title === title);
    if (candidate) {
      noteMap.set(sourceId, candidate.id);
      usedNotes.add(candidate.id);
    }
  }

  const allAttachments = attachmentRowsForScope(args.userId, args.workspaceId);
  const newAttachments = allAttachments.filter((item) => !args.snapshot.attachmentIds.has(item.id));
  const usedAttachments = new Set<string>();
  const attachmentMap = new Map<string, string>();
  for (const [sourceId, source] of model.attachments) {
    const noteId = noteMap.get(source.meta.noteId);
    if (!noteId) continue;
    const candidate = newAttachments.find((item) =>
      !usedAttachments.has(item.id)
      && item.noteId === noteId
      && item.filename === source.meta.filename
      && Number(item.size) === source.buffer.length
      && item.mimeType === (source.meta.mimeType || "application/octet-stream"),
    );
    if (candidate) {
      attachmentMap.set(sourceId, candidate.id);
      usedAttachments.add(candidate.id);
    }
  }

  const transaction = db.transaction(() => {
    for (const source of model.notebooks) {
      const targetId = notebookMap.get(source.id);
      const target = targetId ? targetNotebookById.get(targetId) : undefined;
      if (!targetId || !target) continue;
      upsertLink(db, {
        userId: args.userId,
        workspaceId: args.workspaceId,
        sourceInstanceId,
        resourceType: "notebook",
        sourceResourceId: source.id,
        targetResourceId: targetId,
        sourceHash: sourceNotebookHash(source),
        targetHash: targetNotebookHash(target),
        exportBatchId: model.manifest.exportBatchId,
        metadata: { name: source.name },
      });
    }
    for (const [sourceId, source] of model.notes) {
      const targetId = noteMap.get(sourceId);
      const targetHash = targetId ? targetNoteHash(db, targetId) : null;
      if (!targetId || !targetHash) continue;
      upsertLink(db, {
        userId: args.userId,
        workspaceId: args.workspaceId,
        sourceInstanceId,
        resourceType: "note",
        sourceResourceId: sourceId,
        targetResourceId: targetId,
        sourceHash: source.sourceHash,
        targetHash,
        exportBatchId: model.manifest.exportBatchId,
        metadata: { title: source.meta.title, sourceNotebookId: source.meta.notebookId },
      });
    }
    for (const [sourceId, source] of model.attachments) {
      const targetId = attachmentMap.get(sourceId);
      if (!targetId) continue;
      upsertLink(db, {
        userId: args.userId,
        workspaceId: args.workspaceId,
        sourceInstanceId,
        resourceType: "attachment",
        sourceResourceId: sourceId,
        targetResourceId: targetId,
        sourceHash: source.sourceHash,
        targetHash: source.sourceHash,
        exportBatchId: model.manifest.exportBatchId,
        metadata: { filename: source.meta.filename, sourceNoteId: source.meta.noteId },
      });
    }
  });
  transaction();
}

function uniqueName(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  let index = 2;
  while (used.has(`${desired} (${index})`)) index += 1;
  const result = `${desired} (${index})`;
  used.add(result);
  return result;
}

function parseLinkMetadata(link: LinkRow): Record<string, unknown> {
  try { return link.metadata ? JSON.parse(link.metadata) as Record<string, unknown> : {}; }
  catch { return {}; }
}

async function removeAttachmentObjects(rows: AttachmentRow[], warnings: any[]): Promise<void> {
  const db = getDb();
  for (const row of rows) {
    try {
      const other = db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE path = ?").get(row.path) as { count: number };
      if (!other.count) await deleteAttachmentObject(row.path);
    } catch (error) {
      warnings.push({
        type: "attachment_cleanup_failed",
        id: row.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function importRoundTripPackageSync(
  zipBuffer: Buffer,
  params: RoundTripImportParams,
): Promise<any> {
  const validation = await importNowenPackageV2(zipBuffer, {
    userId: params.userId,
    workspaceId: params.workspaceId,
    targetNotebookId: undefined,
    importMode: "new-root",
    dryRun: true,
  });
  if (!validation.success) return { ...validation, strategy: "sync" };

  const model = await parsePackage(zipBuffer);
  const workspaceId = params.workspaceId || null;
  const sourceInstanceId = String(model.manifest.sourceInstanceId || "").trim();
  const errors: string[] = [];
  const warnings: Array<{ type: string; message: string; id?: string }> = [];
  const conflicts: Array<ImportConflict | {
    action: "sync-create-directory" | "sync-update-directory" | "sync-create-note" | "sync-update-note" | "sync-local-conflict" | "sync-replace-attachment";
    resourceType: "notebook" | "note" | "attachment";
    sourceId: string;
    originalName: string;
    importedName: string;
    parentId: string | null;
    targetId?: string;
  }> = [];

  if (model.manifest.packageKind === "markdown") {
    errors.push("Markdown 往返包发生过格式转换，不能使用增量同步");
  }
  if (!SOURCE_INSTANCE_PATTERN.test(sourceInstanceId)) {
    errors.push("数据包缺少稳定 sourceInstanceId，请在来源实例重新导出 Nowen 无损包");
  }
  if (params.targetNotebookId) {
    errors.push("增量同步使用首次导入时记录的位置，不能重新指定目标笔记本");
  }

  const db = getDb();
  ensureRoundTripImportLinksSchema(db);
  const links = SOURCE_INSTANCE_PATTERN.test(sourceInstanceId)
    ? loadLinks(db, params.userId, workspaceId, sourceInstanceId)
    : [];
  if (!links.length) errors.push("当前空间没有该来源的导入映射，请先使用“创建独立副本”或“合并导入”完成首次导入");
  const linksByKey = linkMap(links);

  const targetNotebooks = notebookRowsForScope(params.userId, workspaceId);
  const targetNotebookById = new Map(targetNotebooks.map((item) => [item.id, item]));
  const namesByParent = new Map<string, Set<string>>();
  const nameSet = (parentId: string | null): Set<string> => {
    const key = parentId || "__root__";
    let set = namesByParent.get(key);
    if (!set) {
      set = new Set(targetNotebooks.filter((item) => item.parentId === parentId).map((item) => item.name));
      namesByParent.set(key, set);
    }
    return set;
  };

  const notebookPlans: SyncNotebookPlan[] = [];
  const notebookIdMap = new Map<string, string>();
  for (const source of model.notebooks) {
    const parentTargetId = source.parentId ? notebookIdMap.get(source.parentId) || null : null;
    const sourceHash = sourceNotebookHash(source);
    const link = linksByKey.get(linkKey("notebook", source.id));
    const target = link ? targetNotebookById.get(link.targetResourceId) : undefined;
    if (!target) {
      const targetId = uuid();
      const importedName = uniqueName(source.name, nameSet(parentTargetId));
      notebookIdMap.set(source.id, targetId);
      const action = link ? "recreate" : "create";
      notebookPlans.push({ source, sourceHash, targetId, parentTargetId, importedName, action, link });
      conflicts.push({
        action: "sync-create-directory",
        resourceType: "notebook",
        sourceId: source.id,
        originalName: source.name,
        importedName,
        parentId: parentTargetId,
        targetId,
      });
      continue;
    }

    notebookIdMap.set(source.id, target.id);
    const sourceChanged = sourceHash !== (link?.sourceHash || "");
    const currentHash = targetNotebookHash(target);
    if (!sourceChanged) {
      notebookPlans.push({ source, sourceHash, targetId: target.id, parentTargetId, importedName: target.name, action: "unchanged", link });
      continue;
    }
    if (!link?.targetHash || currentHash !== link.targetHash) {
      notebookPlans.push({ source, sourceHash, targetId: target.id, parentTargetId: target.parentId, importedName: target.name, action: "local-conflict", link });
      conflicts.push({
        action: "sync-local-conflict",
        resourceType: "notebook",
        sourceId: source.id,
        originalName: source.name,
        importedName: target.name,
        parentId: target.parentId,
        targetId: target.id,
      });
      continue;
    }
    const used = nameSet(parentTargetId);
    used.delete(target.name);
    const importedName = uniqueName(source.name, used);
    notebookPlans.push({ source, sourceHash, targetId: target.id, parentTargetId, importedName, action: "update", link });
    conflicts.push({
      action: "sync-update-directory",
      resourceType: "notebook",
      sourceId: source.id,
      originalName: target.name,
      importedName,
      parentId: parentTargetId,
      targetId: target.id,
    });
  }

  const targetNotes = noteRowsForScope(params.userId, workspaceId);
  const targetNoteById = new Map(targetNotes.map((item) => [item.id, item]));
  const titlesByNotebook = new Map<string, Set<string>>();
  const titleSet = (notebookId: string): Set<string> => {
    let set = titlesByNotebook.get(notebookId);
    if (!set) {
      set = new Set(targetNotes.filter((item) => item.notebookId === notebookId).map((item) => item.title));
      titlesByNotebook.set(notebookId, set);
    }
    return set;
  };

  const notePlans: SyncNotePlan[] = [];
  const noteIdMap = new Map<string, string>();
  for (const [sourceId, source] of model.notes) {
    const notebookId = notebookIdMap.get(source.meta.notebookId);
    if (!notebookId) {
      errors.push(`无法确定笔记目标目录：${source.meta.title}`);
      continue;
    }
    const link = linksByKey.get(linkKey("note", sourceId));
    const target = link ? targetNoteById.get(link.targetResourceId) : undefined;
    if (!target) {
      const targetId = uuid();
      const importedTitle = uniqueName(source.meta.title, titleSet(notebookId));
      noteIdMap.set(sourceId, targetId);
      const action = link ? "recreate" : "create";
      notePlans.push({ source, targetId, notebookId, importedTitle, action, link });
      conflicts.push({
        action: "sync-create-note",
        resourceType: "note",
        sourceId,
        originalName: source.meta.title,
        importedName: importedTitle,
        parentId: notebookId,
        targetId,
      });
      continue;
    }

    noteIdMap.set(sourceId, target.id);
    const sourceChanged = source.sourceHash !== (link?.sourceHash || "");
    if (!sourceChanged) {
      notePlans.push({ source, targetId: target.id, notebookId: target.notebookId, importedTitle: target.title, action: "unchanged", link });
      continue;
    }
    const currentHash = targetNoteHash(db, target.id);
    if (!link?.targetHash || currentHash !== link.targetHash) {
      notePlans.push({ source, targetId: target.id, notebookId: target.notebookId, importedTitle: target.title, action: "local-conflict", link });
      conflicts.push({
        action: "sync-local-conflict",
        resourceType: "note",
        sourceId,
        originalName: source.meta.title,
        importedName: target.title,
        parentId: target.notebookId,
        targetId: target.id,
      });
      continue;
    }
    notePlans.push({ source, targetId: target.id, notebookId, importedTitle: source.meta.title, action: "update", link });
    conflicts.push({
      action: "sync-update-note",
      resourceType: "note",
      sourceId,
      originalName: target.title,
      importedName: source.meta.title,
      parentId: notebookId,
      targetId: target.id,
    });
  }

  const targetAttachments = attachmentRowsForScope(params.userId, workspaceId);
  const targetAttachmentById = new Map(targetAttachments.map((item) => [item.id, item]));
  const notePlanBySource = new Map(notePlans.map((plan) => [plan.source.meta.id, plan]));
  const attachmentPlans: SyncAttachmentPlan[] = [];
  const attachmentIdMap = new Map<string, string>();
  for (const [sourceId, source] of model.attachments) {
    const notePlan = notePlanBySource.get(source.meta.noteId);
    const link = linksByKey.get(linkKey("attachment", sourceId));
    const target = link ? targetAttachmentById.get(link.targetResourceId) : undefined;
    if (!notePlan || notePlan.action === "unchanged" || notePlan.action === "local-conflict") {
      if (target) attachmentIdMap.set(sourceId, target.id);
      attachmentPlans.push({ source, targetId: target?.id || "", targetNoteId: notePlan?.targetId || "", action: "ignore", link });
      continue;
    }
    if (target && link?.sourceHash === source.sourceHash && target.noteId === notePlan.targetId) {
      attachmentIdMap.set(sourceId, target.id);
      attachmentPlans.push({ source, targetId: target.id, targetNoteId: notePlan.targetId, action: "reuse", link });
      continue;
    }
    const targetId = uuid();
    attachmentIdMap.set(sourceId, targetId);
    attachmentPlans.push({
      source,
      targetId,
      targetNoteId: notePlan.targetId,
      action: target ? "replace" : "create",
      oldTargetId: target?.id,
      link,
    });
    if (target) {
      conflicts.push({
        action: "sync-replace-attachment",
        resourceType: "attachment",
        sourceId,
        originalName: target.filename,
        importedName: source.meta.filename,
        parentId: notePlan.targetId,
        targetId,
      });
    }
  }

  const sourceAttachmentIdsByNote = new Map<string, Set<string>>();
  for (const [sourceId, source] of model.attachments) {
    const set = sourceAttachmentIdsByNote.get(source.meta.noteId) || new Set<string>();
    set.add(sourceId);
    sourceAttachmentIdsByNote.set(source.meta.noteId, set);
  }
  const staleAttachmentRows: AttachmentRow[] = [];
  for (const plan of notePlans) {
    if (plan.action !== "update") continue;
    const currentIds = sourceAttachmentIdsByNote.get(plan.source.meta.id) || new Set<string>();
    for (const link of links.filter((item) => item.resourceType === "attachment")) {
      const metadata = parseLinkMetadata(link);
      if (metadata.sourceNoteId !== plan.source.meta.id) continue;
      const replacement = attachmentPlans.find((item) => item.source.meta.id === link.sourceResourceId);
      if (!currentIds.has(link.sourceResourceId) || (replacement && replacement.targetId !== link.targetResourceId)) {
        const row = targetAttachmentById.get(link.targetResourceId);
        if (row && row.noteId === plan.targetId) staleAttachmentRows.push(row);
      }
    }
  }

  const counts = {
    notebooks: notebookPlans.filter((item) => item.action === "create" || item.action === "recreate").length,
    notes: notePlans.filter((item) => item.action === "create" || item.action === "recreate").length,
    tags: model.tags.length,
    noteTags: model.noteTags.length,
    attachments: attachmentPlans.filter((item) => item.action === "create" || item.action === "replace").length,
    updatedNotebooks: notebookPlans.filter((item) => item.action === "update").length,
    updatedNotes: notePlans.filter((item) => item.action === "update").length,
    unchangedNotes: notePlans.filter((item) => item.action === "unchanged").length,
    localConflicts: notebookPlans.filter((item) => item.action === "local-conflict").length
      + notePlans.filter((item) => item.action === "local-conflict").length,
    recreatedResources: notebookPlans.filter((item) => item.action === "recreate").length
      + notePlans.filter((item) => item.action === "recreate").length,
    reusedAttachments: attachmentPlans.filter((item) => item.action === "reuse").length,
    removedAttachments: staleAttachmentRows.length,
  };

  const packagePreview = {
    format: model.manifest.format,
    formatVersion: model.manifest.formatVersion,
    schemaVersion: model.manifest.schemaVersion,
    exportedAt: model.manifest.exportedAt,
    packageKind: model.manifest.packageKind,
    sourceInstanceId,
    exportBatchId: model.manifest.exportBatchId || null,
    counts: {
      notebooks: model.notebooks.length,
      notes: model.notes.size,
      tags: model.tags.length,
      attachments: model.attachments.size,
    },
    formatStats: model.manifest.formatStats || { markdown: 0, richText: 0, html: 0 },
    sync: { available: errors.length === 0, linkedResources: links.length, reason: errors[0] || null },
  };

  warnings.push({
    type: "sync_non_destructive",
    message: "本次采用非破坏性增量同步：不会删除目标中已存在但本数据包未包含的笔记或目录",
  });
  if (counts.localConflicts > 0) {
    warnings.push({
      type: "sync_local_conflicts",
      message: `检测到 ${counts.localConflicts} 项本地修改冲突，已保留本地版本并跳过覆盖`,
    });
  }

  if (params.dryRun || errors.length) {
    return {
      success: errors.length === 0,
      dryRun: params.dryRun === true,
      strategy: "sync",
      package: packagePreview,
      counts,
      conflicts,
      warnings,
      errors,
    };
  }

  const writtenPaths: string[] = [];
  try {
    for (const plan of attachmentPlans) {
      if (plan.action !== "create" && plan.action !== "replace") continue;
      plan.storagePath = `${getUploadMonthPath()}/${plan.targetId}${safeExtension(plan.source.meta.filename)}`;
      await writeAttachmentObject(
        plan.storagePath,
        plan.source.buffer,
        plan.source.meta.mimeType || "application/octet-stream",
      );
      writtenPaths.push(plan.storagePath);
    }
  } catch (error) {
    await Promise.all(writtenPaths.map((item) => deleteAttachmentObject(item).catch(() => undefined)));
    return {
      success: false,
      dryRun: false,
      strategy: "sync",
      package: packagePreview,
      counts,
      conflicts,
      warnings,
      errors: [`Attachment restore failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const tagIdMap = new Map<string, string>();
  const rewrittenByNote = new Map<string, string>();
  try {
    db.exec("BEGIN TRANSACTION");

    for (const plan of notebookPlans) {
      if (plan.action === "create" || plan.action === "recreate") {
        db.prepare(`
          INSERT INTO notebooks (
            id, userId, workspaceId, parentId, name, description, icon, color,
            sortOrder, isExpanded, isDeleted, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          plan.targetId, params.userId, workspaceId, plan.parentTargetId, plan.importedName,
          plan.source.description, plan.source.icon, plan.source.color, plan.source.sortOrder,
          plan.source.isExpanded, plan.source.createdAt, plan.source.updatedAt,
        );
      } else if (plan.action === "update") {
        db.prepare(`
          UPDATE notebooks
             SET parentId = ?, name = ?, description = ?, icon = ?, color = ?,
                 sortOrder = ?, isExpanded = ?, createdAt = ?, updatedAt = ?
           WHERE id = ?
        `).run(
          plan.parentTargetId, plan.importedName, plan.source.description, plan.source.icon,
          plan.source.color, plan.source.sortOrder, plan.source.isExpanded,
          plan.source.createdAt, plan.source.updatedAt, plan.targetId,
        );
      }
    }

    for (const tag of model.tags) {
      const existing = db.prepare(`
        SELECT id FROM tags
         WHERE userId = ? AND name = ? AND workspaceId ${workspaceId ? "= ?" : "IS NULL"}
         LIMIT 1
      `).get(...(workspaceId ? [params.userId, tag.name, workspaceId] : [params.userId, tag.name])) as { id: string } | undefined;
      if (existing) tagIdMap.set(tag.id, existing.id);
      else {
        const targetId = uuid();
        db.prepare("INSERT INTO tags (id, userId, workspaceId, name, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(targetId, params.userId, workspaceId, tag.name, tag.color, tag.createdAt);
        tagIdMap.set(tag.id, targetId);
      }
    }

    for (const plan of notePlans) {
      if (plan.action !== "create" && plan.action !== "recreate" && plan.action !== "update") continue;
      const rewritten = rewriteIdReferences(plan.source.content, attachmentIdMap, noteIdMap);
      for (const sourceId of rewritten.unmappedAttachmentIds) {
        warnings.push({ type: "attachment_ref_unmapped", id: sourceId, message: `附件 ${sourceId} 未能恢复` });
      }
      const meta = plan.source.meta;
      const contentFormat = KNOWN_CONTENT_FORMATS.has(meta.contentFormat) ? meta.contentFormat : "tiptap-json";
      if (plan.action === "create" || plan.action === "recreate") {
        db.prepare(`
          INSERT INTO notes (
            id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
            isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder,
            createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
          plan.targetId, params.userId, workspaceId, plan.notebookId, plan.importedTitle,
          rewritten.content, meta.contentText || "", contentFormat, meta.isPinned || 0,
          meta.isFavorite || 0, meta.isLocked || 0, meta.isArchived || 0,
          meta.version || 1, meta.sortOrder || 0, meta.createdAt, meta.updatedAt,
        );
      } else {
        db.prepare(`
          UPDATE notes
             SET notebookId = ?, title = ?, content = ?, contentText = ?, contentFormat = ?,
                 isPinned = ?, isFavorite = ?, isLocked = ?, isArchived = ?,
                 sortOrder = ?, createdAt = ?, updatedAt = ?, version = version + 1
           WHERE id = ?
        `).run(
          plan.notebookId, plan.importedTitle, rewritten.content, meta.contentText || "",
          contentFormat, meta.isPinned || 0, meta.isFavorite || 0, meta.isLocked || 0,
          meta.isArchived || 0, meta.sortOrder || 0, meta.createdAt, meta.updatedAt, plan.targetId,
        );
      }
      rewrittenByNote.set(plan.targetId, rewritten.content);
    }

    for (const plan of attachmentPlans) {
      if (plan.action !== "create" && plan.action !== "replace") continue;
      db.prepare(`
        INSERT INTO attachments (
          id, userId, workspaceId, noteId, filename, mimeType, size, path, hash, uploadSource, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.targetId, params.userId, workspaceId, plan.targetNoteId,
        plan.source.meta.filename, plan.source.meta.mimeType || "application/octet-stream",
        plan.source.buffer.length, plan.storagePath, plan.source.sourceHash,
        "nowen-roundtrip-sync", plan.source.meta.createdAt,
      );
    }

    for (const row of staleAttachmentRows) {
      db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
    }

    for (const relation of model.noteTags) {
      const notePlan = notePlanBySource.get(relation.noteId);
      const tagId = tagIdMap.get(relation.tagId);
      if (!notePlan || !tagId || (notePlan.action !== "create" && notePlan.action !== "recreate" && notePlan.action !== "update")) continue;
      db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(notePlan.targetId, tagId);
    }

    for (const [noteId, content] of rewrittenByNote) {
      if (content.includes("/api/attachments/")) syncAttachmentReferences(db, noteId, content);
    }

    for (const plan of notebookPlans) {
      if (plan.action === "local-conflict") continue;
      if (plan.action === "unchanged" && plan.link) {
        touchLinkBatch(db, plan.link, model.manifest.exportBatchId);
        continue;
      }
      const target = db.prepare(`
        SELECT id, parentId, name, description, icon, color, sortOrder, isExpanded, createdAt, updatedAt
          FROM notebooks WHERE id = ?
      `).get(plan.targetId) as NotebookRow;
      upsertLink(db, {
        userId: params.userId,
        workspaceId,
        sourceInstanceId,
        resourceType: "notebook",
        sourceResourceId: plan.source.id,
        targetResourceId: plan.targetId,
        sourceHash: plan.sourceHash,
        targetHash: targetNotebookHash(target),
        exportBatchId: model.manifest.exportBatchId,
        metadata: { name: plan.source.name },
      });
    }

    for (const plan of notePlans) {
      if (plan.action === "local-conflict") continue;
      if (plan.action === "unchanged" && plan.link) {
        touchLinkBatch(db, plan.link, model.manifest.exportBatchId);
        continue;
      }
      const currentTargetHash = targetNoteHash(db, plan.targetId);
      if (!currentTargetHash) continue;
      upsertLink(db, {
        userId: params.userId,
        workspaceId,
        sourceInstanceId,
        resourceType: "note",
        sourceResourceId: plan.source.meta.id,
        targetResourceId: plan.targetId,
        sourceHash: plan.source.sourceHash,
        targetHash: currentTargetHash,
        exportBatchId: model.manifest.exportBatchId,
        metadata: { title: plan.source.meta.title, sourceNotebookId: plan.source.meta.notebookId },
      });
    }

    for (const plan of attachmentPlans) {
      if (plan.action === "ignore" || !plan.targetId) continue;
      upsertLink(db, {
        userId: params.userId,
        workspaceId,
        sourceInstanceId,
        resourceType: "attachment",
        sourceResourceId: plan.source.meta.id,
        targetResourceId: plan.targetId,
        sourceHash: plan.source.sourceHash,
        targetHash: plan.source.sourceHash,
        exportBatchId: model.manifest.exportBatchId,
        metadata: { filename: plan.source.meta.filename, sourceNoteId: plan.source.meta.noteId },
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    await Promise.all(writtenPaths.map((item) => deleteAttachmentObject(item).catch(() => undefined)));
    return {
      success: false,
      dryRun: false,
      strategy: "sync",
      package: packagePreview,
      counts,
      conflicts,
      warnings,
      errors: [`Sync failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  await removeAttachmentObjects(staleAttachmentRows, warnings);
  return {
    success: true,
    dryRun: false,
    strategy: "sync",
    rootNotebookId: notebookPlans.find((item) => !item.source.parentId)?.targetId,
    rootNotebookIds: notebookPlans.filter((item) => !item.source.parentId).map((item) => item.targetId),
    package: packagePreview,
    counts,
    conflicts,
    warnings,
    errors: [],
  };
}

export async function importNowenPackageWithSync(
  zipBuffer: Buffer,
  params: RoundTripImportParams,
): Promise<any> {
  if (params.importMode === "sync") return importRoundTripPackageSync(zipBuffer, params);

  const workspaceId = params.workspaceId || null;
  const snapshot = params.dryRun ? null : captureRoundTripImportSnapshot(params.userId, workspaceId);
  const result = await importNowenPackageV2(zipBuffer, {
    ...params,
    importMode: params.importMode === "merge"
      ? "merge"
      : params.importMode === "into-target"
        ? "into-target"
        : "new-root",
  });

  let model: PackageModel | null = null;
  try {
    model = await parsePackage(zipBuffer);
    withSyncAvailability(result, model, params.userId, workspaceId);
  } catch (error) {
    result.warnings = [...(result.warnings || []), {
      type: "sync_manifest_unavailable",
      message: error instanceof Error ? error.message : String(error),
    }];
  }

  if (result.success && !params.dryRun && snapshot && model && model.manifest.packageKind !== "markdown") {
    try {
      await recordRoundTripLinksAfterImport({
        zipBuffer,
        userId: params.userId,
        workspaceId,
        snapshot,
        result,
      });
      withSyncAvailability(result, model, params.userId, workspaceId);
    } catch (error) {
      result.warnings = [...(result.warnings || []), {
        type: "sync_link_record_failed",
        message: `数据已导入，但来源映射记录失败：${error instanceof Error ? error.message : String(error)}`,
      }];
    }
  }
  return result;
}
