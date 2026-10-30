/** Univer 工作簿快照的校验与 AI 检索文本序列化。 */

const MAX_DATA_BYTES = 10 * 1024 * 1024;
const MAX_INDEX_TEXT_CHARS = 100_000;

/** 校验 Univer 快照 JSON：必须是对象、含 id/sheets，且体积受限。 */
export function validateExcelData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || data.id.length === 0) return null;
  if (!data.sheets || typeof data.sheets !== "object" || Array.isArray(data.sheets)) return null;
  try {
    if (JSON.stringify(data).length > MAX_DATA_BYTES) return null;
  } catch {
    return null;
  }
  return data;
}

interface IndexCell { v?: unknown }

/**
 * 把工作簿快照序列化为可检索文本（按行制表符分隔）。
 * 用于写入 notes.contentText，使 FTS / 向量 / AI 检索能命中表格内容。
 */
export function serializeExcelText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const sheets = (data as { sheets?: Record<string, { cellData?: Record<string, Record<string, IndexCell>> }> }).sheets;
  if (!sheets || typeof sheets !== "object") return "";
  const lines: string[] = [];
  for (const sheet of Object.values(sheets)) {
    const cellData = sheet?.cellData;
    if (!cellData || typeof cellData !== "object") continue;
    const rowIndexes = Object.keys(cellData).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    for (const rowIndex of rowIndexes) {
      const columns = cellData[String(rowIndex)] || cellData[rowIndex];
      if (!columns) continue;
      const colIndexes = Object.keys(columns).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
      if (colIndexes.length === 0) continue;
      const maxCol = colIndexes[colIndexes.length - 1];
      const row: string[] = new Array(maxCol + 1).fill("");
      for (const colIndex of colIndexes) {
        const cell = columns[String(colIndex)] || columns[colIndex];
        if (!cell) continue;
        const raw = cell.v;
        const text = raw === null || raw === undefined ? "" : String(raw);
        if (text) row[colIndex] = text.replace(/[\t\r\n]+/g, " ");
      }
      const joined = row.join("\t").trim();
      if (joined) lines.push(joined);
    }
  }
  const full = lines.join("\n");
  return full.length > MAX_INDEX_TEXT_CHARS ? full.slice(0, MAX_INDEX_TEXT_CHARS) : full;
}
