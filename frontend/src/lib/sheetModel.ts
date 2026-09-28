export interface SheetRowModel { id: string; height: number }
export interface SheetColumnModel { id: string; title: string; width: number }
export interface SheetDataModel {
  version: 1;
  rows: SheetRowModel[];
  columns: SheetColumnModel[];
  cells: Record<string, string>;
}

export function sheetCellKey(rowId: string, columnId: string): string {
  return `${rowId}:${columnId}`;
}

export function normalizeSheetData(value: any): SheetDataModel {
  const rows = Array.isArray(value?.rows) ? value.rows.map((row: any, index: number) => ({
    id: typeof row?.id === "string" && row.id ? row.id : `r${index + 1}`,
    height: Math.max(24, Math.min(120, Number(row?.height) || 32)),
  })) : [];
  const columns = Array.isArray(value?.columns) ? value.columns.map((column: any, index: number) => ({
    id: typeof column?.id === "string" && column.id ? column.id : `c${index + 1}`,
    title: typeof column?.title === "string" ? column.title : String.fromCharCode(65 + (index % 26)),
    width: Math.max(64, Math.min(480, Number(column?.width) || 120)),
  })) : [];
  const cells: Record<string, string> = {};
  if (value?.cells && typeof value.cells === "object" && !Array.isArray(value.cells)) {
    for (const [key, raw] of Object.entries(value.cells)) cells[key] = raw == null ? "" : String(raw);
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
  return { ...data, rows: [...data.rows, { id: nextId("r", data.rows.map(r => r.id)), height: 32 }] };
}

export function addSheetColumn(data: SheetDataModel): SheetDataModel {
  const index = data.columns.length;
  return {
    ...data,
    columns: [...data.columns, {
      id: nextId("c", data.columns.map(c => c.id)),
      title: String.fromCharCode(65 + (index % 26)),
      width: 120,
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

export function sortSheetRows(data: SheetDataModel, columnId: string, direction: "asc" | "desc"): SheetDataModel {
  const rows = [...data.rows].sort((a, b) => {
    const left = data.cells[sheetCellKey(a.id, columnId)] || "";
    const right = data.cells[sheetCellKey(b.id, columnId)] || "";
    const numericLeft = Number(left);
    const numericRight = Number(right);
    const bothNumbers = left.trim() !== "" && right.trim() !== "" && Number.isFinite(numericLeft) && Number.isFinite(numericRight);
    const result = bothNumbers ? numericLeft - numericRight : left.localeCompare(right, "zh-CN", { numeric: true });
    return direction === "asc" ? result : -result;
  });
  return { ...data, rows };
}
