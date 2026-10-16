import * as XLSX from "xlsx";
import type { ICellData, IWorksheetData } from "@univerjs/core";

/** 新建工作簿的空快照（字段与 Univer IWorkbookData 必需项对齐）。 */
export function createEmptyWorkbookSnapshot(title: string): Record<string, unknown> {
  return {
    id: "workbook-01",
    name: title || "Workbook",
    appVersion: "1.0.3",
    locale: "zh-CN",
    styles: {},
    sheetOrder: ["sheet-01"],
    sheets: {
      "sheet-01": {
        id: "sheet-01",
        name: "Sheet1",
        tabColor: undefined,
        hidden: false,
        rowCount: 200,
        columnCount: 30,
        zoomRatio: 1,
        cellData: {},
        mergeData: [],
      },
    },
  };
}

function worksheetToCellData(sheet: XLSX.WorkSheet): {
  cellData: Record<number, Record<number, ICellData>>;
  merges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>;
  rowCount: number;
  columnCount: number;
} {
  const cellData: Record<number, Record<number, ICellData>> = {};
  const merges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }> = [];
  const ref = sheet["!ref"] || "A1";
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (!cell) continue;
      const target: ICellData = {};
      if (cell.f) target.f = `=${cell.f}`;
      if (cell.v !== undefined) {
        const value = cell.v;
        if (typeof value === "number") { target.v = value; target.t = 2; }
        else if (typeof value === "boolean") { target.v = value; target.t = 3; }
        else if (value instanceof Date) { target.v = value.toISOString(); target.t = 1; }
        else { target.v = String(value); target.t = 1; }
      }
      if (target.v !== undefined || target.f) {
        cellData[r] = cellData[r] || {};
        cellData[r][c] = target;
      }
    }
  }
  const rawMerges = (sheet["!merges"] as XLSX.Range[] | undefined) || [];
  for (const merge of rawMerges) {
    merges.push({
      startRow: merge.s.r,
      endRow: merge.e.r,
      startColumn: merge.s.c,
      endColumn: merge.e.c,
    });
  }
  return {
    cellData,
    merges,
    rowCount: Math.max(range.e.r + 1, 100),
    columnCount: Math.max(range.e.c + 1, 26),
  };
}

/** XLSX 文件 → Univer 工作簿快照。 */
export function xlsxToWorkbookSnapshot(buffer: ArrayBuffer, fallbackTitle: string): Record<string, unknown> {
  const workbook = XLSX.read(buffer, { type: "array", cellFormula: true, cellDates: false });
  const sheets: Record<string, IWorksheetData> = {};
  const sheetOrder: string[] = [];
  workbook.SheetNames.forEach((sheetName, index) => {
    const id = `sheet-${String(index + 1).padStart(2, "0")}`;
    const { cellData, merges, rowCount, columnCount } = worksheetToCellData(workbook.Sheets[sheetName]);
      sheets[id] = {
        id,
        name: sheetName,
        rowCount: Math.min(rowCount, 100_000),
        columnCount: Math.min(columnCount, 1_000),
        cellData,
        mergeData: merges,
      } as IWorksheetData;
    sheetOrder.push(id);
  });
  return {
    id: "workbook-01",
    name: fallbackTitle || workbook.SheetNames[0] || "Workbook",
    appVersion: "1.0.3",
    locale: "zh-CN",
    styles: {},
    sheetOrder,
    sheets,
  };
}

function cellDataToSheet(cellData: Record<number, Record<number, ICellData>> | undefined): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {};
  let maxRow = 0;
  let maxColumn = 0;
  const rows = cellData || {};
  for (const rowKey of Object.keys(rows)) {
    const r = Number(rowKey);
    if (!Number.isInteger(r) || r < 0) continue;
    const cols = rows[r] || {};
    for (const colKey of Object.keys(cols)) {
      const c = Number(colKey);
      if (!Number.isInteger(c) || c < 0) continue;
      const cell = cols[c] as ICellData;
      if (!cell || (cell.v === undefined && !cell.f)) continue;
      const target: XLSX.CellObject = { t: "s" };
      if (typeof cell.v === "number") { target.v = cell.v; target.t = "n"; }
      else if (typeof cell.v === "boolean") { target.v = cell.v; target.t = "b"; }
      else if (cell.v !== undefined) { target.v = String(cell.v); target.t = "s"; }
      if (cell.f) target.f = cell.f.startsWith("=") ? cell.f.slice(1) : cell.f;
      if (target.v === undefined && !target.f) continue;
      if (target.t === undefined) target.t = typeof target.v === "number" ? "n" : "s";
      sheet[XLSX.utils.encode_cell({ r, c })] = target;
      if (r > maxRow) maxRow = r;
      if (c > maxColumn) maxColumn = c;
    }
  }
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxColumn } });
  return sheet;
}

/** Univer 工作簿快照 → XLSX 文件（ArrayBuffer）。 */
export function workbookSnapshotToXlsx(data: Record<string, unknown>): ArrayBuffer {
  const sheets = (data.sheets || {}) as Record<string, IWorksheetData>;
  const sheetOrder = Array.isArray(data.sheetOrder) ? (data.sheetOrder as string[]) : Object.keys(sheets);
  const workbook = XLSX.utils.book_new();
  for (const sheetId of sheetOrder) {
    const worksheet = sheets[sheetId];
    if (!worksheet) continue;
    const sheet = cellDataToSheet(worksheet.cellData as Record<number, Record<number, ICellData>> | undefined);
    const merges = (worksheet.mergeData || []) as Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>;
    if (merges.length > 0) {
      sheet["!merges"] = merges.map((m) => ({
        s: { r: m.startRow, c: m.startColumn },
        e: { r: m.endRow, c: m.endColumn },
      }));
    }
    XLSX.utils.book_append_sheet(workbook, sheet, worksheet.name || "Sheet1");
  }
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return output;
}

function csvTextToSheet(text: string): XLSX.WorkSheet {
  const workbook = XLSX.read(text, { type: "string", raw: true });
  const first = workbook.SheetNames[0];
  return first ? workbook.Sheets[first] : XLSX.utils.aoa_to_sheet([[]]);
}

/** CSV 文本 → Univer 工作簿快照。 */
export function csvToWorkbookSnapshot(text: string, fallbackTitle: string): Record<string, unknown> {
  const sheet = csvTextToSheet(text);
  const { cellData, rowCount, columnCount } = worksheetToCellData(sheet);
  return {
    id: "workbook-01",
    name: fallbackTitle || "Workbook",
    appVersion: "1.0.3",
    locale: "zh-CN",
    styles: {},
    sheetOrder: ["sheet-01"],
    sheets: {
      "sheet-01": {
        id: "sheet-01",
        name: "Sheet1",
        rowCount: Math.min(rowCount, 100_000),
        columnCount: Math.min(columnCount, 1_000),
        cellData,
        mergeData: [],
      },
    },
  };
}

/** Univer 工作簿快照 → CSV 文本（仅导出第一个工作表，值与轻量表格导出习惯一致）。 */
export function workbookSnapshotToCsv(data: Record<string, unknown>): string {
  const sheets = (data.sheets || {}) as Record<string, IWorksheetData>;
  const sheetOrder = Array.isArray(data.sheetOrder) ? (data.sheetOrder as string[]) : Object.keys(sheets);
  const first = sheetOrder.length > 0 ? sheets[sheetOrder[0]] : undefined;
  if (!first) return "";
  const sheet = cellDataToSheet(first.cellData as Record<number, Record<number, ICellData>> | undefined);
  return XLSX.utils.sheet_to_csv(sheet);
}

export const XLSX_FILE_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
