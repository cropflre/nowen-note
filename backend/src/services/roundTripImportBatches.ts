import crypto from "crypto";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { ensureRoundTripImportBatchesSchema } from "../db/roundtripImportBatchesMigration";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import {
  deleteAttachmentObject,
  readAttachmentObject,
  writeAttachmentObject,
} from "./attachment-storage";
import {
  importNowenPackageWithSync,
  type RoundTripImportParams,
} from "./nowenRoundTripSync";

const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const UNDO_ROOT = path.join(DATA_DIR, "import-undo");
const DEFAULT_UNDO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_UNDO_MAX_BYTES = 2 * 1024 * 1024 * 1024;

interface PackageIdentity {
  packageKind: string | null;
  sourceInstanceId: string | null;
  sourceExportBatchId: string | null;
}

interface ScopeIds {
  notebooks: string[];
  notes: string[];
  attachments: string[];
  tags: string[];
}

interface AttachmentUndoSnapshot {
  row: Record<string, unknown>;
  objectHash: string | null;
  backupFile: string | null;
}

interface NoteUndoSnapshot {
  row: Record<string, unknown>;
  tagIds: string[];
  attachments: AttachmentUndoSnapshot[];
}

interface UndoState {
  version: 1;
  beforeScope: ScopeIds;
  created: {
    notebookIds: string[];
    noteIds: string[];
    attachmentRows: Array<Record<string, unknown>>;
    tagIds: string[];
  };
  updated: {
    notebooks: Array<Record<string, unknown>>;
    notes: NoteUndoSnapshot[];
  };
  afterHashes: {
    notebooks: Record<string, string>;
    notes: Record<string, string>;
    tags: Record<string, string>;
  };
  backupBytes: number;
}

interface BatchRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  workspaceScope: string;
  importMode: string;
  packageKind: string | null;
  sourceInstanceId: string | null;
  sourceExportBatchId: string | null;
  status: "running" | "completed" | "failed" | "undone";
  previewJson: string;
  resultJson: string;
  undoStateJson: string;
  undoAvailable: number;
  undoUnavailableReason: string | null;
  undoExpiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
  undoError: string | null;
}

export interface RoundTripImportBatchSummary {
  id: string;
  workspaceId: string | null;
  importMode: string;
  packageKind: string | null;
  sourceInstanceId: string | null;
  sourceExportBatchId: string | null;
  status: BatchRow["status"];
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
  undo: {
    available: boolean;
    expiresAt: string | null;
    reason: string | null;
    error: string | null;
  };
  counts: Record<string, number>;
  warningCount: number;
  errorCount: number;
}

export interface RoundTripImportBatchDetail extends RoundTripImportBatchSummary {
  preview: Record<string, unknown>;
  result: Record<string, unknown>;
}

export class RoundTripImportUndoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 404 | 409 | 410 = 409,
    readonly conflicts: string[] = [],
  ) {
    super(message);
  }
}

function undoTtlMs(): number {
  const raw = Number(process.env.ROUNDTRIP_IMPORT_UNDO_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(raw, 24 * 365) * 60 * 60 * 1000
    : DEFAULT_UNDO_TTL_MS;
}

function undoMaxBytes(): number {
  const raw = Number(process.env.ROUNDTRIP_IMPORT_UNDO_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UNDO_MAX_BYTES;
}

function workspaceScope(workspaceId: string | null | undefined): string {
  return workspaceId || "personal";
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value || "") as T; }
  catch { return fallback; }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableValue(source[key])]));
  }
  return value;
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function scopeSql(workspaceId: string | null, alias = ""): { sql: string; params: unknown[] } {
  const prefix = alias ? `${alias}.` : "";
  return workspaceId
    ? { sql: `${prefix}workspaceId = ?`, params: [workspaceId] }
    : { sql: `${prefix}workspaceId IS NULL`, params: [] };
}

function idsForScope(userId: string, workspaceId: string | null): ScopeIds {
  const db = getDb();
  const scope = scopeSql(workspaceId);
  const owner = workspaceId ? "" : "userId = ? AND ";
  const ownerParams = workspaceId ? [] : [userId];
  const notebooks = db.prepare(`SELECT id FROM notebooks WHERE ${owner}${scope.sql}`).all(...ownerParams, ...scope.params) as Array<{ id: string }>;
  const notes = db.prepare(`SELECT id FROM notes WHERE ${owner}${scope.sql}`).all(...ownerParams, ...scope.params) as Array<{ id: string }>;
  const tags = db.prepare(`SELECT id FROM tags WHERE ${owner}${scope.sql}`).all(...ownerParams, ...scope.params) as Array<{ id: string }>;
  const noteScope = scopeSql(workspaceId, "n");
  const noteOwner = workspaceId ? "" : "n.userId = ? AND ";
  const attachments = db.prepare(`
    SELECT a.id
      FROM attachments a
      JOIN notes n ON n.id = a.noteId
     WHERE ${noteOwner}${noteScope.sql}
  `).all(...ownerParams, ...noteScope.params) as Array<{ id: string }>;
  return {
    notebooks: notebooks.map((row) => row.id),
    notes: notes.map((row) => row.id),
    attachments: attachments.map((row) => row.id),
    tags: tags.map((row) => row.id),
  };
}

function rowById(table: "notebooks" | "notes" | "attachments" | "tags", id: string): Record<string, unknown> | null {
  return getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined || null;
}

function rowsByIds(table: "notebooks" | "notes" | "attachments" | "tags", ids: string[]): Array<Record<string, unknown>> {
  if (!ids.length) return [];
  return getDb().prepare(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<Record<string, unknown>>;
}

function attachmentRowsForNote(noteId: string): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM attachments WHERE noteId = ? ORDER BY id").all(noteId) as Array<Record<string, unknown>>;
}

function tagIdsForNote(noteId: string): string[] {
  return (getDb().prepare("SELECT tagId FROM note_tags WHERE noteId = ? ORDER BY tagId").all(noteId) as Array<{ tagId: string }>)
    .map((row) => row.tagId);
}

async function attachmentState(row: Record<string, unknown>): Promise<{ row: Record<string, unknown>; objectHash: string | null }> {
  const object = await readAttachmentObject(String(row.path || ""));
  return { row, objectHash: object ? sha256(object) : null };
}

async function noteHash(noteId: string): Promise<string | null> {
  const row = rowById("notes", noteId);
  if (!row) return null;
  const attachments = [];
  for (const attachment of attachmentRowsForNote(noteId)) attachments.push(await attachmentState(attachment));
  return hashValue({ row, tagIds: tagIdsForNote(noteId), attachments });
}

function notebookHash(id: string): string | null {
  const row = rowById("notebooks", id);
  return row ? hashValue(row) : null;
}

function tagHash(id: string): string | null {
  const row = rowById("tags", id);
  return row ? hashValue(row) : null;
}

function backupDir(batchId: string): string {
  return path.join(UNDO_ROOT, batchId);
}

function backupFilename(attachmentId: string): string {
  return `${crypto.createHash("sha256").update(attachmentId).digest("hex").slice(0, 40)}.bin`;
}

async function captureNoteBefore(batchId: string, noteId: string, budget: { bytes: number }): Promise<NoteUndoSnapshot | null> {
  const row = rowById("notes", noteId);
  if (!row) return null;
  const snapshots: AttachmentUndoSnapshot[] = [];
  for (const attachment of attachmentRowsForNote(noteId)) {
    const object = await readAttachmentObject(String(attachment.path || ""));
    let backupFile: string | null = null;
    let objectHash: string | null = null;
    if (object) {
      budget.bytes += object.byteLength;
      if (budget.bytes > undoMaxBytes()) throw new Error("UNDO_BACKUP_BUDGET_EXCEEDED");
      fs.mkdirSync(backupDir(batchId), { recursive: true });
      backupFile = backupFilename(String(attachment.id || uuid()));
      fs.writeFileSync(path.join(backupDir(batchId), backupFile), object);
      objectHash = sha256(object);
    } else {
      throw new Error(`UNDO_ATTACHMENT_MISSING:${String(attachment.filename || attachment.id || "unknown")}`);
    }
    snapshots.push({ row: attachment, objectHash, backupFile });
  }
  return { row, tagIds: tagIdsForNote(noteId), attachments: snapshots };
}

function previewActionTargets(preview: any): { notebookIds: string[]; noteIds: string[] } {
  const notebookIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const conflict of Array.isArray(preview?.conflicts) ? preview.conflicts : []) {
    const action = String(conflict?.action || "");
    const targetId = String(conflict?.targetId || "");
    if (action === "sync-update-directory" && targetId) notebookIds.add(targetId);
    if (action === "sync-update-note" && targetId) noteIds.add(targetId);
    if (action === "sync-replace-attachment" && conflict?.parentId) noteIds.add(String(conflict.parentId));
  }
  return { notebookIds: [...notebookIds], noteIds: [...noteIds] };
}

async function readPackageIdentity(zipBuffer: Buffer): Promise<PackageIdentity> {
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    const entry = zip.file("manifest.json");
    if (!entry) return { packageKind: null, sourceInstanceId: null, sourceExportBatchId: null };
    const manifest = JSON.parse(await entry.async("string")) as Record<string, unknown>;
    return {
      packageKind: manifest.packageKind ? String(manifest.packageKind) : null,
      sourceInstanceId: manifest.sourceInstanceId ? String(manifest.sourceInstanceId) : null,
      sourceExportBatchId: manifest.exportBatchId ? String(manifest.exportBatchId) : null,
    };
  } catch {
    return { packageKind: null, sourceInstanceId: null, sourceExportBatchId: null };
  }
}

function publicBatch(row: BatchRow): RoundTripImportBatchDetail {
  const preview = parseJson<Record<string, unknown>>(row.previewJson, {});
  const result = parseJson<Record<string, unknown>>(row.resultJson, {});
  const counts = (result.counts && typeof result.counts === "object" ? result.counts : preview.counts) as Record<string, number> | undefined;
  const warnings = Array.isArray(result.warnings) ? result.warnings : Array.isArray(preview.warnings) ? preview.warnings : [];
  const errors = Array.isArray(result.errors) ? result.errors : Array.isArray(preview.errors) ? preview.errors : [];
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    importMode: row.importMode,
    packageKind: row.packageKind,
    sourceInstanceId: row.sourceInstanceId,
    sourceExportBatchId: row.sourceExportBatchId,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    undoneAt: row.undoneAt,
    undo: {
      available: row.undoAvailable === 1 && row.status === "completed",
      expiresAt: row.undoExpiresAt,
      reason: row.undoUnavailableReason,
      error: row.undoError,
    },
    counts: counts || {},
    warningCount: warnings.length,
    errorCount: errors.length,
    preview,
    result,
  };
}

function removeUndoDir(batchId: string): void {
  try { fs.rmSync(backupDir(batchId), { recursive: true, force: true }); } catch { /* best effort */ }
}

export function cleanupExpiredRoundTripImportUndo(): void {
  ensureRoundTripImportBatchesSchema(getDb());
  const rows = getDb().prepare(`
    SELECT id FROM roundtrip_import_batches
     WHERE undoAvailable = 1 AND undoExpiresAt IS NOT NULL AND datetime(undoExpiresAt) <= datetime('now')
  `).all() as Array<{ id: string }>;
  if (!rows.length) return;
  const tx = getDb().transaction(() => {
    for (const row of rows) {
      getDb().prepare(`
        UPDATE roundtrip_import_batches
           SET undoAvailable = 0,
               undoUnavailableReason = COALESCE(undoUnavailableReason, '撤销窗口已过期')
         WHERE id = ?
      `).run(row.id);
    }
  });
  tx();
  rows.forEach((row) => removeUndoDir(row.id));
}

async function prepareUndoState(
  batchId: string,
  userId: string,
  workspaceId: string | null,
  importMode: string,
  preview: any,
): Promise<{ state: UndoState; available: boolean; reason: string | null }> {
  const beforeScope = idsForScope(userId, workspaceId);
  const state: UndoState = {
    version: 1,
    beforeScope,
    created: { notebookIds: [], noteIds: [], attachmentRows: [], tagIds: [] },
    updated: { notebooks: [], notes: [] },
    afterHashes: { notebooks: {}, notes: {}, tags: {} },
    backupBytes: 0,
  };
  if (importMode !== "sync") return { state, available: true, reason: null };

  const targets = previewActionTargets(preview);
  state.updated.notebooks = rowsByIds("notebooks", targets.notebookIds);
  const budget = { bytes: 0 };
  try {
    for (const noteId of targets.noteIds) {
      const snapshot = await captureNoteBefore(batchId, noteId, budget);
      if (snapshot) state.updated.notes.push(snapshot);
    }
    state.backupBytes = budget.bytes;
    return { state, available: true, reason: null };
  } catch (error) {
    removeUndoDir(batchId);
    state.updated.notes = [];
    state.updated.notebooks = [];
    state.backupBytes = 0;
    const message = error instanceof Error ? error.message : String(error);
    const reason = message === "UNDO_BACKUP_BUDGET_EXCEEDED"
      ? `同步涉及的附件备份超过安全上限 ${Math.round(undoMaxBytes() / 1024 / 1024)}MB`
      : message.startsWith("UNDO_ATTACHMENT_MISSING:")
        ? `无法读取待更新附件，不能生成完整撤销快照：${message.slice("UNDO_ATTACHMENT_MISSING:".length)}`
        : `无法生成撤销快照：${message}`;
    return { state, available: false, reason };
  }
}

async function finalizeUndoState(
  state: UndoState,
  userId: string,
  workspaceId: string | null,
): Promise<{ state: UndoState; available: boolean; reason: string | null }> {
  const after = idsForScope(userId, workspaceId);
  const beforeNotebooks = new Set(state.beforeScope.notebooks);
  const beforeNotes = new Set(state.beforeScope.notes);
  const beforeAttachments = new Set(state.beforeScope.attachments);
  const beforeTags = new Set(state.beforeScope.tags);
  state.created.notebookIds = after.notebooks.filter((id) => !beforeNotebooks.has(id));
  state.created.noteIds = after.notes.filter((id) => !beforeNotes.has(id));
  const createdAttachmentIds = after.attachments.filter((id) => !beforeAttachments.has(id));
  state.created.attachmentRows = rowsByIds("attachments", createdAttachmentIds);
  state.created.tagIds = after.tags.filter((id) => !beforeTags.has(id));

  for (const id of state.created.notebookIds) {
    const value = notebookHash(id);
    if (value) state.afterHashes.notebooks[id] = value;
  }
  for (const snapshot of state.updated.notebooks) {
    const id = String(snapshot.id || "");
    const value = id ? notebookHash(id) : null;
    if (!value) return { state, available: false, reason: `导入后目录 ${id || "unknown"} 不存在，无法安全生成撤销点` };
    state.afterHashes.notebooks[id] = value;
  }
  for (const id of state.created.noteIds) {
    const value = await noteHash(id);
    if (value) state.afterHashes.notes[id] = value;
  }
  for (const snapshot of state.updated.notes) {
    const id = String(snapshot.row.id || "");
    const value = id ? await noteHash(id) : null;
    if (!value) return { state, available: false, reason: `导入后笔记 ${id || "unknown"} 不存在，无法安全生成撤销点` };
    state.afterHashes.notes[id] = value;
  }
  for (const id of state.created.tagIds) {
    const value = tagHash(id);
    if (value) state.afterHashes.tags[id] = value;
  }
  return { state, available: true, reason: null };
}

function createBatchRow(args: {
  id: string;
  userId: string;
  workspaceId: string | null;
  importMode: string;
  identity: PackageIdentity;
  preview: any;
  undo: { state: UndoState; available: boolean; reason: string | null };
}): void {
  ensureRoundTripImportBatchesSchema(getDb());
  const expiresAt = new Date(Date.now() + undoTtlMs()).toISOString();
  getDb().prepare(`
    INSERT INTO roundtrip_import_batches (
      id, userId, workspaceId, workspaceScope, importMode, packageKind,
      sourceInstanceId, sourceExportBatchId, status, previewJson, resultJson,
      undoStateJson, undoAvailable, undoUnavailableReason, undoExpiresAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, '{}', ?, ?, ?, ?)
  `).run(
    args.id,
    args.userId,
    args.workspaceId,
    workspaceScope(args.workspaceId),
    args.importMode,
    args.identity.packageKind,
    args.identity.sourceInstanceId,
    args.identity.sourceExportBatchId,
    JSON.stringify(args.preview || {}),
    JSON.stringify(args.undo.state),
    args.undo.available ? 1 : 0,
    args.undo.reason,
    expiresAt,
  );
}

function markBatchFailed(batchId: string, result: any, message?: string): void {
  ensureRoundTripImportBatchesSchema(getDb());
  getDb().prepare(`
    UPDATE roundtrip_import_batches
       SET status = 'failed', resultJson = ?, completedAt = datetime('now'),
           undoAvailable = 0, undoUnavailableReason = COALESCE(?, undoUnavailableReason, '导入失败，未产生可撤销批次')
     WHERE id = ?
  `).run(JSON.stringify(result || {}), message || null, batchId);
  removeUndoDir(batchId);
}

export async function executeNowenPackageImportWithBatch(
  zipBuffer: Buffer,
  params: RoundTripImportParams,
): Promise<any> {
  cleanupExpiredRoundTripImportUndo();
  const workspaceId = params.workspaceId || null;
  const importMode = params.importMode || "new-root";
  const preview = await importNowenPackageWithSync(zipBuffer, { ...params, dryRun: true });
  if (!preview?.success) return preview;

  const batchId = uuid();
  const identity = await readPackageIdentity(zipBuffer);
  const undo = await prepareUndoState(batchId, params.userId, workspaceId, importMode, preview);
  createBatchRow({ id: batchId, userId: params.userId, workspaceId, importMode, identity, preview, undo });

  try {
    const result = await importNowenPackageWithSync(zipBuffer, { ...params, dryRun: false });
    if (!result?.success) {
      markBatchFailed(batchId, result);
      return { ...result, importBatch: { id: batchId, undoAvailable: false, reason: "导入失败" } };
    }

    let finalized = undo;
    if (undo.available) finalized = await finalizeUndoState(undo.state, params.userId, workspaceId);
    if (!finalized.available) removeUndoDir(batchId);
    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET status = 'completed', resultJson = ?, undoStateJson = ?,
             undoAvailable = ?, undoUnavailableReason = ?, completedAt = datetime('now')
       WHERE id = ?
    `).run(
      JSON.stringify(result || {}),
      JSON.stringify(finalized.state),
      finalized.available ? 1 : 0,
      finalized.reason,
      batchId,
    );
    return {
      ...result,
      importBatch: {
        id: batchId,
        undoAvailable: finalized.available,
        undoExpiresAt: new Date(Date.now() + undoTtlMs()).toISOString(),
        reason: finalized.reason,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markBatchFailed(batchId, { success: false, errors: [message] }, message);
    throw error;
  }
}

function getBatchRow(userId: string, batchId: string): BatchRow | null {
  ensureRoundTripImportBatchesSchema(getDb());
  return getDb().prepare("SELECT * FROM roundtrip_import_batches WHERE id = ? AND userId = ?")
    .get(batchId, userId) as BatchRow | undefined || null;
}

export function listRoundTripImportBatches(
  userId: string,
  options: { workspaceId?: string | null; limit?: number } = {},
): RoundTripImportBatchSummary[] {
  cleanupExpiredRoundTripImportUndo();
  const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
  const rows = options.workspaceId === undefined
    ? getDb().prepare("SELECT * FROM roundtrip_import_batches WHERE userId = ? ORDER BY createdAt DESC LIMIT ?")
      .all(userId, limit) as BatchRow[]
    : getDb().prepare("SELECT * FROM roundtrip_import_batches WHERE userId = ? AND workspaceScope = ? ORDER BY createdAt DESC LIMIT ?")
      .all(userId, workspaceScope(options.workspaceId), limit) as BatchRow[];
  return rows.map((row) => {
    const detail = publicBatch(row);
    const { preview: _preview, result: _result, ...summary } = detail;
    return summary;
  });
}

export function getRoundTripImportBatch(userId: string, batchId: string): RoundTripImportBatchDetail | null {
  cleanupExpiredRoundTripImportUndo();
  const row = getBatchRow(userId, batchId);
  return row ? publicBatch(row) : null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function updateDynamic(table: string, row: Record<string, unknown>, key = "id"): void {
  const columns = Object.keys(row).filter((column) => column !== key);
  if (!columns.length) return;
  getDb().prepare(`UPDATE ${quoteIdentifier(table)} SET ${columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE ${quoteIdentifier(key)} = ?`)
    .run(...columns.map((column) => row[column]), row[key]);
}

function insertDynamic(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  getDb().prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column]));
}

async function validateUndoState(state: UndoState): Promise<string[]> {
  const conflicts: string[] = [];
  for (const [id, expected] of Object.entries(state.afterHashes.notebooks)) {
    const current = notebookHash(id);
    if (current !== expected) conflicts.push(`目录已在导入后发生变化：${id}`);
  }
  for (const [id, expected] of Object.entries(state.afterHashes.notes)) {
    const current = await noteHash(id);
    if (current !== expected) conflicts.push(`笔记或其附件已在导入后发生变化：${id}`);
  }
  for (const [id, expected] of Object.entries(state.afterHashes.tags)) {
    const current = tagHash(id);
    if (current && current !== expected) conflicts.push(`标签已在导入后发生变化：${id}`);
  }

  const createdNotebookSet = new Set(state.created.notebookIds);
  const createdNoteSet = new Set(state.created.noteIds);
  if (state.created.notebookIds.length) {
    const descendants = getDb().prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM notebooks WHERE id IN (${state.created.notebookIds.map(() => "?").join(",")})
        UNION ALL
        SELECT n.id FROM notebooks n JOIN descendants d ON n.parentId = d.id
      )
      SELECT DISTINCT id FROM descendants
    `).all(...state.created.notebookIds) as Array<{ id: string }>;
    for (const row of descendants) {
      if (!createdNotebookSet.has(row.id)) conflicts.push(`导入目录下新增了其他目录，不能整体撤销：${row.id}`);
    }
    const notes = getDb().prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM notebooks WHERE id IN (${state.created.notebookIds.map(() => "?").join(",")})
        UNION ALL
        SELECT n.id FROM notebooks n JOIN descendants d ON n.parentId = d.id
      )
      SELECT notes.id FROM notes JOIN descendants ON descendants.id = notes.notebookId
    `).all(...state.created.notebookIds) as Array<{ id: string }>;
    for (const row of notes) {
      if (!createdNoteSet.has(row.id)) conflicts.push(`导入目录下新增了其他笔记，不能整体撤销：${row.id}`);
    }
  }
  return [...new Set(conflicts)];
}

function notebookDepth(id: string, rows: Map<string, Record<string, unknown>>): number {
  let depth = 0;
  let current = rows.get(id);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(String(current.parentId))) {
    seen.add(String(current.parentId));
    depth += 1;
    current = rows.get(String(current.parentId));
  }
  return depth;
}

export async function undoRoundTripImportBatch(userId: string, batchId: string): Promise<RoundTripImportBatchDetail> {
  cleanupExpiredRoundTripImportUndo();
  const row = getBatchRow(userId, batchId);
  if (!row) throw new RoundTripImportUndoError("导入批次不存在", "IMPORT_BATCH_NOT_FOUND", 404);
  if (row.status === "undone") throw new RoundTripImportUndoError("该导入批次已经撤销", "IMPORT_BATCH_ALREADY_UNDONE", 409);
  if (row.status !== "completed") throw new RoundTripImportUndoError("只有已完成的导入批次可以撤销", "IMPORT_BATCH_NOT_COMPLETED", 409);
  if (!row.undoAvailable) {
    const expired = row.undoExpiresAt && new Date(row.undoExpiresAt).getTime() <= Date.now();
    throw new RoundTripImportUndoError(
      row.undoUnavailableReason || (expired ? "撤销窗口已过期" : "该批次没有可用的完整撤销快照"),
      expired ? "IMPORT_BATCH_UNDO_EXPIRED" : "IMPORT_BATCH_UNDO_UNAVAILABLE",
      expired ? 410 : 409,
    );
  }
  if (row.undoExpiresAt && new Date(row.undoExpiresAt).getTime() <= Date.now()) {
    throw new RoundTripImportUndoError("撤销窗口已过期", "IMPORT_BATCH_UNDO_EXPIRED", 410);
  }

  const state = parseJson<UndoState | null>(row.undoStateJson, null);
  if (!state || state.version !== 1) throw new RoundTripImportUndoError("撤销快照损坏或版本不兼容", "IMPORT_BATCH_UNDO_STATE_INVALID", 409);
  const conflicts = await validateUndoState(state);
  if (conflicts.length) {
    getDb().prepare("UPDATE roundtrip_import_batches SET undoError = ? WHERE id = ?")
      .run(`检测到导入后的本地修改：${conflicts.join("；")}`, batchId);
    throw new RoundTripImportUndoError("检测到导入后的本地修改，已拒绝破坏性撤销", "IMPORT_BATCH_UNDO_CONFLICT", 409, conflicts);
  }

  const restoredPaths = new Set<string>();
  for (const note of state.updated.notes) {
    for (const attachment of note.attachments) {
      const relPath = String(attachment.row.path || "");
      if (!relPath || !attachment.backupFile) continue;
      const abs = path.join(backupDir(batchId), attachment.backupFile);
      if (!fs.existsSync(abs)) throw new RoundTripImportUndoError("附件撤销备份缺失，已停止撤销", "IMPORT_BATCH_UNDO_BACKUP_MISSING", 409);
      const buffer = fs.readFileSync(abs);
      if (attachment.objectHash && sha256(buffer) !== attachment.objectHash) {
        throw new RoundTripImportUndoError("附件撤销备份校验失败，已停止撤销", "IMPORT_BATCH_UNDO_BACKUP_CORRUPT", 409);
      }
      await writeAttachmentObject(relPath, buffer, String(attachment.row.mimeType || "application/octet-stream"));
      restoredPaths.add(relPath);
    }
  }

  const updatedNoteIds = state.updated.notes.map((item) => String(item.row.id || "")).filter(Boolean);
  const currentUpdatedAttachments = updatedNoteIds.length
    ? getDb().prepare(`SELECT * FROM attachments WHERE noteId IN (${updatedNoteIds.map(() => "?").join(",")})`).all(...updatedNoteIds) as Array<Record<string, unknown>>
    : [];
  const createdAttachmentRows = state.created.attachmentRows;
  const objectsToDelete = [...currentUpdatedAttachments, ...createdAttachmentRows]
    .map((item) => String(item.path || ""))
    .filter((value) => value && !restoredPaths.has(value));

  const createdNotebookRows = rowsByIds("notebooks", state.created.notebookIds);
  const createdNotebookMap = new Map(createdNotebookRows.map((item) => [String(item.id), item]));
  const sortedCreatedNotebookIds = [...state.created.notebookIds]
    .sort((a, b) => notebookDepth(b, createdNotebookMap) - notebookDepth(a, createdNotebookMap));

  try {
    getDb().exec("BEGIN TRANSACTION");
    for (const note of state.updated.notes) {
      const noteId = String(note.row.id || "");
      if (!noteId) continue;
      getDb().prepare("DELETE FROM note_tags WHERE noteId = ?").run(noteId);
      getDb().prepare("DELETE FROM attachments WHERE noteId = ?").run(noteId);
      updateDynamic("notes", note.row);
      for (const attachment of note.attachments) insertDynamic("attachments", attachment.row);
      for (const tagId of note.tagIds) getDb().prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
    }
    for (const notebook of state.updated.notebooks) updateDynamic("notebooks", notebook);

    for (const attachment of state.created.attachmentRows) {
      getDb().prepare("DELETE FROM attachments WHERE id = ?").run(String(attachment.id || ""));
    }
    for (const noteId of state.created.noteIds) getDb().prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    for (const notebookId of sortedCreatedNotebookIds) getDb().prepare("DELETE FROM notebooks WHERE id = ?").run(notebookId);
    for (const tagId of state.created.tagIds) {
      const refs = getDb().prepare("SELECT COUNT(*) AS count FROM note_tags WHERE tagId = ?").get(tagId) as { count: number };
      if (!refs.count) getDb().prepare("DELETE FROM tags WHERE id = ?").run(tagId);
    }

    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET status = 'undone', undoAvailable = 0, undoneAt = datetime('now'), undoError = NULL
       WHERE id = ?
    `).run(batchId);
    getDb().exec("COMMIT");
  } catch (error) {
    try { getDb().exec("ROLLBACK"); } catch { /* ignore */ }
    const message = error instanceof Error ? error.message : String(error);
    getDb().prepare("UPDATE roundtrip_import_batches SET undoError = ? WHERE id = ?").run(message, batchId);
    throw new RoundTripImportUndoError(`撤销失败：${message}`, "IMPORT_BATCH_UNDO_FAILED", 409);
  }

  await Promise.all([...new Set(objectsToDelete)].map((item) => deleteAttachmentObject(item).catch(() => undefined)));
  for (const note of state.updated.notes) {
    const noteId = String(note.row.id || "");
    if (noteId) syncAttachmentReferences(getDb(), noteId, String(note.row.content || ""));
  }
  removeUndoDir(batchId);
  return publicBatch(getBatchRow(userId, batchId)!);
}
