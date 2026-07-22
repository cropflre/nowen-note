import crypto from "crypto";
import JSZip from "jszip";
import { getDb } from "../db/schema";
import {
  RoundTripImportUndoError,
  undoRoundTripImportBatch,
  type RoundTripImportBatchDetail,
} from "./roundTripImportBatches";

interface LinkSnapshot {
  sourceInstanceId: string;
  workspaceScope: string;
  beforeRows: Array<Record<string, unknown>>;
}

interface StoredLinkUndo extends LinkSnapshot {
  afterHash: string;
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

export async function captureRoundTripImportLinkUndo(
  zipBuffer: Buffer,
  userId: string,
  workspaceId: string | null | undefined,
): Promise<LinkSnapshot | null> {
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    const entry = zip.file("manifest.json");
    if (!entry) return null;
    const manifest = JSON.parse(await entry.async("string")) as Record<string, unknown>;
    const sourceInstanceId = String(manifest.sourceInstanceId || "").trim();
    if (!sourceInstanceId || manifest.packageKind === "markdown") return null;
    const scope = workspaceId || "personal";
    return {
      sourceInstanceId,
      workspaceScope: scope,
      beforeRows: currentRows(userId, scope, sourceInstanceId),
    };
  } catch {
    return null;
  }
}

export function attachRoundTripImportLinkUndo(
  userId: string,
  batchId: string,
  snapshot: LinkSnapshot | null,
): { available: boolean; reason: string | null } {
  if (!snapshot) return { available: true, reason: null };
  try {
    const batch = getDb().prepare(`
      SELECT undoStateJson, undoAvailable FROM roundtrip_import_batches
       WHERE id = ? AND userId = ?
    `).get(batchId, userId) as { undoStateJson: string; undoAvailable: number } | undefined;
    if (!batch) return { available: false, reason: "导入批次不存在，无法记录来源映射撤销点" };
    const state = JSON.parse(batch.undoStateJson || "{}") as Record<string, unknown>;
    const stored: StoredLinkUndo = {
      ...snapshot,
      afterHash: hashRows(currentRows(userId, snapshot.workspaceScope, snapshot.sourceInstanceId)),
    };
    state.sourceLinks = stored;
    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET undoStateJson = ?
       WHERE id = ? AND userId = ?
    `).run(JSON.stringify(state), batchId, userId);
    return { available: batch.undoAvailable === 1, reason: null };
  } catch (error) {
    const reason = `来源映射撤销点记录失败：${error instanceof Error ? error.message : String(error)}`;
    getDb().prepare(`
      UPDATE roundtrip_import_batches
         SET undoAvailable = 0, undoUnavailableReason = ?
       WHERE id = ? AND userId = ?
    `).run(reason, batchId, userId);
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
