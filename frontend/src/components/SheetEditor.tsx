import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Columns3,
  Loader2,
  Minus,
  Plus,
  Rows3,
  Save,
  Table2,
  Trash2,
  X,
} from "lucide-react";

import { getSheet, saveSheet } from "@/lib/sheetApi";
import {
  addSheetColumn,
  addSheetRow,
  deleteSheetColumn,
  deleteSheetRow,
  resizeSheetColumn,
  resizeSheetRow,
  setSheetCell,
  sheetCellKey,
  sortSheetRows,
  type SheetDataModel,
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
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "conflict" | "error">("saved");
  const revisionRef = useRef(0);
  const updatedAtRef = useRef("");
  const dataRef = useRef<SheetDataModel | null>(null);

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
      </div>

      <div className="min-h-0 flex-1 overflow-auto" data-swipe-blocker="sheet-grid">
        <table className="border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 h-8 min-w-12 border-b border-r border-app-border bg-app-sidebar text-xs font-medium text-tx-tertiary">#</th>
              {data.columns.map((column) => (
                <th key={column.id} style={{ width: column.width, minWidth: column.width, maxWidth: column.width }} className="h-8 border-b border-r border-app-border bg-app-sidebar px-2 text-left text-xs font-medium text-tx-secondary">
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => (
              <tr key={row.id} style={{ height: row.height }}>
                <th className="sticky left-0 z-10 min-w-12 border-b border-r border-app-border bg-app-sidebar text-xs font-normal text-tx-tertiary">{rowIndex + 1}</th>
                {data.columns.map((column) => {
                  const selected = selection?.rowId === row.id && selection.columnId === column.id;
                  return (
                    <td key={column.id} style={{ width: column.width, minWidth: column.width, maxWidth: column.width }} className={cn("border-b border-r border-app-border bg-app-bg p-0", selected && "ring-2 ring-inset ring-accent-primary")}>
                      <input
                        value={data.cells[sheetCellKey(row.id, column.id)] || ""}
                        readOnly={!canEdit}
                        onFocus={() => setSelection({ rowId: row.id, columnId: column.id })}
                        onChange={(event) => mutate(current => setSheetCell(current, row.id, column.id, event.target.value))}
                        className="h-full w-full bg-transparent px-2 outline-none text-tx-primary"
                        aria-label={`第 ${rowIndex + 1} 行 ${column.title} 列`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        .sheet-tool { display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-secondary); }
        .sheet-tool:hover:not(:disabled) { background:var(--app-hover);color:var(--text-primary); }
        .sheet-tool:disabled { opacity:.35;cursor:not-allowed; }
      `}</style>
    </section>
  );
}
