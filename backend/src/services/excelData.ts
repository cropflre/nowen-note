/**
 * Excel 工作簿（Univer 快照）的校验、检索文本和发布开关。
 * 思路来源：cropflre/nowen-note PR #802（serializeExcelText 采纳，校验与开关重写）。
 */

import type Database from "better-sqlite3";

/** 序列化后的快照上限；与前端导入上限对应，超出时明确拒绝而不是截断。 */
export const EXCEL_MAX_DATA_BYTES = 10 * 1024 * 1024;
const MAX_INDEX_TEXT_CHARS = 100_000;
const MAX_SHEETS = 50;
const VALID_NOTE_TYPES = new Set(["normal", "markdown", "plaintext", "word", "sheet", "excel"]);

/**
 * Excel 工作簿默认开放新建；运维仍可通过 NOWEN_EXCEL_WORKBOOK=0 显式关闭新建入口，
 * 已有工作簿始终可读写，不让数据被锁死。
 */
export function isExcelWorkbookCreationEnabled(): boolean {
  return process.env.NOWEN_EXCEL_WORKBOOK !== "0";
}

export function normalizeNoteType(value: unknown, fallback = "normal"): string {
  return typeof value === "string" && VALID_NOTE_TYPES.has(value) ? value : fallback;
}

export function withExcelDocumentSupport<T extends Record<string, unknown>>(
  db: Database.Database,
  payload: T,
): T & { note_type?: string; excelData?: string; excelRevision?: number } {
  const noteType = typeof payload.note_type === "string"
    ? payload.note_type
    : typeof payload.noteType === "string"
      ? payload.noteType
      : undefined;
  if (noteType !== "excel" || typeof payload.id !== "string" || !payload.id) {
    return payload;
  }
  const row = db.prepare("SELECT data, revision FROM excel_documents WHERE noteId = ?")
    .get(payload.id) as { data: string; revision: number } | undefined;
  if (!row) return { ...payload, note_type: "excel" };
  return {
    ...payload,
    note_type: "excel",
    excelData: row.data,
    excelRevision: row.revision,
  };
}

export function parseSyncedExcelPayload(raw: unknown): { data: Record<string, unknown>; json: string } | null {
  if (typeof raw === "string") {
    try {
      return validateExcelData(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return validateExcelData(raw);
}

export function upsertExcelDocumentFromSync(
  db: Database.Database,
  input: {
    noteId: string;
    userId: string;
    workspaceId: string | null;
    excelData: unknown;
    excelRevision?: unknown;
    title?: string;
    strict?: boolean;
  },
): void {
  const hasPayload = input.excelData !== undefined && input.excelData !== null && input.excelData !== "";
  let validated = hasPayload ? parseSyncedExcelPayload(input.excelData) : null;
  if (hasPayload && !validated) {
    if (input.strict) {
      throw new Error("INVALID_EXCEL_PAYLOAD");
    }
    return;
  }
  if (!validated) {
    // 已有本地工作簿时绝不用空表覆盖；仅在首次创建且远端未携带快照时兜底默认工作簿。
    const exists = db.prepare("SELECT 1 FROM excel_documents WHERE noteId = ?").get(input.noteId);
    if (exists) return;
    validated = validateExcelData(createDefaultExcelWorkbook(input.title || "无标题表格"));
    if (!validated) return;
  }
  const rev = typeof input.excelRevision === "number" && Number.isInteger(input.excelRevision) && input.excelRevision >= 1
    ? input.excelRevision
    : 1;
  db.prepare(`
    INSERT INTO excel_documents (noteId, userId, workspaceId, data, revision, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
    ON CONFLICT(noteId) DO UPDATE SET
      userId = excluded.userId,
      workspaceId = excluded.workspaceId,
      data = excluded.data,
      revision = MAX(excel_documents.revision + 1, excluded.revision),
      updatedAt = strftime('%Y-%m-%d %H:%M:%f', 'now')
  `).run(input.noteId, input.userId, input.workspaceId, validated.json, rev);
}

export function createDefaultExcelWorkbook(title: string): Record<string, unknown> {
  return {
    id: "workbook-01",
    name: title,
    locale: "zhCN",
    styles: {},
    sheetOrder: ["sheet-01"],
    sheets: {
      "sheet-01": {
        id: "sheet-01",
        name: "Sheet1",
        rowCount: 200,
        columnCount: 30,
        cellData: {},
        mergeData: [],
      },
    },
  };
}

/**
 * 校验 Univer 快照：对象、含 id、sheetOrder 与 sheets 一一对应、体积受限。
 * 返回已序列化 JSON，调用方直接落库，避免二次 stringify。
 */
export function validateExcelData(value: unknown): { data: Record<string, unknown>; json: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || data.id.length === 0 || data.id.length > 200) return null;
  const sheets = data.sheets;
  if (!sheets || typeof sheets !== "object" || Array.isArray(sheets)) return null;
  const sheetIds = Object.keys(sheets);
  if (sheetIds.length === 0 || sheetIds.length > MAX_SHEETS) return null;
  for (const id of sheetIds) {
    const sheet = (sheets as Record<string, unknown>)[id];
    if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) return null;
  }
  if (data.sheetOrder !== undefined) {
    if (!Array.isArray(data.sheetOrder)) return null;
    if (data.sheetOrder.some((id) => typeof id !== "string" || !sheetIds.includes(id))) return null;
  }
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return null;
  }
  if (Buffer.byteLength(json, "utf8") > EXCEL_MAX_DATA_BYTES) return null;
  return { data, json };
}

interface IndexCell { v?: unknown }
type IndexSheet = { name?: unknown; cellData?: Record<string, Record<string, IndexCell>> };

/**
 * 把工作簿序列化为可检索文本：每张工作表以名称开头，行内制表符分隔。
 * 写入 notes.contentText 后由现有 FTS / 向量 / AI 检索链路按原有权限读取。
 */
export function serializeExcelText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const workbook = data as { sheets?: Record<string, IndexSheet>; sheetOrder?: unknown };
  const sheets = workbook.sheets;
  if (!sheets || typeof sheets !== "object") return "";
  const order = Array.isArray(workbook.sheetOrder)
    ? workbook.sheetOrder.filter((id): id is string => typeof id === "string" && Boolean(sheets[id]))
    : Object.keys(sheets);
  const lines: string[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    const cellData = sheet?.cellData;
    if (!cellData || typeof cellData !== "object") continue;
    const sheetLines: string[] = [];
    const rowIndexes = Object.keys(cellData).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    for (const rowIndex of rowIndexes) {
      const columns = cellData[String(rowIndex)];
      if (!columns || typeof columns !== "object") continue;
      const colIndexes = Object.keys(columns).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
      const row: string[] = [];
      for (const colIndex of colIndexes) {
        const raw = columns[String(colIndex)]?.v;
        const text = raw === null || raw === undefined ? "" : String(raw).replace(/[\t\r\n]+/g, " ");
        if (text) row.push(text);
      }
      if (row.length) sheetLines.push(row.join("\t"));
    }
    if (sheetLines.length) {
      if (order.length > 1) lines.push(String(sheet?.name || sheetId));
      lines.push(...sheetLines);
    }
  }
  const full = lines.join("\n");
  return full.length > MAX_INDEX_TEXT_CHARS ? full.slice(0, MAX_INDEX_TEXT_CHARS) : full;
}
