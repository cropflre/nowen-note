import crypto from "crypto";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { getDb } from "../db/schema";
import {
  RoundTripImportUndoError,
  undoRoundTripImportBatch,
  type RoundTripImportBatchDetail,
} from "./roundTripImportBatches";

const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const UNDO_ROOT = path.join(DATA_DIR, "import-undo");

type ResourceType = "notebook" | "note" | "attachment";

interface ImportIdentitySnapshot {
  packageKind: string | null;
  sourceInstanceId: string | null;
  workspaceScope: string;
  sourceIds: Record<ResourceType, string[]>;
  beforeRows: Array<Record<string, unknown>>;
}

interface StoredLinkUndo {
  sourceInstanceId: string;
  workspaceScope: string;
  beforeRows: Array<Record<string, unknown>>;
  afterHash: string;
}

interface MutableUndoState {
  beforeScope?: {
    notebooks?: string[];
    notes?: string[];
    attachments?: string[];
    tags?: string[];
  };
  created?: {
    notebookIds?: string[];
    noteIds?: string[];
    attachmentRows?: Array<Record<string, unknown>>;
    tagIds?: string[];
  };
  updated?: {
    notebooks?: Array<Record<string, unknown>>;
    notes?: Array<{ row?: Record<string, unknown> }>;
  };
  afterHashes?: {
    notebooks?: Record<string, string>;
    notes?: Record<string, string>;
    tags?: Record<string, string>;
  };
  sourceLinks?: StoredLinkUndo;
  [key: string]: unknown;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableValue(source[key])]));
  }
  return value;
}

function hashRows(rows: Array<Record<string, unknown>>): string {
  const sorted = [...rows].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(sorted))).digest("hex");
}

function currentRows(userId: string, workspaceScope: string, sourceInstanceId: string): Array<Record<string, unknown>> {
  return getDb().prepare(`
    SELECT * FROM roundtrip_import_links
     WHERE userId = ? AND workspaceScope = ? AND sourceInstanceId = ?
     ORDER BY id
  `).all(userId, workspaceScope, sourceInstanceId) as Array<Record<string, unknown>>;
}

function removeUndoBackup(batchId: string): void {
  try { fs.rmSync(path.join(UNDO_ROOT, batchId), { recursive: true, force: true }); } catch { /* best effort */ }
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : []);
}

function filterHashes(source: Record<string, string> | undefined, allowed: Set<string>): Record<string, string> {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).filter(([id]) => allowed.has(id)));
}

function mappedTargets(rows: Array<Record<string, unknown>>, resourceType: ResourceType): Set<string> {
  return new Set(rows
    .filter((row) => row.resourceType === resourceType)
    .map((row) => String(row.targetResourceId || ""))
    .filter(Boolean));
}

function attachmentRows(ids: Set<string>): Array<Record<string, unknown>> {
  if (!ids.size) return [];
  const values = [...ids];
  return getDb().prepare(`SELECT * FROM attachments WHERE id IN (${values.map(() => "?").join(",")})`)
    .all(...values) as Array<Record<string, unknown>>;
}

function descendantsFromCreatedRoots(rootIds: string[]): { notebookIds: Set<string>; noteIds: Set<string> } {
  if (!rootIds.length) return { notebookIds: new Set(), noteIds: new Set() };
  const descendants = getDb().prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM notebooks WHERE id IN (${rootIds.map(() => "?").join(",")})
      UNION ALL
      SELECT n.id FROM notebooks n JOIN tree t ON n.parentId = t.id
    )
    SELECT DISTINCT id FROM tree
  `).all(...rootIds) as Array<{ id: string }>;
  const notebookIds = new Set(descendants.map((row) => row.id));
  if (!notebookIds.size) return { notebookIds, noteIds: new Set() };
  const values = [...notebookIds];
  const notes = getDb().prepare(`SELECT id FROM notes WHERE notebookId IN (${values.map(() => "?").join(",")})`)
    .all(...values) as Array<{ id: string }>;
  return { notebookIds, noteIds: new Set(notes.map((row) => row.id)) };
}

async function readJson(zip: JSZip, filename: string): Promise<unknown> {
  const entry = zip.file(filename);
  if (!entry) return null;
  try { return JSON.parse(await entry.async("string")); }
  catch { return null; }
}

function itemIds(value: unknown, idKey = "id"): string[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return items
    .map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>)[idKey] || "") : "")
    .filter(Boolean);
}

async function packageSourceIds(zip: JSZip): Promise<Record<ResourceType, string[]>> {
  const tree = await readJson(zip, "tree.json");
  const treeNodes = tree && typeof tree === "object" && Array.isArray((tree as { nodes?: unknown[] }).nodes)
    ? (tree as { nodes: unknown[] }).nodes
    : [];
  let notebooks = treeNodes
    .map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).sourceId || "") : "")
    .filter(Boolean);
  if (!notebooks.length) notebooks = itemIds(await readJson(zip, "notebooks.json"));

  let notes = itemIds(await readJson(zip, "notes.json"));
  if (!notes.length) {
    notes = [...new Set(Object.keys(zip.files)
      .map((filename) => filename.match(/^notes\/([^/]+)\/meta\.json$/)?.[1] || "")
      .filter(Boolean))];
  }

  let attachments = itemIds(await readJson(zip, "attachments.json"));
  if (!attachments.length) {
    attachments = [...new Set(Object.keys(zip.files)
      .map((filename) => filename.match(/^attachments\/([^/]+)\/(?:meta\.json|[^/]+)$/)?.[1] || "")
      .filter(Boolean))];
  }
  return { notebook: notebooks, note: notes, attachment: attachments };
}

function packageLinks(
  afterLinks: Array<Record<string, unknown>>,
  sourceIds: Record<ResourceType, string[]>,
): { rows: Array<Record<string, unknown>>; missing: string[] } {
  const expected = new Map<ResourceType, Set<string>>([
    ["notebook", new Set(sourceIds.notebook)],
    ["note", new Set(sourceIds.note)],
    ["attachment", new Set(sourceIds.attachment)],
  ]);
  const rows = afterLinks.filter((row) => {
    const type = String(row.resourceType || "") as ResourceType;
    return expected.get(type)?.has(String(row.sourceResourceId || "")) === true;
  });
  const covered = new Map<ResourceType, Set<string>>([
    ["notebook", new Set()],
    ["note", new Set()],
    ["attachment", new Set()],
  ]);
  for (const row of rows) {
    const type = String(row.resourceType || "") as ResourceType;
    covered.get(type)?.add(String(row.sourceResourceId || ""));
  }
  const missing: string[] = [];
  for (const [type, ids] of expected) {
    for (const id of ids) if (!covered.get(type)?.has(id)) missing.push(`${type}:${id}`);
  }
  return { rows, missing };
}

function refineUndoState(args: {
  state: MutableUndoState;
  result: Record<string, unknown>;
  importMode: string;
  packageKind: string | null;
  packageLinks: Array<Record<string, unknown>>;
  stableMappingsExpected: boolean;
}): { available: boolean; reason: string | null } {
  const beforeNotebooks = stringSet(args.state.beforeScope?.notebooks);
  const beforeNotes = stringSet(args.state.beforeScope?.notes);
  const beforeAttachments = stringSet(args.state.beforeScope?.attachments);
  const updatedNotebooks = stringSet(args.state.updated?.notebooks?.map((row) => row.id));
  const updatedNotes = stringSet(args.state.updated?.notes?.map((item) => item.row?.id));

  let createdNotebooks = new Set<string>();
  let createdNotes = new Set<string>();
  let createdAttachments = new Set<string>();

  if (args.stableMappingsExpected) {
    createdNotebooks = new Set([...mappedTargets(args.packageLinks, "notebook")].filter((id) => !beforeNotebooks.has(id)));
    createdNotes = new Set([...mappedTargets(args.packageLinks, "note")].filter((id) => !beforeNotes.has(id)));
    createdAttachments = new Set([...mappedTargets(args.packageLinks, "attachment")].filter((id) => !beforeAttachments.has(id)));
  } else if (args.importMode !== "merge") {
    const roots = Array.isArray(args.result.rootNotebookIds)
      ? args.result.rootNotebookIds.map((value) => String(value || "")).filter(Boolean)
      : args.result.rootNotebookId
        ? [String(args.result.rootNotebookId)]
        : [];
    const createdRoots = roots.filter((id) => !beforeNotebooks.has(id));
    const tree = descendantsFromCreatedRoots(createdRoots);
    createdNotebooks = new Set([...tree.notebookIds].filter((id) => !beforeNotebooks.has(id)));
    createdNotes = new Set([...tree.noteIds].filter((id) => !beforeNotes.has(id)));
    if (createdNotes.size) {
      const noteIds = [...createdNotes];
      const rows = getDb().prepare(`SELECT id FROM attachments WHERE noteId IN (${noteIds.map(() => "?").join(",")})`)
        .all(...noteIds) as Array<{ id: string }>;
      createdAttachments = new Set(rows.map((row) => row.id).filter((id) => !beforeAttachments.has(id)));
    }
  } else {
    return {
      available: false,
      reason: args.packageKind === "markdown"
        ? "Markdown 合并导入没有稳定资源映射，无法保证只撤销本批次创建的内容"
        : "数据包缺少稳定来源映射，无法安全识别合并导入创建的资源",
    };
  }

  args.state.created = {
    notebookIds: [...createdNotebooks],
    noteIds: [...createdNotes],
    attachmentRows: attachmentRows(createdAttachments),
    // Tags have no package-stable target mapping. Leaving an unused imported tag is safer than
    // accidentally deleting a concurrently-created local tag with the same scope diff.
    tagIds: [],
  };
  const allowedNotebooks = new Set([...createdNotebooks, ...updatedNotebooks]);
  const allowedNotes = new Set([...createdNotes, ...updatedNotes]);
  args.state.afterHashes = {
    notebooks: filterHashes(args.state.afterHashes?.notebooks, allowedNotebooks),
    notes: filterHashes(args.state.afterHashes?.notes, allowedNotes),
    tags: {},
  };
  return { available: true, reason: null };
}

export async function captureRoundTripImportLinkUndo(
  zipBuffer: Buffer,
  userId: string,
  workspaceId: string | null | undefined,
): Promise<ImportIdentitySnapshot | null> {
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    const entry = zip.file("manifest.json");
    if (!entry) return null;
    const manifest = JSON.parse(await entry.async("string")) as Record<string, unknown>;
    const sourceInstanceId = String(manifest.sourceInstanceId || "").trim() || null;
    const packageKind = manifest.packageKind ? String(manifest.packageKind) : null;
    const scope = workspaceId || "personal";
    return {
      packageKind,
      sourceInstanceId,
      workspaceScope: scope,
      sourceIds: await packageSourceIds(zip),
      beforeRows: sourceInstanceId && packageKind !== "markdown"
        ? currentRows(userId, scope, sourceInstanceId)
        : [],
    };
  } catch {
    return null;
  }
}

export function attachRoundTripImportLinkUndo(
  userId: string,
  batchId: string,
  snapshot: ImportIdentitySnapshot | null,
): { available: boolean; reason: string | null } {
  try {
    const batch = getDb().prepare(`
      SELECT undoStateJson, undoAvailable, resultJson, importMode, packageKind
        FROM roundtrip_import_batches
       WHERE id = ? AND userId = ?
    `).get(batchId, userId) as {
      undoStateJson: string;
      undoAvailable: number;
      resultJson: string;
      importMode: string;
      packageKind: string | null;
    } | undefined;
    if (!batch) {
      removeUndoBackup(batchId);
      return { available: false, reason: "导入批次不存在，无法记录撤销点" };
    }
    if (!batch.undoAvailable) return { available: false, reason: null };

    const state = JSON.parse(batch.undoStateJson || "{}") as MutableUndoState;
    const result = JSON.parse(batch.resultJson || "{}") as Record<string, unknown>;
    const sourceInstanceId = snapshot?.sourceInstanceId || null;
    const packageKind = snapshot?.packageKind || batch.packageKind;
    const stableMappingsExpected = !!sourceInstanceId && packageKind !== "markdown";
    const afterLinks = stableMappingsExpected
      ? currentRows(userId, snapshot?.workspaceScope || "personal", sourceInstanceId!)
      : [];
    const matched = snapshot && stableMappingsExpected
      ? packageLinks(afterLinks, snapshot.sourceIds)
      : { rows: [], missing: [] };
    if (matched.missing.length) {
      const reason = `来源映射不完整，缺少 ${matched.missing.length} 个资源，已关闭一键撤销`;
      getDb().prepare(`
        UPDATE roundtrip_import_batches
           SET undoAvailable = 0, undoUnavailableReason = ?
         WHERE id = ? AND userId = ?
      `).run(reason, batchId, userId);
      removeUndoBackup(batchId);
      return { available: false, reason };
    }

    const refined = refineUndoState({
      state,
      result,
      importMode: batch.importMode,
      packageKind,
      packageLinks: matched.rows,
      stableMappingsExpected,
    });
    if (!refined.available) {
      getDb().prepare(`
        UPDATE roundtrip_import_batches
           SET undoAvailable = 0, undoUnavailableReason = ?, undoStateJson = ?
         WHERE id = ? AND userId = ?
      `).run(refined.reason, JSON.stringify(state), batchId, userId);
      removeUndoBackup(batchId);
      return refined;
    }

    if (sourceInstanceId && snapshot && packageKind !== "markdown") {
      state.sourceLinks = {
        sourceInstanceId,
        workspaceScope: snapshot.workspaceScope,
        beforeRows: snapshot.beforeRows,
        afterHash: hashRows(afterLinks),
      };
    }
    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET undoStateJson = ?
       WHERE id = ? AND userId = ?
    `).run(JSON.stringify(state), batchId, userId);
    return { available: true, reason: null };
  } catch (error) {
    const reason = `撤销点归属记录失败：${error instanceof Error ? error.message : String(error)}`;
    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET undoAvailable = 0, undoUnavailableReason = ?
       WHERE id = ? AND userId = ?
    `).run(reason, batchId, userId);
    removeUndoBackup(batchId);
    return { available: false, reason };
  }
}

function readStoredLinkUndo(userId: string, batchId: string): StoredLinkUndo | null {
  const row = getDb().prepare(`
    SELECT undoStateJson FROM roundtrip_import_batches WHERE id = ? AND userId = ?
  `).get(batchId, userId) as { undoStateJson: string } | undefined;
  if (!row) return null;
  try {
    const state = JSON.parse(row.undoStateJson || "{}") as { sourceLinks?: StoredLinkUndo };
    return state.sourceLinks || null;
  } catch {
    return null;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function insertDynamic(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  getDb().prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column]));
}

export async function undoRoundTripImportBatchWithLinks(
  userId: string,
  batchId: string,
): Promise<RoundTripImportBatchDetail> {
  const links = readStoredLinkUndo(userId, batchId);
  if (links) {
    const currentHash = hashRows(currentRows(userId, links.workspaceScope, links.sourceInstanceId));
    if (currentHash !== links.afterHash) {
      throw new RoundTripImportUndoError(
        "该来源在本批次之后又执行过导入或同步，已拒绝回滚旧映射",
        "IMPORT_BATCH_UNDO_SOURCE_LINK_CONFLICT",
        409,
        ["来源映射已发生变化，请优先撤销最新的一次同来源导入"],
      );
    }
  }

  const detail = await undoRoundTripImportBatch(userId, batchId);
  if (!links) return detail;

  const transaction = getDb().transaction(() => {
    getDb().prepare(`
      DELETE FROM roundtrip_import_links
       WHERE userId = ? AND workspaceScope = ? AND sourceInstanceId = ?
    `).run(userId, links.workspaceScope, links.sourceInstanceId);
    for (const row of links.beforeRows) insertDynamic("roundtrip_import_links", row);
  });
  try {
    transaction();
  } catch (error) {
    const message = `资源已撤销，但来源映射恢复失败：${error instanceof Error ? error.message : String(error)}`;
    getDb().prepare("UPDATE roundtrip_import_batches SET undoError = ? WHERE id = ? AND userId = ?")
      .run(message, batchId, userId);
    throw new RoundTripImportUndoError(message, "IMPORT_BATCH_UNDO_LINK_RESTORE_FAILED", 409);
  }
  return detail;
}
