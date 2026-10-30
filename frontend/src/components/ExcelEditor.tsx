import React, { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Save, Upload, X } from "lucide-react";

import { getExcelDocument, saveExcelDocument } from "@/lib/excelApi";
import {
  csvToWorkbookSnapshot,
  createEmptyWorkbookSnapshot,
  workbookSnapshotToCsv,
  workbookSnapshotToXlsx,
  xlsxToWorkbookSnapshot,
  XLSX_FILE_MIME,
} from "@/lib/excelExchange";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface ExcelEditorProps {
  noteId: string;
  onRequestClose?: () => void;
}

interface UniverWorkbook {
  getId: () => string;
  save: () => Record<string, unknown>;
  onCommandExecuted: (listener: () => void) => { dispose: () => void };
}

interface UniverInstance {
  univer: { dispose: () => void };
  univerAPI: {
    createWorkbook: (data: unknown) => UniverWorkbook | null;
    getActiveWorkbook: () => UniverWorkbook | null;
    disposeUnit: (unitId: string) => boolean;
  };
}

let univerModulesPromise: Promise<typeof import("@univerjs/presets") & Record<string, unknown>> | null = null;

/** Univer 体积大，打开 Excel 表格时才动态加载（含样式与中文语言包）。 */
async function loadUniverModules() {
  if (!univerModulesPromise) {
    univerModulesPromise = (async () => {
      const [presets, sheetsPreset, zhCN] = await Promise.all([
        import("@univerjs/presets"),
        import("@univerjs/preset-sheets-core"),
        import("@univerjs/preset-sheets-core/locales/zh-CN"),
        import("@univerjs/preset-sheets-core/lib/index.css"),
      ]);
      // 注意：不能 Object.assign 到 ESM 命名空间对象上（只读，dev 模式会抛错），
      // 返回普通合并对象即可。
      return { ...presets, UniverSheetsCorePreset: sheetsPreset.UniverSheetsCorePreset, zhCN: zhCN.default };
    })() as never;
  }
  return univerModulesPromise as Promise<typeof import("@univerjs/presets") & { UniverSheetsCorePreset: (typeof import("@univerjs/preset-sheets-core"))["UniverSheetsCorePreset"]; zhCN: unknown }>;
}

export default function ExcelEditor({ noteId, onRequestClose }: ExcelEditorProps) {
  const [title, setTitle] = useState("Excel 表格");
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [booting, setBooting] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "conflict" | "error">("saved");

  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<UniverInstance | null>(null);
  const commandSubscriptionRef = useRef<{ dispose: () => void } | null>(null);
  const dirtyRef = useRef(false);
  const updatedAtRef = useRef("");
  const savedJsonRef = useRef("");
  const saveTimerRef = useRef(0);
  const savingRef = useRef(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);

  const performSave = useCallback(async () => {
    const instance = univerRef.current;
    if (!instance || savingRef.current) return;
    const snapshot = instance.univerAPI.getActiveWorkbook()?.save();
    if (!snapshot) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === savedJsonRef.current) {
      setSaveState((state) => (state === "dirty" ? "saved" : state));
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    try {
      const result = await saveExcelDocument(noteId, snapshot, updatedAtRef.current);
      updatedAtRef.current = result.updatedAt;
      savedJsonRef.current = JSON.stringify(result.data);
      setSaveState(dirtyRef.current ? "dirty" : "saved");
    } catch (caughtError: unknown) {
      const error = caughtError as Error & { code?: string };
      if (error?.code === "EXCEL_CONFLICT") {
        setSaveState("conflict");
        toast.error("表格已在其他窗口更新，请刷新后继续编辑");
      } else {
        setSaveState("error");
        toast.error(error?.message || "Excel 表格保存失败");
      }
    } finally {
      savingRef.current = false;
    }
  }, [noteId]);

  const markDirty = useCallback(() => {
    if (!canEdit) return;
    dirtyRef.current = true;
    setSaveState("dirty");
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      dirtyRef.current = false;
      void performSave();
    }, 500);
  }, [canEdit, performSave]);

  // 加载文档数据 + 启动 Univer。
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setLoading(true);
      setLoadError(false);
      try {
        const [document, modules] = await Promise.all([
          getExcelDocument(noteId),
          loadUniverModules(),
        ]);
        if (cancelled || !containerRef.current) return;
        setTitle(document.title);
        setCanEdit(document.canEdit);
        updatedAtRef.current = document.updatedAt;
        const { createUniver, defaultTheme, LocaleType, mergeLocales, UniverSheetsCorePreset, zhCN } = modules;
        const { univer, univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: mergeLocales({ [LocaleType.ZH_CN]: zhCN as Record<string, string> }),
          theme: defaultTheme,
          presets: [
            UniverSheetsCorePreset({ container: containerRef.current! }),
          ],
        });
        const data = document.data && Object.keys(document.data as object).length > 0
          ? document.data
          : createEmptyWorkbookSnapshot(document.title);
        const fWorkbook = univerAPI.createWorkbook(data);
        savedJsonRef.current = JSON.stringify(fWorkbook?.save() || {});
        univerRef.current = { univer, univerAPI } as unknown as UniverInstance;
        commandSubscriptionRef.current = fWorkbook?.onCommandExecuted(() => markDirtyRef.current()) || null;
        setBooting(false);
      } catch (caughtError: unknown) {
        if (cancelled) return;
        const error = caughtError as Error;
        toast.error(error?.message || "Excel 表格加载失败");
        setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
      commandSubscriptionRef.current?.dispose();
      commandSubscriptionRef.current = null;
      window.clearTimeout(saveTimerRef.current);
      univerRef.current?.univer.dispose();
      univerRef.current = null;
    };
  }, [noteId]);

  const markDirtyRef = useRef(markDirty);
  useEffect(() => { markDirtyRef.current = markDirty; }, [markDirty]);

  const download = useCallback((blob: Blob, suffix: string) => {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${(title || "Excel 表格").replace(/[\\/:*?"<>|]+/g, "_")}${suffix}`;
    anchor.click();
    URL.revokeObjectURL(href);
  }, [title]);

  const currentSnapshot = useCallback((): Record<string, unknown> | null => {
    return univerRef.current?.univerAPI.getActiveWorkbook()?.save() || null;
  }, []);

  const exportXlsx = useCallback(async () => {
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    try {
      const buffer = workbookSnapshotToXlsx(snapshot);
      download(new Blob([buffer], { type: XLSX_FILE_MIME }), ".xlsx");
    } catch (caughtError: unknown) {
      toast.error((caughtError as Error)?.message || "XLSX 导出失败");
    }
  }, [currentSnapshot, download]);

  const exportCsv = useCallback(() => {
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    try {
      const csv = workbookSnapshotToCsv(snapshot);
      download(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), ".csv");
    } catch (caughtError: unknown) {
      toast.error((caughtError as Error)?.message || "CSV 导出失败");
    }
  }, [currentSnapshot, download]);

  const replaceWorkbook = useCallback((next: Record<string, unknown>) => {
    const instance = univerRef.current;
    if (!instance) return;
    const unitId = instance.univerAPI.getActiveWorkbook()?.getId();
    if (unitId) instance.univerAPI.disposeUnit(unitId);
    const fWorkbook = instance.univerAPI.createWorkbook(next);
    savedJsonRef.current = JSON.stringify(fWorkbook?.save() || {});
    commandSubscriptionRef.current?.dispose();
    commandSubscriptionRef.current = fWorkbook?.onCommandExecuted(() => markDirtyRef.current()) || null;
    markDirty();
  }, [markDirty]);

  const importXlsx = useCallback(async (file: File | undefined) => {
    if (!file || !canEdit) return;
    try {
      const buffer = await file.arrayBuffer();
      const snapshot = xlsxToWorkbookSnapshot(buffer, title);
      replaceWorkbook(snapshot);
      toast.success(`已导入 ${file.name}`);
    } catch (caughtError: unknown) {
      toast.error((caughtError as Error)?.message || "XLSX 导入失败");
    } finally {
      if (xlsxInputRef.current) xlsxInputRef.current.value = "";
    }
  }, [canEdit, replaceWorkbook, title]);

  const importCsv = useCallback(async (file: File | undefined) => {
    if (!file || !canEdit) return;
    try {
      const snapshot = csvToWorkbookSnapshot(await file.text(), title);
      replaceWorkbook(snapshot);
      toast.success(`已导入 ${file.name}`);
    } catch (caughtError: unknown) {
      toast.error((caughtError as Error)?.message || "CSV 导入失败");
    } finally {
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }, [canEdit, replaceWorkbook, title]);

  const statusLabel = saveState === "saving"
    ? "保存中…"
    : saveState === "dirty"
      ? "待保存"
      : saveState === "conflict"
        ? "有冲突"
        : saveState === "error"
          ? "保存失败"
          : "已保存";

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-app-bg" data-excel-editor>
      <header className="flex min-h-12 items-center gap-2 border-b border-app-border px-3">
        <FileSpreadsheet size={18} className="shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">{title}</div>
        <span className={cn("text-xs", saveState === "conflict" || saveState === "error" ? "text-red-500" : "text-tx-tertiary")}>
          {saveState === "saving" ? <Loader2 size={13} className="inline animate-spin" /> : <Save size={13} className="inline" />} {statusLabel}
        </span>
        {(saveState === "conflict" || saveState === "error") && (
          <button
            className="rounded-md border border-app-border px-2 py-1 text-xs text-tx-secondary hover:bg-app-hover"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        )}
        {onRequestClose && (
          <button className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" onClick={onRequestClose} aria-label="关闭表格">
            <X size={17} />
          </button>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-1 border-b border-app-border bg-app-surface px-2 py-1.5">
        <input
          ref={xlsxInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(event) => void importXlsx(event.target.files?.[0])}
        />
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => void importCsv(event.target.files?.[0])}
        />
        <button disabled={!canEdit} className="excel-tool" onClick={() => xlsxInputRef.current?.click()}><Upload size={14} />导入 XLSX</button>
        <button disabled={!canEdit} className="excel-tool" onClick={() => csvInputRef.current?.click()}><Upload size={14} />导入 CSV</button>
        <span className="mx-1 h-5 w-px bg-app-border" />
        <button className="excel-tool" onClick={() => void exportXlsx()}><Download size={14} />导出 XLSX</button>
        <button className="excel-tool" onClick={exportCsv}><Download size={14} />导出 CSV</button>
        <span className="ml-auto text-[11px] text-tx-tertiary">公式 · 合并单元格 · 填充柄 · 回车跳格</span>
      </div>

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-app-bg text-tx-tertiary">
            <Loader2 className="mr-2 animate-spin" size={18} />加载 Excel 表格…
          </div>
        )}
        {loadError && !loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-tx-secondary">
            <FileSpreadsheet size={28} />
            <span>无法打开 Excel 表格</span>
            <button className="rounded-md border border-app-border px-3 py-1.5 text-sm" onClick={() => window.location.reload()}>重新加载</button>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" style={{ display: booting ? "none" : "block" }} />
      </div>
      <style>{`
        .excel-tool { display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-secondary); }
        .excel-tool:hover:not(:disabled) { background:var(--app-hover);color:var(--text-primary); }
        .excel-tool:disabled { opacity:.35;cursor:not-allowed; }
      `}</style>
    </section>
  );
}
