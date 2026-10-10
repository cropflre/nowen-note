export function validateSheetData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const rows = Array.isArray(data.rows) ? data.rows : null;
  const columns = Array.isArray(data.columns) ? data.columns : null;
  const cells = data.cells && typeof data.cells === "object" && !Array.isArray(data.cells)
    ? data.cells as Record<string, unknown>
    : null;
  if (!rows || !columns || !cells || rows.length > 1000 || columns.length > 200) return null;
  if (Object.keys(cells).length > 50_000) return null;
  return { ...data, version: 1, rows, columns, cells };
}
