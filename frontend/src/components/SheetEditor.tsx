import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Columns3,
  Download,
  Filter,
  GripVertical,
  Loader2,
  Minus,
  Plus,
  Rows3,
  Save,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { getSheet, saveSheet } from "@/lib/sheetApi";
import { createSheetXlsx, parseSheetXlsx, XLSX_MIME } from "@/lib/sheetXlsx";
import {
  addSheetColumn,
  addSheetRow,
  deleteSheetColumn,
  deleteSheetRow,
  filterSheetRows,
  moveSheetColumn,
  moveSheetRow,
  resizeSheetColumn,
  resizeSheetRow,
  setSheetCell,
  setSheetColumnAlignment,
  setSheetColumnType,
  sheetCellKey,
  sheetFromCsv,
  sheetToCsv,
  sortSheetRows,
  type SheetCellType,
  type SheetDataModel,
  type SheetTextAlign,
} from "@/lib/sheetModel";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface SheetEditorProps {
  noteId: string;
  onRequestClose?: () => void;
}

type Selection = { rowId: string; columnId: string } | null;

export default function SheetEditor({ noteId, onRequestClose }: SheetEditorProps) {
  const [title, setTitle] = useState("轻量表格");
  const [data, setData] = useState<SheetDataModel | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dragColumnId, setDragColumnId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "conflict" | "error">("saved");
  const revisionRef = useRef(0);
  const updatedAtRef = useRef("");
  const dataRef = useRef<SheetDataModel | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { updatedAtRef.current = updatedAt; }, [updatedAt]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sheet = await getSheet(noteId);
      setTitle(sheet.title);
      setData(sheet.data);
      dataRef.current = sheet.data;
      setCanEdit(sheet.canEdit);
      setUpdatedAt(sheet.updatedAt);
      updatedAtRef.current = sheet.updatedAt;
      setSaveState("saved");
      setFilterQuery("");
      setSelection(sheet.data.rows[0] && sheet.data.columns[0]
        ? { rowId: sheet.data.rows[0].id, columnId: sheet.data.columns[0].id }
        : null);
    } catch (error: any) {
      toast.error(error?.message || "表格加载失败");
      setSaveState("error");
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => { void load(); }, [load]);

  const mutate = useCallback((recipe: (current: SheetDataModel) => SheetDataModel) => {
    if (!canEdit) return;
    setData((current) => {
      if (!current) return current;
      revisionRef.current += 1;
      setSaveState("dirty");
      return recipe(current);
    });
  }, [canEdit]);

  useEffect(() => {
    if (!canEdit || !data || saveState !== "dirty") return;
    const timer = window.setTimeout(async () => {
      const snapshot = dataRef.current;
      if (!snapshot) return;
      const revision = revisionRef.current;
      setSaveState("saving");
      try {
        const result = await saveSheet(noteId, snapshot, updatedAtRef.current);
        setUpdatedAt(result.updatedAt);
        updatedAtRef.current = result.updatedAt;
        if (revisionRef.current === revision) setSaveState("saved");
        else setSaveState("dirty");
      } catch (error: any) {
        if (error?.code === "SHEET_CONFLICT") {
          setSaveState("conflict");
          toast.error("表格已在其他窗口更新，请重新加载后继续编辑");
        } else {
          setSaveState("error");
          toast.error(error?.message || "表格保存失败");
        }
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [canEdit, data, noteId, saveState]);

  const selectedRow = useMemo(
    () => selection && data?.rows.find((row) => row.id === selection.rowId),
    [data?.rows, selection],
  );
  const selectedColumn = useMemo(
    () => selection && data?.columns.find((column) => column.id === selection.columnId),
    [data?.columns, selection],
  );
  const visibleRows = useMemo(
    () => data ? filterSheetRows(data, selectedColumn?.id || null, filterQuery) : [],
    [data, filterQuery, selectedColumn?.id],
  );

  const addRow = () => mutate((current) => {
    const next = addSheetRow(current);
    const row = next.rows[next.rows.length - 1];
    if (row && next.columns[0]) setSelection({ rowId: row.id, columnId: next.columns[0].id });
    return next;
  });
  const addColumn = () => mutate((current) => {
    const next = addSheetColumn(current);
    const column = next.columns[next.columns.length - 1];
    if (column && next.rows[0]) setSelection({ rowId: next.rows[0].id, columnId: column.id });
    return next;
  });

  const exportCsv = useCallback(() => {
    if (!data) return;
    const blob = new Blob([`\uFEFF${sheetToCsv(data)}`], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${(title || "轻量表格").replace(/[\\/:*?"<>|]+/g, "_")}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
  }, [data, title]);

  const exportXlsx = useCallback(async () => {
    if (!data) return;
    try {
      const buffer = await createSheetXlsx(data, title || "轻量表格");
      const href = URL.createObjectURL(new Blob([buffer], { type: XLSX_MIME }));
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${(title || "轻量表格").replace(/[\\/:*?"<>|]+/g, "_")}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error: any) {
      toast.error(error?.message || "XLSX 导出失败");
    }
  }, [data, title]);

  const importXlsx = useCallback(async (file: File | undefined) => {
    if (!file || !canEdit) return;
    try {
      const imported = await parseSheetXlsx(file);
      mutate(() => imported);
      setFilterQuery("");
      setSelection(imported.rows[0] && imported.columns[0]
        ? { rowId: imported.rows[0].id, columnId: imported.columns[0].id }
        : null);
      toast.success(`已导入 XLSX：${imported.rows.length} 行 × ${imported.columns.length} 列`);
    } catch (error: any) {
      toast.error(error?.message || "XLSX 导入失败");
    } finally {
      if (xlsxInputRef.current) xlsxInputRef.current.value = "";
    }
  }, [canEdit, mutate]);

  const importCsv = useCallback(async (file: File | undefined) => {
    if (!file || !canEdit) return;
    try {
      const imported = sheetFromCsv(await file.text());
      mutate(() => imported);
      setFilterQuery("");
      setSelection(imported.rows[0] && imported.columns[0]
        ? { rowId: imported.rows[0].id, columnId: imported.columns[0].id }
        : null);
      toast.success(`已导入 ${imported.rows.length} 行 × ${imported.columns.length} 列`);
    } catch (error: any) {
      toast.error(error?.message || "CSV 导入失败");
    } finally {
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }, [canEdit, mutate]);

  const statusLabel = saveState === "saving"
    ? "保存中…"
    : saveState === "dirty"
      ? "待保存"
      : saveState === "conflict"
        ? "有冲突"
        : saveState === "error"
          ? "保存失败"
          : "已保存";

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-tx-tertiary"><Loader2 className="mr-2 animate-spin" size={18} />加载表格…</div>;
  }
  if (!data) {
    return <div className="flex flex-1 flex-col items-center justify-center gap-3 text-tx-secondary"><Table2 size={28} /><span>无法打开表格</span><button className="rounded-md border border-app-border px-3 py-1.5 text-sm" onClick={() => void load()}>重新加载</button></div>;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-app-bg" data-sheet-editor>
      <header className="flex min-h-12 items-center gap-2 border-b border-app-border px-3">
        <Table2 size={18} className="shrink-0 text-sky-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">{title}</div>
        <span className={cn("text-xs", saveState === "conflict" || saveState === "error" ? "text-red-500" : "text-tx-tertiary")}>
          {saveState === "saving" ? <Loader2 size={13} className="inline animate-spin" /> : <Save size={13} className="inline" />} {statusLabel}
        </span>
        {(saveState === "conflict" || saveState === "error") && (
          <button className="rounded-md border border-app-border px-2 py-1 text-xs text-tx-secondary hover:bg-app-hover" onClick={() => void load()}>重新加载</button>
        )}
        {onRequestClose && <button className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" onClick={onRequestClose} aria-label="关闭表格"><X size={17} /></button>}
      </header>

      <div className="flex flex-wrap items-center gap-1 border-b border-app-border bg-app-surface px-2 py-1.5">
        <button disabled={!canEdit} className="sheet-tool" onClick={addRow}><Rows3 size={14} />新增行</button>
        <button disabled={!canEdit} className="sheet-tool" onClick={addColumn}><Columns3 size={14} />新增列</button>
        <span className="mx-1 h-5 w-px bg-app-border" />
        <button disabled={!canEdit || !selection || data.rows.length <= 1} className="sheet-tool" onClick={() => selection && mutate(d => deleteSheetRow(d, selection.rowId))}><Trash2 size={14} />删行</button>
        <button disabled={!canEdit || !selection || data.columns.length <= 1} className="sheet-tool" onClick={() => selection && mutate(d => deleteSheetColumn(d, selection.columnId))}><Trash2 size={14} />删列</button>
        <span className="mx-1 h-5 w-px bg-app-border" />
        <button disabled={!canEdit || !selectedColumn} className="sheet-tool" onClick={() => selectedColumn && mutate(d => resizeSheetColumn(d, selectedColumn.id, selectedColumn.width - 16))}><Minus size={14} />列宽</button>
        <button disabled={!canEdit || !selectedColumn} className="sheet-tool" onClick={() => selectedColumn && mutate(d => resizeSheetColumn(d, selectedColumn.id, selectedColumn.width + 16))}><Plus size={14} />列宽</button>
        <button disabled={!canEdit || !selectedRow} className="sheet-tool" onClick={() => selectedRow && mutate(d => resizeSheetRow(d, selectedRow.id, selectedRow.height - 4))}><Minus size={14} />行高</button>
        <button disabled={!canEdit || !selectedRow} className="sheet-tool" onClick={() => selectedRow && mutate(d => resizeSheetRow(d, selectedRow.id, selectedRow.height + 4))}><Plus size={14} />行高</button>
        <span className="mx-1 h-5 w-px bg-app-border" />
        <button disabled={!canEdit || !selectedColumn} className="sheet-tool" onClick={() => selectedColumn && mutate(d => sortSheetRows(d, selectedColumn.id, "asc"))}><ArrowUpAZ size={14} />升序</button>
        <button disabled={!canEdit || !selectedColumn} className="sheet-tool" onClick={() => selectedColumn && mutate(d => sortSheetRows(d, selectedColumn.id, "desc"))}><ArrowDownAZ size={14} />降序</button>

        <select
          className="sheet-select"
          disabled={!canEdit || !selectedColumn}
          value={selectedColumn?.type || "text"}
          aria-label="列数据类型"
          onChange={(event) => selectedColumn && mutate(d => setSheetColumnType(d, selectedColumn.id, event.target.value as SheetCellType))}
        >
          <option value="text">文本</option>
          <option value="number">数字</option>
          <option value="date">日期</option>
        </select>
        <select
          className="sheet-select"
          disabled={!canEdit || !selectedColumn}
          value={selectedColumn?.align || "left"}
          aria-label="列对齐方式"
          onChange={(event) => selectedColumn && mutate(d => setSheetColumnAlignment(d, selectedColumn.id, event.target.value as SheetTextAlign))}
        >
          <option value="left">左对齐</option>
          <option value="center">居中</option>
          <option value="right">右对齐</option>
        </select>

        <label className="sheet-filter">
          <Filter size={13} />
          <input
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            disabled={!selectedColumn}
            placeholder={selectedColumn ? `筛选 ${selectedColumn.title}` : "选择列后筛选"}
            aria-label="筛选当前列"
          />
          {filterQuery && <button type="button" onClick={() => setFilterQuery("")} aria-label="清除筛选"><X size={12} /></button>}
        </label>

        <span className="ml-auto flex items-center gap-1">
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(event) => void importCsv(event.target.files?.[0])}
          />
          <input
            ref={xlsxInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => void importXlsx(event.target.files?.[0])}
          />
          <button disabled={!canEdit} className="sheet-tool" onClick={() => csvInputRef.current?.click()}><Upload size={14} />导入 CSV</button>
          <button disabled={!canEdit} className="sheet-tool" onClick={() => xlsxInputRef.current?.click()}><Upload size={14} />导入 XLSX</button>
          <button className="sheet-tool" onClick={exportCsv}><Download size={14} />导出 CSV</button>
          <button className="sheet-tool" onClick={() => void exportXlsx()}><Download size={14} />导出 XLSX</button>
        </span>
      </div>

      {filterQuery && (
        <div className="border-b border-app-border bg-app-surface/60 px-3 py-1 text-[11px] text-tx-tertiary">
          已筛选：{visibleRows.length} / {data.rows.length} 行
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto" data-swipe-blocker="sheet-grid">
        <table className="border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 h-8 min-w-12 border-b border-r border-app-border bg-app-sidebar text-xs font-medium text-tx-tertiary">#</th>
              {data.columns.map((column) => (
                <th
                  key={column.id}
                  draggable={canEdit}
                  onDragStart={(event) => {
                    setDragColumnId(column.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-nowen-sheet-column", column.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragColumnId || dragColumnId === column.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = event.dataTransfer.getData("application/x-nowen-sheet-column") || dragColumnId;
                    if (sourceId && sourceId !== column.id) {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const placement = event.clientX >= rect.left + rect.width / 2 ? "after" : "before";
                      mutate(d => moveSheetColumn(d, sourceId, column.id, placement));
                    }
                    setDragColumnId(null);
                  }}
                  onDragEnd={() => setDragColumnId(null)}
                  style={{ width: column.width, minWidth: column.width, maxWidth: column.width }}
                  className={cn(
                    "h-8 border-b border-r border-app-border bg-app-sidebar px-2 text-xs font-medium text-tx-secondary",
                    canEdit && "cursor-grab active:cursor-grabbing",
                    dragColumnId === column.id && "opacity-50",
                  )}
                  title="拖拽调整列顺序"
                >
                  <span className="flex items-center gap-1.5">
                    {canEdit && <GripVertical size={12} className="shrink-0 text-tx-tertiary" />}
                    <span className="truncate">{column.title}</span>
                    <span className="ml-auto text-[9px] font-normal text-tx-tertiary">
                      {column.type === "number" ? "数字" : column.type === "date" ? "日期" : ""}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const sourceIndex = data.rows.findIndex((candidate) => candidate.id === row.id);
              return (
                <tr key={row.id} style={{ height: row.height }}>
                  <th
                    draggable={canEdit}
                    onDragStart={(event) => {
                      setDragRowId(row.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-nowen-sheet-row", row.id);
                    }}
                    onDragOver={(event) => {
                      if (!dragRowId || dragRowId === row.id || filterQuery) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (filterQuery) return;
                      const sourceId = event.dataTransfer.getData("application/x-nowen-sheet-row") || dragRowId;
                      if (sourceId && sourceId !== row.id) {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const placement = event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
                        mutate(d => moveSheetRow(d, sourceId, row.id, placement));
                      }
                      setDragRowId(null);
                    }}
                    onDragEnd={() => setDragRowId(null)}
                    className={cn(
                      "sticky left-0 z-10 min-w-12 border-b border-r border-app-border bg-app-sidebar text-xs font-normal text-tx-tertiary",
                      canEdit && !filterQuery && "cursor-grab active:cursor-grabbing",
                      dragRowId === row.id && "opacity-50",
                    )}
                    title={filterQuery ? "筛选状态下暂不支持拖动行" : "拖拽调整行顺序"}
                  >
                    <span className="flex items-center justify-center gap-0.5">
                      {canEdit && !filterQuery && <GripVertical size={11} />}
                      {sourceIndex + 1}
                    </span>
                  </th>
                  {data.columns.map((column) => {
                    const selected = selection?.rowId === row.id && selection.columnId === column.id;
                    return (
                      <td key={column.id} style={{ width: column.width, minWidth: column.width, maxWidth: column.width }} className={cn("border-b border-r border-app-border bg-app-bg p-0", selected && "ring-2 ring-inset ring-accent-primary")}>
                        <input
                          type={column.type === "date" ? "date" : "text"}
                          inputMode={column.type === "number" ? "decimal" : undefined}
                          value={data.cells[sheetCellKey(row.id, column.id)] || ""}
                          readOnly={!canEdit}
                          onFocus={() => setSelection({ rowId: row.id, columnId: column.id })}
                          onChange={(event) => mutate(current => setSheetCell(current, row.id, column.id, event.target.value))}
                          className="h-full w-full bg-transparent px-2 outline-none text-tx-primary"
                          style={{ textAlign: column.align }}
                          aria-label={`第 ${sourceIndex + 1} 行 ${column.title} 列`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <style>{`
        .sheet-tool { display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-secondary); }
        .sheet-tool:hover:not(:disabled) { background:var(--app-hover);color:var(--text-primary); }
        .sheet-tool:disabled { opacity:.35;cursor:not-allowed; }
        .sheet-select { min-height:28px;border:1px solid var(--app-border);border-radius:6px;background:var(--app-bg);padding:3px 6px;font-size:12px;color:var(--text-secondary);outline:none; }
        .sheet-select:disabled { opacity:.4; }
        .sheet-filter { display:flex;min-height:28px;min-width:180px;align-items:center;gap:5px;border:1px solid var(--app-border);border-radius:6px;background:var(--app-bg);padding:0 7px;color:var(--text-tertiary); }
        .sheet-filter input { min-width:0;flex:1;background:transparent;font-size:12px;color:var(--text-primary);outline:none; }
        .sheet-filter button { display:flex;align-items:center;justify-content:center;border-radius:4px;padding:2px; }
        .sheet-filter button:hover { background:var(--app-hover);color:var(--text-primary); }
      `}</style>
    </section>
  );
}
