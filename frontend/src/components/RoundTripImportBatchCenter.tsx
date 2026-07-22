import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  Clock3,
  FileArchive,
  FolderTree,
  History,
  Loader2,
  Paperclip,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Tags,
  Undo2,
  X,
} from "lucide-react";
import RoundTripImportReviewCenter from "./RoundTripImportReviewCenter";
import { confirm as confirmDialog } from "./ui/confirm";
import {
  getRoundTripImportBatch,
  listRoundTripImportBatches,
  openRoundTripImportHistory,
  ROUND_TRIP_IMPORT_COMPLETED_EVENT,
  ROUND_TRIP_IMPORT_HISTORY_EVENT,
  undoRoundTripImportBatch,
  type RoundTripImportBatchDetail,
  type RoundTripImportBatchSummary,
} from "@/lib/roundTripImportBatches";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try { return date.toLocaleString(); } catch { return value; }
}

function modeLabel(mode: string): string {
  if (mode === "sync") return "安全增量同步";
  if (mode === "merge") return "合并导入";
  if (mode === "into-target") return "导入到目标目录";
  return "创建独立副本";
}

function statusLabel(status: RoundTripImportBatchSummary["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "undone") return "已撤销";
  if (status === "failed") return "失败";
  return "执行中";
}

function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function HistoryButtonBridge() {
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const sync = () => {
      const title = document.getElementById("round-trip-import-review-title");
      const header = title?.closest("header");
      if (!header) {
        setMount(null);
        return;
      }
      let node = header.querySelector<HTMLElement>("[data-nowen-import-history-mount]");
      if (!node) {
        node = document.createElement("span");
        node.dataset.nowenImportHistoryMount = "true";
        node.className = "shrink-0";
        const close = header.querySelector("button[aria-label]");
        header.insertBefore(node, close || null);
      }
      setMount(node);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      const node = document.querySelector<HTMLElement>("[data-nowen-import-history-mount]");
      node?.remove();
    };
  }, []);

  if (!mount) return null;
  return createPortal(
    <button
      type="button"
      onClick={() => openRoundTripImportHistory()}
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      title="查看最近导入记录和撤销状态"
    >
      <History size={15} />
      <span className="hidden sm:inline">导入记录</span>
    </button>,
    mount,
  );
}

function BatchCenterModal({
  open,
  initialBatchId,
  onClose,
}: {
  open: boolean;
  initialBatchId?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<RoundTripImportBatchSummary[]>([]);
  const [selectedId, setSelectedId] = useState(initialBatchId || "");
  const [detail, setDetail] = useState<RoundTripImportBatchDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState("");
  const [undoConflicts, setUndoConflicts] = useState<string[]>([]);

  const refreshList = async (preferredId?: string) => {
    setLoadingList(true);
    setError("");
    try {
      const next = await listRoundTripImportBatches({ limit: 50 });
      setItems(next);
      const target = preferredId || selectedId || next[0]?.id || "";
      setSelectedId(target);
      return target;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return "";
    } finally {
      setLoadingList(false);
    }
  };

  const loadDetail = async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    setError("");
    setUndoConflicts([]);
    try {
      setDetail(await getRoundTripImportBatch(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const target = initialBatchId || selectedId;
    void refreshList(target).then((resolved) => void loadDetail(resolved));
  }, [open, initialBatchId]);

  useEffect(() => {
    if (!open || !selectedId || selectedId === detail?.id) return;
    void loadDetail(selectedId);
  }, [open, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || undoing) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, undoing]);

  const warnings = useMemo(() => {
    const result = detail?.result || {};
    const preview = detail?.preview || {};
    return Array.isArray(result.warnings) ? result.warnings : Array.isArray(preview.warnings) ? preview.warnings : [];
  }, [detail]);
  const errors = useMemo(() => {
    const result = detail?.result || {};
    const preview = detail?.preview || {};
    return Array.isArray(result.errors) ? result.errors : Array.isArray(preview.errors) ? preview.errors : [];
  }, [detail]);
  const conflicts = useMemo(() => {
    const result = detail?.result || {};
    const preview = detail?.preview || {};
    return Array.isArray(result.conflicts) ? result.conflicts : Array.isArray(preview.conflicts) ? preview.conflicts : [];
  }, [detail]);

  const handleUndo = async () => {
    if (!detail?.undo.available || undoing) return;
    const confirmed = await confirmDialog({
      title: "撤销本次导入？",
      description:
        "将删除本批次创建的目录、笔记和附件，并恢复本批次同步前的内容。\n\n" +
        "撤销前会再次校验导入后是否有新的本地修改；发现变化时会停止，不会强制覆盖。",
      confirmText: "安全撤销",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    setUndoing(true);
    setError("");
    setUndoConflicts([]);
    try {
      const next = await undoRoundTripImportBatch(detail.id);
      setDetail(next);
      await refreshList(detail.id);
    } catch (cause) {
      const typed = cause as Error & { conflicts?: string[] };
      setError(typed.message || String(cause));
      setUndoConflicts(Array.isArray(typed.conflicts) ? typed.conflicts : []);
    } finally {
      setUndoing(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  const counts = detail?.counts || {};
  const cards = [
    { label: "目录", value: numeric(counts.notebooks) + numeric(counts.updatedNotebooks), icon: FolderTree },
    { label: "笔记", value: numeric(counts.notes) + numeric(counts.updatedNotes), icon: FileArchive },
    { label: "标签", value: numeric(counts.tags), icon: Tags },
    { label: "附件", value: numeric(counts.attachments), icon: Paperclip },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[12500] flex items-end justify-center bg-black/50 backdrop-blur-[1px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="round-trip-import-history-title">
      <div className="flex max-h-[calc(100dvh-0.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:max-h-[min(92dvh,900px)] sm:rounded-2xl">
        <header className="flex items-start gap-3 border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"><History size={21} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="round-trip-import-history-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100">导入批次记录</h2>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">查看预检、执行结果、冲突和可撤销状态</p>
          </div>
          <button type="button" onClick={() => void refreshList(selectedId).then((id) => void loadDetail(id))} disabled={loadingList || undoing} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" title="刷新"><RefreshCw size={17} className={loadingList ? "animate-spin" : ""} /></button>
          <button type="button" onClick={onClose} disabled={undoing} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" aria-label="关闭导入记录"><X size={18} /></button>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="max-h-56 overflow-y-auto border-b border-zinc-200 bg-zinc-50/65 p-2 dark:border-zinc-800 dark:bg-zinc-950/30 md:max-h-none md:border-b-0 md:border-r">
            {loadingList && !items.length ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500"><Loader2 size={17} className="animate-spin" />加载记录…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-zinc-500">暂无 Nowen 数据包导入记录</div>
            ) : items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`mb-1.5 w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${selectedId === item.id ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-500/10" : "border-transparent hover:border-zinc-200 hover:bg-white dark:hover:border-zinc-800 dark:hover:bg-zinc-900"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{modeLabel(item.importMode)}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.status === "completed" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : item.status === "undone" ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300" : item.status === "failed" ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" : "bg-amber-100 text-amber-700"}`}>{statusLabel(item.status)}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500"><Clock3 size={12} />{formatDate(item.completedAt || item.createdAt)}</div>
                <div className="mt-1 text-[11px] text-zinc-400">笔记 {numeric(item.counts.notes) + numeric(item.counts.updatedNotes)} · 附件 {numeric(item.counts.attachments)}</div>
              </button>
            ))}
          </aside>

          <main className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
            {loadingDetail ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500"><Loader2 size={18} className="animate-spin" />读取批次报告…</div>
            ) : !detail ? (
              <div className="py-16 text-center text-sm text-zinc-500">选择一条导入记录查看详情</div>
            ) : (
              <div className="space-y-4">
                <section className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-950/30">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{modeLabel(detail.importMode)}</span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">{statusLabel(detail.status)}</span>
                    <span className="text-xs text-zinc-500">{formatDate(detail.completedAt || detail.createdAt)}</span>
                  </div>
                  <div className="mt-2 grid gap-1 text-xs text-zinc-500 sm:grid-cols-2">
                    <p>数据包：{detail.packageKind === "markdown" ? "Markdown 往返包" : "Nowen 无损包"}</p>
                    <p className="truncate" title={detail.sourceInstanceId || ""}>来源实例：{detail.sourceInstanceId || "未记录"}</p>
                    <p>目标空间：{detail.workspaceId || "个人空间"}</p>
                    <p>导出批次：{detail.sourceExportBatchId || "未记录"}</p>
                  </div>
                </section>

                <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {cards.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800"><div className="flex items-center gap-1.5 text-xs text-zinc-500"><Icon size={14} />{label}</div><div className="mt-1 text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div></div>)}
                </section>

                <section className={`rounded-xl border p-3 ${detail.undo.available ? "border-blue-200 bg-blue-50/55 dark:border-blue-900/50 dark:bg-blue-500/5" : detail.status === "undone" ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
                  <div className="flex items-start gap-2">
                    {detail.status === "undone" ? <ArchiveRestore size={17} className="mt-0.5 shrink-0 text-emerald-600" /> : detail.undo.available ? <ShieldCheck size={17} className="mt-0.5 shrink-0 text-blue-600" /> : <ShieldAlert size={17} className="mt-0.5 shrink-0 text-zinc-400" />}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{detail.status === "undone" ? "本批次已安全撤销" : detail.undo.available ? "可安全撤销本次导入" : "当前不可撤销"}</h3>
                      <p className="mt-1 text-[11px] leading-5 text-zinc-500">{detail.status === "undone" ? `撤销时间：${formatDate(detail.undoneAt)}` : detail.undo.available ? `撤销窗口截止：${formatDate(detail.undo.expiresAt)}。执行前会校验导入后的本地修改。` : detail.undo.reason || detail.undo.error || "没有完整撤销快照。"}</p>
                    </div>
                    {detail.undo.available && <button type="button" onClick={handleUndo} disabled={undoing} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">{undoing ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}撤销本次导入</button>}
                  </div>
                </section>

                {(error || undoConflicts.length > 0) && <section className="rounded-xl border border-red-200 bg-red-50/55 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-500/5 dark:text-red-300"><p className="font-semibold">{error}</p>{undoConflicts.length > 0 && <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">{undoConflicts.map((item, index) => <p key={`${item}-${index}`}>• {item}</p>)}</div>}</section>}

                <section className={`rounded-xl border p-3 ${errors.length ? "border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-500/5" : warnings.length ? "border-amber-200 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-500/5" : "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-500/5"}`}>
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">{errors.length ? <AlertTriangle size={15} className="text-red-600" /> : <CheckCircle2 size={15} className="text-emerald-600" />}执行结果 · 错误 {errors.length} · 警告 {warnings.length}</h3>
                  {errors.length || warnings.length ? <div className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[11px] leading-5 text-zinc-600 dark:text-zinc-300">{errors.map((item: any, index) => <p key={`e-${index}`}>• {typeof item === "string" ? item : item?.message || JSON.stringify(item)}</p>)}{warnings.map((item: any, index) => <p key={`w-${index}`}>• {typeof item === "string" ? item : item?.message || item?.type || JSON.stringify(item)}</p>)}</div> : <p className="mt-1 text-[11px] text-zinc-500">导入过程未报告错误或警告。</p>}
                </section>

                <section className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                  <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">变更与冲突 · {conflicts.length}</h3>
                  {conflicts.length ? <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">{conflicts.map((item: any, index) => <div key={`${item?.sourceId || index}-${index}`} className="rounded-lg bg-zinc-50 px-2.5 py-2 text-[11px] text-zinc-600 dark:bg-zinc-950/45 dark:text-zinc-300"><div className="flex flex-wrap items-center gap-1.5"><span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-zinc-700">{item?.action || "change"}</span><span className="font-medium">{item?.originalName || item?.sourceId || "资源"}</span>{item?.importedName && item.importedName !== item.originalName && <span>→ {item.importedName}</span>}</div></div>)}</div> : <p className="mt-1 text-[11px] text-zinc-500">没有需要展示的重命名、同步更新或本地冲突。</p>}
                </section>
              </div>
            )}
          </main>
        </div>

        <footer className="flex shrink-0 justify-end border-t border-zinc-200 px-4 pt-3 pb-[max(0.9rem,env(safe-area-inset-bottom))] dark:border-zinc-800 sm:px-5 sm:pb-4">
          <button type="button" onClick={onClose} disabled={undoing} className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">关闭</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default function RoundTripImportBatchCenter() {
  const [open, setOpen] = useState(false);
  const [initialBatchId, setInitialBatchId] = useState("");

  useEffect(() => {
    const openWithEvent = (event: Event) => {
      const batchId = String((event as CustomEvent<{ batchId?: string }>).detail?.batchId || "");
      setInitialBatchId(batchId);
      setOpen(true);
    };
    window.addEventListener(ROUND_TRIP_IMPORT_COMPLETED_EVENT, openWithEvent);
    window.addEventListener(ROUND_TRIP_IMPORT_HISTORY_EVENT, openWithEvent);
    return () => {
      window.removeEventListener(ROUND_TRIP_IMPORT_COMPLETED_EVENT, openWithEvent);
      window.removeEventListener(ROUND_TRIP_IMPORT_HISTORY_EVENT, openWithEvent);
    };
  }, []);

  return (
    <>
      <RoundTripImportReviewCenter />
      <HistoryButtonBridge />
      <BatchCenterModal open={open} initialBatchId={initialBatchId} onClose={() => setOpen(false)} />
    </>
  );
}
