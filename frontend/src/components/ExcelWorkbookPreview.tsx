import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { ExcelCell, ExcelWorkbook } from "@/lib/excelWorkbookFile";
import { toast } from "@/lib/toast";

type PreviewCell = ExcelCell & { p?: { body?: { dataStream?: string } } };

const MAX_PREVIEW_ROWS = 300;
const MAX_PREVIEW_COLS = 50;

function columnLabel(index: number): string {
  let n = index;
  let result = "";
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function cellDisplayText(cell?: PreviewCell): string {
  if (!cell) return "";
  if (cell.v !== undefined && cell.v !== null && String(cell.v) !== "") return String(cell.v);
  const stream = cell.p?.body?.dataStream;
  if (typeof stream === "string") return stream.replace(/\r\n$|\r$|\n$/, "");
  if (typeof cell.f === "string") return cell.f;
  return "";
}

function parseWorkbook(raw: string): ExcelWorkbook | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ExcelWorkbook)
      : null;
  } catch {
    return null;
  }
}

export default function ExcelWorkbookPreview({
  data,
  title,
}: {
  data: string;
  title?: string;
}) {
  const workbook = useMemo(() => parseWorkbook(data), [data]);
  const sheetList = useMemo(() => {
    const sheets = workbook?.sheets;
    if (!sheets || typeof sheets !== "object") return [];
    const order = Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length > 0
      ? workbook.sheetOrder.filter((id) => Boolean(sheets[id]))
      : Object.keys(sheets);
    return order.map((id) => ({ id, sheet: sheets[id] }));
  }, [workbook]);

  const [activeId, setActiveId] = useState<string>(() => sheetList[0]?.id || "");
  const [exporting, setExporting] = useState(false);

  const current = sheetList.find((item) => item.id === activeId) || sheetList[0];

  const grid = useMemo(() => {
    if (!current) return null;
    const cellData = current.sheet.cellData || {};
    let maxRow = 0;
    let maxCol = 0;
    for (const [rowKey, cols] of Object.entries(cellData)) {
      const r = Number(rowKey);
      if (!Number.isInteger(r) || r < 0 || !cols || typeof cols !== "object") continue;
      for (const [colKey, cell] of Object.entries(cols)) {
        const c = Number(colKey);
        if (!Number.isInteger(c) || c < 0) continue;
        if (cellDisplayText(cell) !== "") {
          if (r > maxRow) maxRow = r;
          if (c > maxCol) maxCol = c;
        }
      }
    }
    const merges = Array.isArray(current.sheet.mergeData) ? current.sheet.mergeData : [];
    for (const merge of merges) {
      if (merge.endRow > maxRow) maxRow = merge.endRow;
      if (merge.endColumn > maxCol) maxCol = merge.endColumn;
    }

    const rowCount = Math.min(Math.max(maxRow + 1, 1), MAX_PREVIEW_ROWS);
    const colCount = Math.min(Math.max(maxCol + 1, 1), MAX_PREVIEW_COLS);
    const truncated = maxRow + 1 > MAX_PREVIEW_ROWS || maxCol + 1 > MAX_PREVIEW_COLS;

    const mergeStart = new Map<string, { rowSpan: number; colSpan: number }>();
    const covered = new Set<string>();
    for (const merge of merges) {
      if (merge.startRow >= rowCount || merge.startColumn >= colCount) continue;
      const endRow = Math.min(merge.endRow, rowCount - 1);
      const endCol = Math.min(merge.endColumn, colCount - 1);
      mergeStart.set(`${merge.startRow}:${merge.startColumn}`, {
        rowSpan: endRow - merge.startRow + 1,
        colSpan: endCol - merge.startColumn + 1,
      });
      for (let r = merge.startRow; r <= endRow; r += 1) {
        for (let c = merge.startColumn; c <= endCol; c += 1) {
          if (r === merge.startRow && c === merge.startColumn) continue;
          covered.add(`${r}:${c}`);
        }
      }
    }

    return { cellData, rowCount, colCount, truncated, mergeStart, covered };
  }, [current]);

  async function handleExportXlsx() {
    if (!workbook || exporting) return;
    setExporting(true);
    try {
      const { writeXlsxWorkbook, XLSX_MIME } = await import("@/lib/excelWorkbookFile");
      const bytes = await writeXlsxWorkbook(workbook);
      const blob = new Blob([bytes], { type: XLSX_MIME });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(title || workbook.name || "workbook").replace(/[\\/:*?"<>|]+/g, "_")}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "XLSX 导出失败");
    } finally {
      setExporting(false);
    }
  }

  if (!workbook || !current || !grid) {
    return (
      <div className="rounded-xl border border-app-border bg-app-surface p-6 text-sm text-tx-secondary">
        无法解析该 Excel 工作簿快照。
      </div>
    );
  }

  const rows = Array.from({ length: grid.rowCount }, (_, i) => i);
  const cols = Array.from({ length: grid.colCount }, (_, i) => i);

  return (
    <div className="space-y-3" data-excel-workbook-preview>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {sheetList.map((item) => {
            const selected = item.id === current.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveId(item.id)}
                className={
                  selected
                    ? "rounded-lg bg-accent-primary px-3 py-1 text-xs font-medium text-white"
                    : "rounded-lg border border-app-border bg-app-surface px-3 py-1 text-xs text-tx-secondary hover:text-tx-primary"
                }
              >
                {item.sheet.name || item.id}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={exporting}
          onClick={() => void handleExportXlsx()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-3 py-1 text-xs text-tx-secondary hover:text-tx-primary disabled:opacity-50"
        >
          <Download size={13} />
          {exporting ? "导出中…" : "导出 XLSX"}
        </button>
      </div>

      <div className="max-w-full overflow-auto rounded-xl border border-app-border bg-app-surface">
        <table className="min-w-max border-collapse text-xs">
          <thead className="sticky top-0 z-[1] bg-app-sidebar">
            <tr>
              <th className="w-10 border-b border-r border-app-border px-2 py-2 text-center font-medium text-tx-tertiary">#</th>
              {cols.map((c) => (
                <th
                  key={c}
                  className="min-w-[88px] border-b border-r border-app-border px-3 py-2 text-left font-semibold text-tx-secondary"
                >
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <th className="border-b border-r border-app-border bg-app-sidebar px-2 py-1.5 text-center font-normal text-tx-tertiary">
                  {r + 1}
                </th>
                {cols.map((c) => {
                  const key = `${r}:${c}`;
                  if (grid.covered.has(key)) return null;
                  const span = grid.mergeStart.get(key);
                  const text = cellDisplayText(grid.cellData[String(r)]?.[String(c)]);
                  return (
                    <td
                      key={c}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      className="max-w-[320px] whitespace-pre-wrap break-words border-b border-r border-app-border px-3 py-1.5 align-top text-tx-primary"
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {grid.truncated ? (
        <p className="text-xs text-tx-tertiary">
          为保证浏览流畅，仅预览前 {MAX_PREVIEW_ROWS} 行、{MAX_PREVIEW_COLS} 列；点击上方「导出 XLSX」可获取完整工作簿。
        </p>
      ) : null}
    </div>
  );
}
