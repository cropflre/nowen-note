export type SheetCellType = "text" | "number" | "date";
export type SheetTextAlign = "left" | "center" | "right";

export interface SheetRowModel { id: string; height: number }
export interface SheetColumnModel {
  id: string;
  title: string;
  width: number;
  type: SheetCellType;
  align: SheetTextAlign;
}
export interface SheetDataModel {
  version: 1;
  rows: SheetRowModel[];
  columns: SheetColumnModel[];
  cells: Record<string, string>;
}

const MAX_SHEET_ROWS = 1000;
const MAX_SHEET_COLUMNS = 200;

function normalizeCellType(value: unknown): SheetCellType {
  return value === "number" || value === "date" ? value : "text";
}

function normalizeTextAlign(value: unknown): SheetTextAlign {
  return value === "center" || value === "right" ? value : "left";
}

export function sheetCellKey(rowId: string, columnId: string): string {
  return `${rowId}:${columnId}`;
}

export function normalizeSheetData(input: unknown): SheetDataModel {
  const value = input as { rows?: Partial<SheetRowModel>[]; columns?: Partial<SheetColumnModel>[]; cells?: Record<string, unknown> } | null | undefined;
  const rows: SheetRowModel[] = Array.isArray(value?.rows) ? value.rows.slice(0, MAX_SHEET_ROWS).map((row, index: number) => ({
    id: typeof row?.id === "string" && row.id ? row.id : `r${index + 1}`,
    height: Math.max(24, Math.min(120, Number(row?.height) || 32)),
  })) : [];
  const columns: SheetColumnModel[] = Array.isArray(value?.columns) ? value.columns.slice(0, MAX_SHEET_COLUMNS).map((column, index: number) => ({
    id: typeof column?.id === "string" && column.id ? column.id : `c${index + 1}`,
    title: typeof column?.title === "string" ? column.title : String.fromCharCode(65 + (index % 26)),
    width: Math.max(64, Math.min(480, Number(column?.width) || 120)),
    type: normalizeCellType(column?.type),
    align: normalizeTextAlign(column?.align),
  })) : [];
  const cells: Record<string, string> = {};
  const validRows = new Set(rows.map((row) => row.id));
  const validColumns = new Set(columns.map((column) => column.id));
  if (value?.cells && typeof value.cells === "object" && !Array.isArray(value.cells)) {
    for (const [key, raw] of Object.entries(value.cells)) {
      const splitAt = key.indexOf(":");
      if (splitAt <= 0) continue;
      const rowId = key.slice(0, splitAt);
      const columnId = key.slice(splitAt + 1);
      if (!validRows.has(rowId) || !validColumns.has(columnId)) continue;
      cells[key] = raw == null ? "" : String(raw).slice(0, 20_000);
    }
  }
  return { version: 1, rows, columns, cells };
}

export function setSheetCell(data: SheetDataModel, rowId: string, columnId: string, value: string): SheetDataModel {
  const key = sheetCellKey(rowId, columnId);
  const cells = { ...data.cells };
  if (value === "") delete cells[key]; else cells[key] = value;
  return { ...data, cells };
}

function nextId(prefix: string, existing: string[]): string {
  const used = new Set(existing);
  let index = existing.length + 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

export function addSheetRow(data: SheetDataModel): SheetDataModel {
  if (data.rows.length >= MAX_SHEET_ROWS) return data;
  return { ...data, rows: [...data.rows, { id: nextId("r", data.rows.map(r => r.id)), height: 32 }] };
}

export function addSheetColumn(data: SheetDataModel): SheetDataModel {
  if (data.columns.length >= MAX_SHEET_COLUMNS) return data;
  const index = data.columns.length;
  return {
    ...data,
    columns: [...data.columns, {
      id: nextId("c", data.columns.map(c => c.id)),
      title: String.fromCharCode(65 + (index % 26)),
      width: 120,
      type: "text",
      align: "left",
    }],
  };
}

export function deleteSheetRow(data: SheetDataModel, rowId: string): SheetDataModel {
  const cells = Object.fromEntries(Object.entries(data.cells).filter(([key]) => !key.startsWith(`${rowId}:`)));
  return { ...data, rows: data.rows.filter(row => row.id !== rowId), cells };
}

export function deleteSheetColumn(data: SheetDataModel, columnId: string): SheetDataModel {
  const suffix = `:${columnId}`;
  const cells = Object.fromEntries(Object.entries(data.cells).filter(([key]) => !key.endsWith(suffix)));
  return { ...data, columns: data.columns.filter(column => column.id !== columnId), cells };
}

export function resizeSheetRow(data: SheetDataModel, rowId: string, height: number): SheetDataModel {
  return { ...data, rows: data.rows.map(row => row.id === rowId ? { ...row, height: Math.max(24, Math.min(120, height)) } : row) };
}

export function resizeSheetColumn(data: SheetDataModel, columnId: string, width: number): SheetDataModel {
  return { ...data, columns: data.columns.map(column => column.id === columnId ? { ...column, width: Math.max(64, Math.min(480, width)) } : column) };
}

export function setSheetColumnType(data: SheetDataModel, columnId: string, type: SheetCellType): SheetDataModel {
  return {
    ...data,
    columns: data.columns.map(column => column.id === columnId ? { ...column, type: normalizeCellType(type) } : column),
  };
}

export function setSheetColumnAlignment(data: SheetDataModel, columnId: string, align: SheetTextAlign): SheetDataModel {
  return {
    ...data,
    columns: data.columns.map(column => column.id === columnId ? { ...column, align: normalizeTextAlign(align) } : column),
  };
}

function moveItem<T extends { id: string }>(
  items: T[],
  sourceId: string,
  targetId: string,
  placement: "before" | "after",
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const next = [...items];
  const [item] = next.splice(sourceIndex, 1);
  let insertAt = targetIndex;
  if (sourceIndex < targetIndex) insertAt -= 1;
  if (placement === "after") insertAt += 1;
  next.splice(Math.max(0, Math.min(next.length, insertAt)), 0, item);
  return next;
}

export function moveSheetRow(
  data: SheetDataModel,
  sourceRowId: string,
  targetRowId: string,
  placement: "before" | "after" = "before",
): SheetDataModel {
  const rows = moveItem(data.rows, sourceRowId, targetRowId, placement);
  return rows === data.rows ? data : { ...data, rows };
}

export function moveSheetColumn(
  data: SheetDataModel,
  sourceColumnId: string,
  targetColumnId: string,
  placement: "before" | "after" = "before",
): SheetDataModel {
  const columns = moveItem(data.columns, sourceColumnId, targetColumnId, placement);
  return columns === data.columns ? data : { ...data, columns };
}

function comparableValue(value: string, type: SheetCellType): string | number {
  if (type === "number") {
    const numeric = Number(value);
    return value.trim() !== "" && Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
  }
  if (type === "date") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }
  return value;
}

export function sortSheetRows(data: SheetDataModel, columnId: string, direction: "asc" | "desc"): SheetDataModel {
  const column = data.columns.find((candidate) => candidate.id === columnId);
  const type = column?.type || "text";
  const rows = [...data.rows].sort((a, b) => {
    const left = data.cells[sheetCellKey(a.id, columnId)] || "";
    const right = data.cells[sheetCellKey(b.id, columnId)] || "";
    const leftValue = comparableValue(left, type);
    const rightValue = comparableValue(right, type);
    const result = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), "zh-CN", { numeric: true, sensitivity: "base" });
    return direction === "asc" ? result : -result;
  });
  return { ...data, rows };
}

export function filterSheetRows(data: SheetDataModel, columnId: string | null, query: string): SheetRowModel[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!columnId || !normalized) return data.rows;
  return data.rows.filter((row) =>
    (data.cells[sheetCellKey(row.id, columnId)] || "").toLocaleLowerCase().includes(normalized),
  );
}

function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function sheetToCsv(data: SheetDataModel): string {
  const lines = [
    data.columns.map((column) => escapeCsvCell(column.title)).join(","),
    ...data.rows.map((row) =>
      data.columns.map((column) => escapeCsvCell(data.cells[sheetCellKey(row.id, column.id)] || "")).join(","),
    ),
  ];
  return lines.join("\r\n");
}

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value !== "") || rows.length === 0) rows.push(row);
  return rows;
}

function inferColumnType(values: string[]): SheetCellType {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every((value) => Number.isFinite(Number(value)))) return "number";
  if (nonEmpty.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)))) return "date";
  return "text";
}

export function sheetFromCsv(source: string): SheetDataModel {
  const normalizedSource = source.replace(/^\uFEFF/, "");
  const parsed = parseCsvRows(normalizedSource);
  const header = (parsed.shift() || ["A"]).slice(0, MAX_SHEET_COLUMNS);
  const width = Math.max(1, header.length, ...parsed.map((row) => Math.min(MAX_SHEET_COLUMNS, row.length)));
  const dataRows = parsed.slice(0, MAX_SHEET_ROWS);
  const columns: SheetColumnModel[] = Array.from({ length: width }, (_, index) => {
    const values = dataRows.map((row) => row[index] || "");
    const type = inferColumnType(values);
    return {
      id: `c${index + 1}`,
      title: (header[index] || String.fromCharCode(65 + (index % 26))).slice(0, 120),
      width: 120,
      type,
      align: type === "number" ? "right" : "left",
    };
  });
  const rows: SheetRowModel[] = (dataRows.length > 0 ? dataRows : [[]]).map((_, index) => ({
    id: `r${index + 1}`,
    height: 32,
  }));
  const cells: Record<string, string> = {};
  dataRows.forEach((sourceRow, rowIndex) => {
    columns.forEach((column, columnIndex) => {
      const value = sourceRow[columnIndex] || "";
      if (value !== "") cells[sheetCellKey(rows[rowIndex].id, column.id)] = value.slice(0, 20_000);
    });
  });
  return { version: 1, rows, columns, cells };
}
