import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CloudOff,
  Download,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  exportQueueDiagnostics,
  getQueue,
  retryFailedQueueItems,
  retryQueueItem,
  subscribe as subscribeOfflineQueue,
  type OfflineQueueItem,
} from "@/lib/offlineQueue";
import {
  getSyncSummary,
  subscribeSyncSummary,
  SYNC_SNAPSHOT_APPLIED_EVENT,
  type SyncSummary,
} from "@/lib/syncEngine";
import { toast } from "@/lib/toast";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useAppActions } from "@/store/AppContext";

function itemTypeLabel(item: OfflineQueueItem): string {
  if (item.type === "createNote") return "新建笔记";
  if (item.type === "deleteNote") return "删除笔记";
  return "更新笔记";
}

function queueItemPayload(item: OfflineQueueItem): Record<string, unknown> {
  return item.localPayload || item.body || {};
}

export function getQueueItemNoteTitle(item: OfflineQueueItem): string {
  const title = queueItemPayload(item).title;
  return typeof title === "string" && title.trim() ? title.trim() : "未命名笔记";
}

export function getQueueItemNotePreview(item: OfflineQueueItem): string {
  const payload = queueItemPayload(item);
  const raw = typeof payload.contentText === "string"
    ? payload.contentText
    : typeof payload.content === "string"
      ? payload.content
      : "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized;
}

export function getQueueItemStatusMessage(item: OfflineQueueItem): string {
  if (item.conflict || item.errorCode === "VERSION_CONFLICT") {
    return "两个版本均已保留，请确认最终使用的内容。";
  }
  return item.message || (item.blocked ? "自动同步已暂停，本地内容仍然保留。" : "正在等待服务器确认。 ");
}

export type SyncIndicatorAction = "none" | "details" | "retry";
export type SyncIndicatorTone = "offline" | "syncing" | "error" | "pending";

export interface SyncIndicatorPresentation {
  tone: SyncIndicatorTone;
  label: string;
  description?: string;
  action: SyncIndicatorAction;
  actionLabel?: string;
  compact?: boolean;
}

export interface SyncIndicatorPresentationInput {
  isOnline: boolean;
  isBootstrapping: boolean;
  showSyncing: boolean;
  pendingCount: number;
  showPending: boolean;
  failedCount: number;
  conflictCount: number;
  queueCount: number;
  lastError?: string | null;
}

/**
 * Translate internal sync state into the small set of states a user needs to understand.
 * Normal successful synchronization deliberately returns null and stays invisible.
 */
export function getSyncIndicatorPresentation({
  isOnline,
  isBootstrapping,
  showSyncing,
  pendingCount,
  showPending,
  failedCount,
  conflictCount,
  queueCount,
  lastError,
}: SyncIndicatorPresentationInput): SyncIndicatorPresentation | null {
  if (!isOnline) {
    return {
      tone: "offline",
      label: "当前离线",
      description: pendingCount > 0
        ? `${pendingCount} 项修改已保存在本机，联网后将自动同步。`
        : "联网后将自动恢复同步。",
      action: "none",
    };
  }

  if (isBootstrapping) {
    if (!showSyncing) return null;
    return {
      tone: "syncing",
      label: "正在同步…",
      action: "none",
      compact: true,
    };
  }

  if (conflictCount > 0) {
    return {
      tone: "error",
      label: `${conflictCount} 篇笔记存在版本冲突`,
      description: "两个版本均已保留，请查看后确认最终内容。",
      action: queueCount > 0 ? "details" : "retry",
      actionLabel: queueCount > 0 ? "查看冲突" : "重新同步",
    };
  }

  if (failedCount > 0 || lastError) {
    const count = Math.max(failedCount, pendingCount);
    return {
      tone: "error",
      label: count > 0 ? `${count} 项修改尚未同步` : "同步暂时失败",
      description: count > 0
        ? "本地内容已保留，可查看后重新同步。"
        : "本地内容未丢失，可以重新同步。",
      action: queueCount > 0 ? "details" : "retry",
      actionLabel: queueCount > 0 ? "查看并重试" : "重新同步",
    };
  }

  if (pendingCount > 0 && showPending) {
    return {
      tone: "pending",
      label: `${pendingCount} 项修改尚未同步`,
      description: "本地内容已保存，正在等待服务器确认。",
      action: queueCount > 0 ? "details" : "retry",
      actionLabel: queueCount > 0 ? "查看并重试" : "重新同步",
    };
  }

  return null;
}

function downloadDiagnostics(): void {
  const blob = new Blob([exportQueueDiagnostics()], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nowen-sync-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function OfflineIndicator() {
  const actions = useAppActions();
  const { isOnline, wasOffline, pendingCount, flush } = useNetworkStatus();
  const [summary, setSummary] = useState<SyncSummary>(() => getSyncSummary());
  const [queue, setQueue] = useState<OfflineQueueItem[]>(() => getQueue());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const [showSyncing, setShowSyncing] = useState(false);
  const recoveryToastShownRef = useRef(false);

  useEffect(() => subscribeSyncSummary(setSummary), []);
  useEffect(() => subscribeOfflineQueue(() => setQueue(getQueue())), []);

  useEffect(() => {
    const handleSnapshot = () => {
      actions.refreshNotes();
      actions.refreshNotebooks();
      api.getTags().then(actions.setTags).catch((error) => {
        console.warn("[OfflineIndicator] refresh tags after sync failed:", error);
      });
    };
    window.addEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, handleSnapshot);
    return () => window.removeEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, handleSnapshot);
  }, [actions]);

  const failedItems = useMemo(() => queue.filter(
    (item) => item.conflict || item.blocked || !!item.errorCode || item.retryCount > 0,
  ), [queue]);
  const conflictCount = failedItems.filter(
    (item) => item.conflict || item.errorCode === "VERSION_CONFLICT",
  ).length;
  const retryableCount = queue.filter(
    (item) => !(item.conflict || item.errorCode === "VERSION_CONFLICT") && item.retryable !== false,
  ).length;

  // A normal save often enters and leaves the queue within one network round trip. Do not flash
  // a global warning unless it remains pending long enough to be meaningful to the user.
  useEffect(() => {
    if (
      !isOnline ||
      pendingCount === 0 ||
      failedItems.length > 0 ||
      summary.state === "bootstrapping"
    ) {
      setShowPending(false);
      return;
    }
    const timer = window.setTimeout(() => setShowPending(true), 2200);
    return () => window.clearTimeout(timer);
  }, [failedItems.length, isOnline, pendingCount, summary.state]);

  // Likewise, hide very short bootstrap work and show only a small, non-expandable progress pill
  // when synchronization actually takes noticeable time.
  useEffect(() => {
    if (summary.state !== "bootstrapping") {
      setShowSyncing(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSyncing(true), 450);
    return () => window.clearTimeout(timer);
  }, [summary.state]);

  // Recovery is a completed result, not a management surface. Announce it once through the
  // existing transient toast system instead of leaving an expandable success card on screen.
  useEffect(() => {
    if (!wasOffline) {
      recoveryToastShownRef.current = false;
      return;
    }
    const recovered = isOnline
      && summary.state !== "bootstrapping"
      && pendingCount === 0
      && failedItems.length === 0
      && !summary.lastError;
    if (recovered && !recoveryToastShownRef.current) {
      recoveryToastShownRef.current = true;
      toast.success("已恢复连接，内容已同步");
    }
  }, [failedItems.length, isOnline, pendingCount, summary.lastError, summary.state, wasOffline]);

  const status = useMemo(() => getSyncIndicatorPresentation({
    isOnline,
    isBootstrapping: summary.state === "bootstrapping",
    showSyncing,
    pendingCount,
    showPending,
    failedCount: failedItems.length,
    conflictCount,
    queueCount: queue.length,
    lastError: summary.lastError,
  }), [
    conflictCount,
    failedItems.length,
    isOnline,
    pendingCount,
    queue.length,
    showPending,
    showSyncing,
    summary.lastError,
    summary.state,
  ]);

  useEffect(() => {
    if (!status || status.action !== "details" || queue.length === 0) {
      setDetailsOpen(false);
    }
  }, [queue.length, status]);

  const retryOne = useCallback(async (item: OfflineQueueItem) => {
    if (!isOnline || item.conflict || item.errorCode === "VERSION_CONFLICT" || item.retryable === false) return;
    setRetryingId(item.id);
    try {
      if (retryQueueItem(item.id)) await flush(true);
    } finally {
      setRetryingId(null);
    }
  }, [flush, isOnline]);

  const retryAll = useCallback(async () => {
    if (!isOnline) return;
    setRetryingAll(true);
    try {
      retryFailedQueueItems();
      await flush(true);
    } finally {
      setRetryingAll(false);
    }
  }, [flush, isOnline]);

  if (!status) return null;

  if (status.compact) {
    return (
      <div
        className="fixed right-3 z-[95]"
        style={{ bottom: "calc(12px + var(--safe-area-bottom, 0px))" }}
        role="status"
        aria-live="polite"
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-app-elevated px-3 py-2 text-xs font-medium text-tx-secondary shadow-lg dark:border-blue-900">
          <Loader2 size={14} className="animate-spin text-blue-600 dark:text-blue-400" />
          {status.label}
        </div>
      </div>
    );
  }

  const toneClasses = {
    offline: "border-zinc-300 bg-zinc-900 text-white dark:border-zinc-700",
    syncing: "border-blue-200 bg-app-elevated text-tx-primary dark:border-blue-900",
    error: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
    pending: "border-blue-200 bg-white text-zinc-900 dark:border-blue-900 dark:bg-zinc-900 dark:text-zinc-100",
  }[status.tone];

  const StatusIcon = status.tone === "offline" ? CloudOff : status.tone === "error" ? AlertTriangle : RefreshCw;
  const detailsTitle = conflictCount > 0 ? "需要处理的同步问题" : "未同步内容";
  const detailsDescription = conflictCount > 0
    ? "本地内容和服务器内容都已保留。请确认每项状态后再决定最终版本。"
    : "这些修改尚未得到服务器确认，本地内容仍然保留。";

  return (
    <div
      className="fixed right-3 z-[95] w-[min(420px,calc(100vw-24px))]"
      style={{ bottom: "calc(12px + var(--safe-area-bottom, 0px))" }}
    >
      {detailsOpen && queue.length > 0 && status.action === "details" && (
        <section className="mb-2 max-h-[min(60vh,520px)] overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl">
          <header className="flex items-start justify-between gap-3 border-b border-app-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-tx-primary">{detailsTitle}</h3>
              <p className="mt-0.5 text-xs leading-5 text-tx-tertiary">{detailsDescription}</p>
            </div>
            <button
              type="button"
              onClick={() => setDetailsOpen(false)}
              className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
              aria-label="关闭未同步内容"
            >
              <X size={15} />
            </button>
          </header>

          <div className="max-h-[360px] overflow-y-auto p-3">
            <div className="space-y-2">
              {queue.map((item) => {
                const isConflict = item.conflict || item.errorCode === "VERSION_CONFLICT";
                const canRetry = isOnline && !isConflict && item.retryable !== false;
                const noteTitle = getQueueItemNoteTitle(item);
                const notePreview = getQueueItemNotePreview(item);
                return (
                  <article key={item.id} className="rounded-xl border border-app-border bg-app-bg/60 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-tx-primary" title={noteTitle}>
                          {noteTitle}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-tx-tertiary">{itemTypeLabel(item)}</span>
                          {isConflict && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                              版本冲突
                            </span>
                          )}
                        </div>
                        {notePreview && (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-tx-secondary">
                            {notePreview}
                          </p>
                        )}
                        <p className="mt-1.5 text-xs leading-5 text-tx-secondary">
                          {getQueueItemStatusMessage(item)}
                        </p>
                        <details className="mt-1.5 text-[10px] text-tx-tertiary">
                          <summary className="cursor-pointer select-none hover:text-tx-secondary">技术详情</summary>
                          <div className="mt-1 space-y-0.5 break-all font-mono">
                            <p>笔记 ID：{item.noteId}</p>
                            <p>已尝试：{item.retryCount} 次</p>
                            {item.errorCode && <p>错误码：{item.errorCode}</p>}
                            {typeof item.serverVersion === "number" && <p>服务器版本：{item.serverVersion}</p>}
                          </div>
                        </details>
                      </div>
                      {isConflict ? (
                        <span className="shrink-0 rounded-lg bg-amber-100 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                          需人工确认
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canRetry || retryingId === item.id}
                          onClick={() => void retryOne(item)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-app-border px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40"
                          title={item.retryable === false ? "该操作不能自动重试，请先导出本地副本" : "重新同步此项"}
                        >
                          {retryingId === item.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          重试
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border px-3 py-2.5">
            <button
              type="button"
              onClick={downloadDiagnostics}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-app-hover"
            >
              <Download size={13} />
              导出本地副本
            </button>
            {retryableCount > 0 && (
              <button
                type="button"
                disabled={!isOnline || retryingAll}
                onClick={() => void retryAll()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {retryingAll ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                重新同步
              </button>
            )}
          </footer>
        </section>
      )}

      <div className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 shadow-lg ${toneClasses}`} role="status" aria-live="polite">
        <StatusIcon size={16} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{status.label}</span>
          {status.description && <span className="block truncate text-[11px] opacity-75">{status.description}</span>}
        </div>
        {status.action !== "none" && status.actionLabel && (
          <button
            type="button"
            disabled={status.action === "retry" && retryingAll}
            onClick={() => {
              if (status.action === "details") setDetailsOpen((open) => !open);
              else void retryAll();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-current/20 bg-white/20 px-2.5 py-1.5 text-xs font-medium hover:bg-white/30 disabled:opacity-50 dark:bg-black/10 dark:hover:bg-black/20"
          >
            {status.action === "retry" && retryingAll && <Loader2 size={12} className="animate-spin" />}
            {status.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
