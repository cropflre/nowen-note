/**
 * Excel 表格编辑器（Univer）。功能来源：cropflre/nowen-note PR #802。
 *
 * 本组件由 App 以 React.lazy 按需加载；Univer 与 XLSX/CSV 转换模块也只在打开表格 / 导入导出时加载。
 * 保存可靠性由 ExcelSaveController 负责：只有服务端返回新 revision 才显示“已保存”。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileSpreadsheet, Loader2, RefreshCw, Save, Upload, X } from "lucide-react";

import { confirm } from "@/components/ui/confirm";
import { getExcelDocument, saveExcelDocument } from "@/lib/excelApi";
import {
  ExcelSaveController,
  hasPendingExcelSaves,
  keepPendingExcelSave,
  takePendingExcelSave,
  type ExcelSaveState,
  type ExcelSnapshot,
} from "@/lib/excelSaveController";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface ExcelEditorProps {
  noteId: string;
  onRequestClose?: () => void;
}

type UniverModules = Awaited<ReturnType<typeof loadUniverModules>>;
type UniverAPI = ReturnType<UniverModules["createUniver"]>["univerAPI"];

let univerModules: Promise<{
  createUniver: typeof import("@univerjs/presets")["createUniver"];
  LocaleType: typeof import("@univerjs/presets")["LocaleType"];
  mergeLocales: typeof import("@univerjs/presets")["mergeLocales"];
  defaultTheme: typeof import("@univerjs/presets")["defaultTheme"];
  UniverSheetsCorePreset: typeof import("@univerjs/preset-sheets-core")["UniverSheetsCorePreset"];
  zhCN: Record<string, unknown>;
}> | null = null;

function loadUniverModules() {
  if (!univerModules) {
    univerModules = Promise.all([
      import("@univerjs/presets"),
      import("@univerjs/preset-sheets-core"),
      import("@univerjs/preset-sheets-core/locales/zh-CN"),
      import("@univerjs/preset-sheets-core/lib/index.css"),
    ]).then(([presets, sheets, zhCN]) => ({
      createUniver: presets.createUniver,
      LocaleType: presets.LocaleType,
      mergeLocales: presets.mergeLocales,
      defaultTheme: presets.defaultTheme,
      UniverSheetsCorePreset: sheets.UniverSheetsCorePreset,
      zhCN: zhCN.default as Record<string, unknown>,
    })).catch((error) => {
      univerModules = null;
      throw error;
    });
  }
  return univerModules;
}

const loadFileModule = () => import("@/lib/excelWorkbookFile");

const MUTATION = 2;

const STATUS_LABEL: Record<ExcelSaveState["status"], string> = {
  saved: "已保存",
  dirty: "待保存",
  saving: "保存中…",
  retrying: "保存失败，正在重试",
  conflict: "有冲突",
  failed: "未保存",
};

function safeFileName(title: string): string {
  return (title || "Excel 表格").replace(/[\\/:*?"<>|]+/g, "_");
}

function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function warningList(items: string[]): string {
  return items.map((item) => `· ${item}`).join("\n");
}

export default function ExcelEditor({ noteId, onRequestClose }: ExcelEditorProps) {
  const [title, setTitle] = useState("Excel 表格");
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoredLocal, setRestoredLocal] = useState(false);
  const [saveState, setSaveState] = useState<ExcelSaveState>({ status: "saved", revision: 0, attempt: 0 });
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<UniverAPI | null>(null);
  const controllerRef = useRef<ExcelSaveController | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);

  const snapshot = useCallback((): ExcelSnapshot | null => {
    const workbook = apiRef.current?.getActiveWorkbook();
    return workbook ? (workbook.save() as unknown as ExcelSnapshot) : null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;

    async function boot() {
      setLoading(true);
      setLoadError(null);
      setRestoredLocal(false);
      try {
        const pending = takePendingExcelSave(noteId);
        const [document, modules] = await Promise.all([getExcelDocument(noteId), loadUniverModules()]);
        if (cancelled || !containerRef.current) {
          if (pending) keepPendingExcelSave(pending);
          return;
        }
        setTitle(document.title);
        setCanEdit(document.canEdit);
        const { createUniver, LocaleType, mergeLocales, defaultTheme, UniverSheetsCorePreset, zhCN } = modules;
        const { univer, univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: mergeLocales({ [LocaleType.ZH_CN]: zhCN }) as never,
          theme: defaultTheme,
          darkMode: window.document.documentElement.classList.contains("dark"),
          presets: [UniverSheetsCorePreset({ container: containerRef.current })],
        });
        // 有尚未确认的本机版本时优先展示它，绝不用服务器旧版本覆盖。
        const initial = pending?.frozenSnapshot && pending.hasUnsavedChanges ? pending.frozenSnapshot : document.data;
        const workbook = univerAPI.createWorkbook(initial as never);
        apiRef.current = univerAPI;
        if (!document.canEdit) await workbook.getWorkbookPermission().setReadOnly();

        let controller: ExcelSaveController;
        if (pending && pending.hasUnsavedChanges) {
          controller = pending;
          controller.setCallbacks(snapshot, setSaveState);
          setRestoredLocal(true);
          void controller.retryNow();
        } else {
          pending?.dispose();
          controller = new ExcelSaveController({
            noteId,
            revision: document.revision,
            save: (data, expected) => saveExcelDocument(noteId, data, expected),
            readSnapshot: snapshot,
            onChange: setSaveState,
          });
          setSaveState(controller.state);
        }
        controllerRef.current = controller;

        const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
          const params = event.params as { unitId?: string } | undefined;
          if (event.type !== MUTATION || (event.options as { onlyLocal?: boolean } | undefined)?.onlyLocal) return;
          if (params?.unitId && params.unitId !== univerAPI.getActiveWorkbook()?.getId()) return;
          if (document.canEdit) controller.markDirty();
        });

        dispose = () => {
          subscription.dispose();
          // 先冻结快照，保存在编辑器销毁后继续，直到服务端确认或用户重新打开接回。
          controller.freeze(snapshot());
          keepPendingExcelSave(controller);
          controllerRef.current = null;
          apiRef.current = null;
          univer.dispose();
        };
        if (cancelled) dispose();
      } catch (caught) {
        if (cancelled) return;
        const error = caught as Error & { status?: number };
        setLoadError(error.status === 403 ? "没有查看该表格的权限" : error.message || "Excel 表格加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [noteId, reloadKey, snapshot]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controllerRef.current?.hasUnsavedChanges || hasPendingExcelSaves()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const replaceWorkbook = useCallback(async (next: ExcelSnapshot) => {
    const univerAPI = apiRef.current;
    const controller = controllerRef.current;
    if (!univerAPI || !controller) return;
    const current = univerAPI.getActiveWorkbook();
    if (current) univerAPI.disposeUnit(current.getId());
    univerAPI.createWorkbook(next as never);
    // 显式标记并立即保存：是否已保存只看服务端返回，不与本地快照做比较。
    controller.markDirty();
    await controller.flush();
  }, []);

  const importFile = useCallback(async (file: File | undefined, kind: "xlsx" | "csv") => {
    if (!file || !canEdit) return;
    setBusy(true);
    try {
      const files = await loadFileModule();
      const result = kind === "xlsx"
        ? await files.readXlsxWorkbook(file, title)
        : files.readCsvWorkbook(await file.text(), title);
      const ok = await confirm({
        title: `导入 ${file.name}`,
        description: (result.warnings.length
          ? `以下内容无法导入，导入后将不会保留：\n${warningList(result.warnings)}\n\n`
          : "")
          + "导入会替换当前表格的全部内容。",
        confirmText: "替换并导入",
        danger: result.warnings.length > 0,
      });
      if (!ok) return;
      await replaceWorkbook(result.workbook as unknown as ExcelSnapshot);
      toast.success(`已导入 ${file.name}`);
    } catch (caught) {
      toast.error((caught as Error)?.message || "导入失败");
    } finally {
      setBusy(false);
      if (xlsxInputRef.current) xlsxInputRef.current.value = "";
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }, [canEdit, replaceWorkbook, title]);

  const exportXlsx = useCallback(async (suffix = "") => {
    const data = snapshot();
    if (!data) return;
    try {
      const files = await loadFileModule();
      const workbook = data as unknown as Parameters<typeof files.writeXlsxWorkbook>[0];
      const warnings = files.xlsxExportWarnings(workbook);
      if (warnings.length && !await confirm({ title: "导出 XLSX", description: `以下内容不会写入文件：\n${warningList(warnings)}`, confirmText: "继续导出" })) return;
      const buffer = await files.writeXlsxWorkbook(workbook);
      download(new Blob([buffer], { type: files.XLSX_MIME }), `${safeFileName(title)}${suffix}.xlsx`);
    } catch (caught) {
      toast.error((caught as Error)?.message || "XLSX 导出失败");
    }
  }, [snapshot, title]);

  const exportCsv = useCallback(async () => {
    const data = snapshot();
    if (!data) return;
    try {
      const files = await loadFileModule();
      const activeSheet = apiRef.current?.getActiveWorkbook()?.getActiveSheet()?.getSheetId();
      const { csv, warnings } = files.writeCsvSheet(data as never, activeSheet);
      if (warnings.length && !await confirm({ title: "导出 CSV", description: warningList(warnings), confirmText: "继续导出" })) return;
      download(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `${safeFileName(title)}.csv`);
    } catch (caught) {
      toast.error((caught as Error)?.message || "CSV 导出失败");
    }
  }, [snapshot, title]);

  const loadServerVersion = useCallback(async () => {
    const ok = await confirm({
      title: "载入服务器版本",
      description: "本机尚未保存的修改将被丢弃。建议先点击“导出本机副本”保留一份。",
      confirmText: "丢弃本机修改并载入",
      danger: true,
    });
    if (!ok) return;
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.dispose();
    setReloadKey((value) => value + 1);
  }, []);

  const overwriteServer = useCallback(async () => {
    const ok = await confirm({
      title: "以本机版本覆盖",
      description: "服务器上由其他窗口或设备保存的修改将被本机内容替换。",
      confirmText: "覆盖服务器版本",
      danger: true,
    });
    if (ok) await controllerRef.current?.overwriteServer();
  }, []);

  const { status } = saveState;
  const problem = status === "conflict" || status === "failed" || status === "retrying";

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-app-bg" data-excel-editor>
      <header className="flex min-h-12 items-center gap-2 border-b border-app-border px-3">
        <FileSpreadsheet size={18} className="shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">{title}</div>
        {!loading && !loadError && (
          <span
            className={cn("flex items-center gap-1 text-xs", problem ? "text-red-500" : "text-tx-tertiary")}
            title={status === "saved" ? `服务器已确认版本 ${saveState.revision}` : saveState.message}
            data-excel-save-status={status}
          >
            {status === "saving" ? <Loader2 size={13} className="animate-spin" /> : problem ? <AlertTriangle size={13} /> : <Save size={13} />}
            {canEdit ? STATUS_LABEL[status] : "只读"}
          </span>
        )}
        {(status === "failed" || status === "retrying") && (
          <button className="excel-tool" onClick={() => void controllerRef.current?.retryNow()}><RefreshCw size={13} />重试</button>
        )}
        {onRequestClose && (
          <button className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" onClick={onRequestClose} aria-label="关闭表格">
            <X size={17} />
          </button>
        )}
      </header>

      {status === "conflict" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
          <AlertTriangle size={14} />
          <span className="mr-auto">表格已在其他窗口或设备更新，本机修改尚未保存，已暂停自动保存。</span>
          <button className="excel-tool" onClick={() => void exportXlsx("（本机副本）")}><Download size={13} />导出本机副本</button>
          <button className="excel-tool" onClick={() => void loadServerVersion()}>载入服务器版本</button>
          <button className="excel-tool" onClick={() => void overwriteServer()}>以本机版本覆盖</button>
        </div>
      )}
      {restoredLocal && status !== "saved" && (
        <div className="border-b border-app-border bg-app-surface px-3 py-1.5 text-xs text-tx-secondary">已恢复上次离开时尚未保存的修改，正在保存。</div>
      )}
      {status === "failed" && saveState.message && (
        <div className="border-b border-app-border bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:bg-red-950/40" role="alert">{saveState.message}。修改仍保留在本页，请处理后重试或导出副本。</div>
      )}

      <div className="flex flex-wrap items-center gap-1 border-b border-app-border bg-app-surface px-2 py-1.5">
        <input ref={xlsxInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden"
          onChange={(event) => void importFile(event.target.files?.[0], "xlsx")} />
        <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden"
          onChange={(event) => void importFile(event.target.files?.[0], "csv")} />
        <button disabled={!canEdit || busy || loading} className="excel-tool" onClick={() => xlsxInputRef.current?.click()}><Upload size={14} />导入 XLSX</button>
        <button disabled={!canEdit || busy || loading} className="excel-tool" onClick={() => csvInputRef.current?.click()}><Upload size={14} />导入 CSV</button>
        <span className="mx-1 h-5 w-px bg-app-border" />
        <button disabled={loading || !!loadError} className="excel-tool" onClick={() => void exportXlsx()}><Download size={14} />导出 XLSX</button>
        <button disabled={loading || !!loadError} className="excel-tool" onClick={() => void exportCsv()}><Download size={14} />导出 CSV</button>
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
            <span>{loadError}</span>
            <button className="rounded-md border border-app-border px-3 py-1.5 text-sm" onClick={() => setReloadKey((value) => value + 1)}>重新加载</button>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <style>{`
        .excel-tool { display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-secondary); }
        .excel-tool:hover:not(:disabled) { background:var(--app-hover);color:var(--text-primary); }
        .excel-tool:disabled { opacity:.35;cursor:not-allowed; }
      `}</style>
    </section>
  );
}
