import { getQueueLength } from "@/lib/offlineQueue";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitCompare,
  History,
  Loader2,
  Merge,
  RotateCcw,
} from "lucide-react";
import {
  applyKnowledgeTreeRepair,
  fetchConflictDetail,
  fetchKnowledgeTreeRepairBackup,
  fetchConflicts,
  fetchResolvedConflicts,
  forkConflict,
  hasNativeSyncLocalAdminAdapter,
  previewKnowledgeTreeRepair,
  reopenConflict,
  resolveConflict,
  SYNC_CONFLICT_ENTITY_TYPES,
  triggerSyncNow,
  type ConflictDetail,
  type ConflictSummary,
  type ResolvedConflictSummary,
} from "@/lib/syncLocalApi";
import { buildAutomaticConflictMerge } from "@/lib/syncConflictAutoMerge";
import { isProtectedNotePayload } from "@/lib/encryptedNotes/blockDocument";
import { getKnowledgeTreeExpansionScope } from "@/lib/knowledgeTreeExpansion";
import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { MOBILE_SYNC_STATUS_CHANGED_EVENT } from "@/lib/mobileSyncStatus";
import { downloadBlob } from "@/lib/mindmapExport";
import { isAndroidNative, saveBlobToSystemFile } from "@/lib/nativeImageSave";
import { TREE_CONFLICT_FIELDS, canSafelyChooseTreeSide, isTreeConflict, isTreeLifecycleConflict, treeConflictAvailability, treeConflictExplanation } from "@/lib/syncTreeConflictPresentation";

type TreeRepairStrategy = "keep-local" | "keep-remote";
type TreeRepairPreview = Awaited<ReturnType<typeof previewKnowledgeTreeRepair>> & { blocked?: string };

function canResolveNativeTreeLifecycle(detail: ConflictDetail, strategy: TreeRepairStrategy): boolean {
  return hasNativeSyncLocalAdminAdapter() && canSafelyChooseTreeSide(detail) &&
    Boolean(detail.local?.lifecycle || (strategy === "keep-remote" && detail.remote?.__delete)) &&
    !(strategy === "keep-local" && detail.remote?.__delete);
}

const HISTORY_PAGE_SIZE = 20;
const ENTITY_TYPE_LABELS: Record<string, string> = {
  notebook: "笔记本",
  note: "笔记",
  tag: "标签",
  note_tag: "笔记标签",
  favorite: "收藏",
  attachment: "附件",
  task: "任务",
  task_reminder: "任务提醒",
  diary: "日记",
  mindmap: "思维导图",
  knowledge_tree_node: "知识树节点",
};

/**
 * 冲突中心（Phase 5 + Phase 7）。
 *
 * 设计前提：正文冲突绝不能自动生成大量"xxx 冲突副本"污染知识树。
 * 因此两个版本都留在冲突台账里，由用户在这里显式选择：
 *
 *   保留本机 / 保留服务器 / 手动合并
 *
 * 另外提供"另存为新笔记"作为出口——只有用户主动点击才会产生新条目。
 * 解决后三方内容仍然保留，选错了还能回来取。
 */
export function ConflictCenter({
  deviceId,
  onResolved,
}: {
  deviceId: string | null;
  onResolved?: () => void;
}) {
  const {t}=useTranslation();
  const [items, setItems] = useState<ConflictSummary[]>([]);
  const [historyItems, setHistoryItems] = useState<ResolvedConflictSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyEntityType, setHistoryEntityType] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ConflictDetail | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);
  const detailRequestRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const reloadRequestRef = useRef(0);
  const [repairBackup, setRepairBackup] = useState<{ id: string; scope: string } | null>(null);

  const treeNameScope = getKnowledgeTreeExpansionScope();
  const [treeNameSnapshot, setTreeNameSnapshot] = useState<{ scope: string; names: Map<string, string> } | null>(null);
  const treeNames = treeNameSnapshot?.scope === treeNameScope ? treeNameSnapshot.names : new Map<string, string>();
  const [treePreview, setTreePreview] = useState<{
    strategy: TreeRepairStrategy;
    ids: string[];
    scope: string;
    preview: TreeRepairPreview;
  } | null>(null);
  const treeItems = items.filter((item) => isTreeConflict(item.entityType));
  const otherItems = items.filter((item) => !isTreeConflict(item.entityType));
  const bulkTargets = otherItems.filter((item) => selectedIds.has(item.id) && item.entityType !== "attachment_organization");
  const selectedTreeIds = treeItems.filter((item) => selectedIds.has(item.id)).map((item) => item.id);
  const attachmentCount = selectedIds.size - bulkTargets.length - selectedTreeIds.length;

  useEffect(() => {
    if (![...items, ...historyItems].some((item) => isTreeConflict(item.entityType))) return;
    let active = true;
    const scope = treeNameScope;
    void knowledgeTreeApi.list(true).then(({ nodes }) => {
      if (active && scope === getKnowledgeTreeExpansionScope()) {
        setTreeNameSnapshot({ scope, names: new Map(nodes.map((node) => [node.id, node.title])) });
      }
    }).catch(() => {
      if (active) setTreeNameSnapshot(null);
    });
    return () => { active = false; };
  }, [items, historyItems, treeNameScope]);

  const conflictTitle = (item: ConflictSummary) => (
    item.localTitle || item.remoteTitle || (isTreeConflict(item.entityType)
      ? treeNames.get(item.entityId) || t("treeConflict.untitled")
      : item.entityId)
  );

  const reload = useCallback(async (quiet = false) => {
    const requestId = ++reloadRequestRef.current;
    const scope = getOfflineQueueStorageKey();
    const isCurrent = () => requestId === reloadRequestRef.current && scope === getOfflineQueueStorageKey();
    if (!quiet) setLoading(true);
    setTreePreview(null);
    try {
      const [result, history] = await Promise.all([
        fetchConflicts(),
        fetchResolvedConflicts({
          limit: HISTORY_PAGE_SIZE,
          offset: 0,
          entityType: historyEntityType || undefined,
        }),
      ]);
      if (!isCurrent()) return;
      setItems(result.items);
      setHistoryItems(history.items);
      setHistoryTotal(history.total);
      const availableIds = new Set(result.items.map((item) => item.id));
      setSelectedIds((current) => new Set(
        [...current].filter((id) => availableIds.has(id)),
      ));
      return result.items;
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [historyEntityType]);

  useEffect(() => {
    void reload();
    const scope = getOfflineQueueStorageKey();
    const onSyncStatus = () => {
      if (hasNativeSyncLocalAdminAdapter() && scope === getOfflineQueueStorageKey()) {
        setNotice(null);
        void reload(true);
      }
    };
    window.addEventListener(MOBILE_SYNC_STATUS_CHANGED_EVENT, onSyncStatus);
    return () => {
      ++reloadRequestRef.current;
      window.removeEventListener(MOBILE_SYNC_STATUS_CHANGED_EVENT, onSyncStatus);
    };
  }, [reload]);

  const openDetail = async (id: string) => {
    const requestId = ++detailRequestRef.current;
    setError(null);
    setDetailError(null);
    setDetailLoadingId(id);
    setSelected(null);
    setTreePreview(null);
    try {
      const detail = await fetchConflictDetail(id);
      if (requestId === detailRequestRef.current) setSelected(detail);
    } catch (err) {
      if (requestId === detailRequestRef.current) {
        setDetailError({ id, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoadingId(null);
    }
  };

  const handleTreePreview = async (strategy: TreeRepairStrategy, ids: string[]) => {
    const scope = getOfflineQueueStorageKey();
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    setTreePreview(null);
    try {
      if (getQueueLength() > 0) throw new Error(t("treeConflict.pendingOfflineWrites"));
      const preview = await previewKnowledgeTreeRepair(strategy, ids);
      if (scope === getOfflineQueueStorageKey()) {
        setTreePreview({ strategy, ids, scope, preview });
      }
    } catch (err) {
      if (scope === getOfflineQueueStorageKey()) {
        setTreePreview({
          strategy,
          ids,
          scope,
          preview: { token: "", changes: [], blocked: err instanceof Error ? err.message : String(err) },
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const requestTreeSync = async () => {
    const result = await triggerSyncNow();
    if (!result.engineRunning || result.status?.state === "error" || result.status?.state === "offline") {
      throw new Error(result.status?.lastError || result.message || t("treeConflict.syncUnavailable"));
    }
  };

  const handleTreeRepair = async () => {
    if (!treePreview?.preview.token || treePreview.preview.blocked ||
        treePreview.scope !== getOfflineQueueStorageKey()) return;
    setBusy(true);
    setError(null);
    setTreePreview(null);
    try {
      if (getQueueLength() > 0) throw new Error(t("treeConflict.pendingOfflineWrites"));
      const result = await applyKnowledgeTreeRepair(treePreview.strategy, treePreview.ids, treePreview.preview.token);
      if (treePreview.scope !== getOfflineQueueStorageKey()) return;
      setSelected(null);
      if (result.backupId && hasNativeSyncLocalAdminAdapter()) {
        setRepairBackup({ id: result.backupId, scope: treePreview.scope });
      }
      const backupNotice = result.backupId
        ? ` ${t(hasNativeSyncLocalAdminAdapter() ? "treeConflict.backupSaved" : "treeConflict.desktopBackupSaved", {
            id: result.backupFilename || result.backupId,
            data: t("settings.dataManagement"),
            restore: t("dataManager.overview.restore"),
          })}`
        : "";
      const repairNotice = t(treePreview.strategy === "keep-remote" ? "treeConflict.repaired" : "treeConflict.localQueued", {
        count: result.resolved,
      });
      setNotice(repairNotice + backupNotice);
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "sync-conflict-repair" },
      }));
      try {
        await requestTreeSync();
        setWarning(t("treeConflict.verifyRequested"));
      } catch (err) {
        setWarning(t("treeConflict.syncFailed", { reason: err instanceof Error ? err.message : String(err) }));
      }
      const refreshed = await reload();
      if (refreshed) {
        const count = refreshed.filter((item) => isTreeConflict(item.entityType)).length;
        setNotice(`${repairNotice} ${t("treeConflict.remainingCount", { count })}${backupNotice}`);
      }
      onResolved?.();
    } catch (err) {
      if (treePreview.scope !== getOfflineQueueStorageKey()) return;
      setTreePreview({
        ...treePreview,
        preview: {
          ...treePreview.preview,
          token: "",
          blocked: t("treeConflict.repairFailed", { reason: err instanceof Error ? err.message : String(err) }),
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const exportRepairBackup = async () => {
    if (!repairBackup || repairBackup.scope !== getOfflineQueueStorageKey()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await fetchKnowledgeTreeRepairBackup(repairBackup.id);
      if (repairBackup.scope !== getOfflineQueueStorageKey()) return;
      const fileName = `nowen-tree-before-repair-${saved.id}.json`;
      const mimeType = "application/json";
      const blob = new Blob([JSON.stringify({ version: 1, ...saved }, null, 2)], { type: mimeType });
      if (isAndroidNative()) await saveBlobToSystemFile({ blob, fileName, mimeType });
      else downloadBlob(blob, fileName);
    } catch (err) {
      setError(t("treeConflict.exportFailed", { reason: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleTreeSync = async () => {
    setBusy(true);
    setTreePreview(null);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      await requestTreeSync();
      setSelected(null);
      const refreshed = await reload();
      onResolved?.();
      if (refreshed) setNotice(t("treeConflict.syncRequested"));
    } catch (err) {
      setError(t("treeConflict.syncFailed", { reason: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async (id: string, resolution: TreeRepairStrategy) => {
    const isTree = items.some((item) => item.id === id && isTreeConflict(item.entityType));
    if (isTree) {
      if (selected?.id !== id) return;
      if (!isTreeLifecycleConflict(selected)) {
        await handleTreePreview(resolution, [id]);
        return;
      }
      if (!canResolveNativeTreeLifecycle(selected, resolution)) return;
      if (getQueueLength() > 0) {
        setDetailError({ id, message: t("treeConflict.pendingOfflineWrites") });
        return;
      }
      if (!window.confirm(t(resolution === "keep-local"
        ? "treeConflict.confirmLifecycleLocal"
        : "treeConflict.confirmLifecycleRemote"))) return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      await resolveConflict(id, { resolution, deviceId: deviceId ?? undefined });
      setSelected(null);
      await reload();
      onResolved?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTree) setDetailError({ id, message });
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleManualResolve = async (id: string, mergedPayload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      await resolveConflict(id,{resolution:"manual",mergedPayload,deviceId:deviceId ?? undefined});
      setSelected(null);
      await reload();
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const handleFork = async (id: string, side: "local" | "remote") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      await forkConflict(id, side, deviceId ?? undefined);
      await reload();
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disableTreeSide = (id: string, strategy: TreeRepairStrategy) => {
    if (selected?.id !== id) return true;
    if (!isTreeLifecycleConflict(selected)) return false;
    return !canResolveNativeTreeLifecycle(selected, strategy);
  };

  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  const toggleAll = () => {
    setTreePreview(null);
    setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };

  const toggleItem = (id: string) => {
    setTreePreview(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkResolve = async (resolution: "keep-local" | "keep-remote") => {
    const targets = bulkTargets;
    if (targets.length === 0) return;

    const sourceLabel = resolution === "keep-local" ? "本机" : "云端";
    const confirmed = window.confirm(
      `确定将已选 ${targets.length} 条冲突全部采用${sourceLabel}版本吗？另一方版本仍会保留在冲突记录中。`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    const failed: string[] = [];
    let resolvedCount = 0;

    try {
      for (const item of targets) {
        try {
          await resolveConflict(item.id, {
            resolution,
            deviceId: deviceId ?? undefined,
          });
          resolvedCount += 1;
        } catch (reason) {
          const title = item.localTitle || item.remoteTitle || item.entityId;
          const message = reason instanceof Error ? reason.message : String(reason);
          failed.push(`${title}：${message}`);
        }
      }

      setSelected(null);
      await reload();
      if (resolvedCount > 0) onResolved?.();
      if (failed.length > 0) {
        setError(`已处理 ${resolvedCount} 条，${failed.length} 条失败：${failed.join("；")}`);
      } else {
        setNotice(`已将 ${resolvedCount} 条冲突批量采用${sourceLabel}版本。`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleAutomaticMerge = async () => {
    const targets = bulkTargets;
    if (targets.length === 0) return;

    const confirmed = window.confirm(
      `将智能合并已选 ${targets.length} 条冲突。只处理双方修改字段不重叠的内容，同字段冲突会继续保留，是否继续？`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    const blocked: string[] = [];
    const failed: string[] = [];
    let mergedCount = 0;

    try {
      for (const item of targets) {
        const title = item.localTitle || item.remoteTitle || item.entityId;
        try {
          const detail = await fetchConflictDetail(item.id);
          const merged = buildAutomaticConflictMerge(detail);
          if (!merged.ok) {
            const reason = merged.reason === "missing-base"
              ? "缺少共同基线"
              : merged.reason === "encrypted-content"
                ? "请选择保留本机版本或云端版本"
                : merged.reason === "missing-side"
                  ? "版本内容不完整"
                  : `重叠字段：${merged.conflictFields.join("、")}`;
            blocked.push(`${title}（${reason}）`);
            continue;
          }

          await resolveConflict(item.id, {
            resolution: "manual",
            mergedPayload: merged.payload,
            deviceId: deviceId ?? undefined,
          });
          mergedCount += 1;
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          failed.push(`${title}：${message}`);
        }
      }

      setSelected(null);
      await reload();
      if (mergedCount > 0) onResolved?.();

      if (blocked.length > 0) {
        const sample = blocked.slice(0, 3).join("；");
        const more = blocked.length > 3 ? `；另有 ${blocked.length - 3} 条` : "";
        setWarning(`已智能合并 ${mergedCount} 条，${blocked.length} 条仍需手动处理：${sample}${more}`);
      } else if (failed.length === 0) {
        setNotice(`已智能合并 ${mergedCount} 条冲突。`);
      }

      if (failed.length > 0) {
        setError(`智能合并有 ${failed.length} 条执行失败：${failed.join("；")}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReopen = async (item: ResolvedConflictSummary) => {
    const title = conflictTitle(item);
    const confirmed = window.confirm(
      `确定撤销“${title}”的已处理状态吗？它会重新出现在待处理列表中，但不会自动回滚当前内容。`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const result = await reopenConflict(item.id);
      setSelected(null);
      await reload();
      setNotice(result.message);
      onResolved?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleLoadMoreHistory = async () => {
    if (historyLoadingMore || historyItems.length >= historyTotal) return;
    setHistoryLoadingMore(true);
    setError(null);
    try {
      const history = await fetchResolvedConflicts({
        limit: HISTORY_PAGE_SIZE,
        offset: historyItems.length,
        entityType: historyEntityType || undefined,
      });
      setHistoryItems((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const item of history.items) byId.set(item.id, item);
        return [...byId.values()];
      });
      setHistoryTotal(history.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHistoryLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium">冲突</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在检查…
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <GitCompare className="h-4 w-4" />
        冲突（{items.length}）
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有需要处理的冲突。</p>
      ) : (
        <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-2 text-xs">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={busy}
            onChange={toggleAll}
            className="h-3.5 w-3.5 accent-primary"
            aria-label="全选冲突"
          />
          <span>{allSelected ? "取消全选" : "全选"} · 已选 {selectedIds.size} 项</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || bulkTargets.length === 0}
            onClick={() => { void handleAutomaticMerge(); }}
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1.5 text-primary-foreground disabled:opacity-50"
            title="只自动合并双方修改字段不重叠的冲突"
          >
            <Merge className="h-3.5 w-3.5" />
            {busy ? "处理中…" : "智能合并选中项"}
          </button>
          <button
            type="button"
            disabled={busy || bulkTargets.length === 0}
            onClick={() => { void handleBulkResolve("keep-local"); }}
            className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50"
          >
            {busy ? "处理中…" : "一键采用本机"}
          </button>
          <button
            type="button"
            disabled={busy || bulkTargets.length === 0}
            onClick={() => { void handleBulkResolve("keep-remote"); }}
            className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50"
          >
            {busy ? "处理中…" : "一键采用云端"}
          </button>
        </div>
      </div>

      {selectedIds.size > 0 ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{t("treeConflict.selectionCounts", { ordinary: bulkTargets.length, tree: selectedTreeIds.length, attachments: attachmentCount })}</p>
        </div>
      ) : null}

      {[otherItems, treeItems].map((group) => group.length > 0 ? (
        <section key={group === treeItems ? "tree" : "other"} className="space-y-2">
          <h4 className="text-xs font-medium">
            {group === treeItems
              ? t("treeConflict.heading", { count: group.length })
              : t("treeConflict.otherHeading", { count: group.length })}
          </h4>
          {group === treeItems ? (
            <>
              <p className="text-xs text-muted-foreground">{t("treeConflict.structureOnly")}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                <button type="button" disabled={busy || selectedTreeIds.length === 0}
                  onClick={() => { void handleTreePreview("keep-remote", selectedTreeIds); }}
                  className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50">
                  {t("treeConflict.previewRemote")}
                </button>
                <button type="button" disabled={busy || selectedTreeIds.length === 0}
                  onClick={() => { void handleTreePreview("keep-local", selectedTreeIds); }}
                  className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50">
                  {t("treeConflict.previewLocal")}
                </button>
                <button type="button" disabled={busy}
                  onClick={() => { void handleTreeSync(); }}
                  className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50">
                  {t("treeConflict.syncAndCheck")}
                </button>
              </div>
              {treePreview ? (
                <TreeRepairReview
                  strategy={treePreview.strategy}
                  preview={treePreview.preview}
                  requestedCount={treePreview.ids.length}
                  names={treeNames}
                  busy={busy}
                  onApply={() => { void handleTreeRepair(); }}
                  onClose={() => setTreePreview(null)}
                />
              ) : null}
            </>
          ) : null}
      <ul className="space-y-2">
        {group.map((item) => (
          <li key={item.id} className="rounded-md border p-3 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  disabled={busy}
                  onChange={() => toggleItem(item.id)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                  aria-label={`选择冲突 ${conflictTitle(item)}`}
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {conflictTitle(item)}
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    {isTreeConflict(item.entityType)
                      ? "知识树结构差异 · 不代表正文冲突 · 点击查看本机/云端状态"
                      : <>{item.entityType==="attachment_organization"?t("assetOrganization.syncConflictLabel"):ENTITY_TYPE_LABELS[item.entityType] || item.entityType} · 本机 v{item.localVersion ?? "?"} · 云端 v{item.remoteVersion ?? "?"}{item.diffFields.length > 0 ? ` · 差异：${item.diffFields.slice(0, 4).join("、")}` : ""}</>}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { void openDetail(item.id); }}
                disabled={busy || detailLoadingId === item.id}
                aria-expanded={selected?.id === item.id}
                className="shrink-0 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              >
                {detailLoadingId === item.id ? "加载中…" : selected?.id === item.id ? "已展开" : "查看"}
              </button>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || (isTreeConflict(item.entityType) && disableTreeSide(item.id, "keep-local"))}
                title={isTreeConflict(item.entityType) ? t("treeConflict.openDetails") : undefined}
                onClick={() => { void handleResolve(item.id, "keep-local"); }}
                className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              >
                保留本机版本
              </button>
              <button
                type="button"
                disabled={busy || (isTreeConflict(item.entityType) && disableTreeSide(item.id, "keep-remote"))}
                title={isTreeConflict(item.entityType) ? t("treeConflict.openDetails") : undefined}
                onClick={() => { void handleResolve(item.id, "keep-remote"); }}
                className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              >
                保留云端版本
              </button>
              {!isTreeConflict(item.entityType) && item.entityType!=="attachment_organization" ? (
                <button type="button" disabled={busy}
                  onClick={() => { void openDetail(item.id); }}
                  className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50">
                  <Merge className="h-3.5 w-3.5" />手动合并
                </button>
              ) : null}
              {item.entityType === "note" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void handleFork(item.id, "remote"); }}
                  className="rounded border px-2 py-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
                  title="把云端版本另存为一条新笔记，两个版本都保留"
                >
                  另存云端版本
                </button>
              ) : null}
            </div>
            {detailLoadingId === item.id ? (
              <p role="status" className="mt-3 text-muted-foreground">正在读取本机与云端详情…</p>
            ) : null}
            {detailError?.id === item.id ? (
              <p role="alert" className="mt-3 rounded border border-amber-400/50 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-300">{detailError.message}</p>
            ) : null}
            {selected?.id === item.id && selected.status !== "resolved" ? (
              <div className="mt-3" data-conflict-detail-id={item.id}>
                <ConflictDiff detail={selected} busy={busy} treeNames={treeNames} onClose={() => setSelected(null)}
                  onManual={(payload) => handleManualResolve(selected.id, payload)} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
        </section>
      ) : null)}
        </>
      )}

      {warning ? (
        <p role="status" className="flex items-start gap-2 text-xs text-amber-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {warning}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {notice ? (
        <p role="status" className="flex items-start gap-2 text-xs text-emerald-600">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {notice}
        </p>
      ) : null}

      {repairBackup?.scope === getOfflineQueueStorageKey() ? (
        <button type="button" disabled={busy} onClick={() => { void exportRepairBackup(); }}
          className="rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">
          {t("treeConflict.exportSavedStructure")}
        </button>
      ) : null}

      {historyTotal > 0 || historyEntityType !== "" || historyOpen ? (
        <ResolvedConflictHistory
          items={historyItems}
          total={historyTotal}
          entityType={historyEntityType}
          open={historyOpen}
          busy={busy}
          loadingMore={historyLoadingMore}
          onToggle={() => setHistoryOpen((value) => !value)}
          onEntityTypeChange={setHistoryEntityType}
          onLoadMore={() => { void handleLoadMoreHistory(); }}
          onView={(id) => { void openDetail(id); }}
          titleForItem={conflictTitle}
          onReopen={(item) => { void handleReopen(item); }}
        />
      ) : null}

      {selected?.status === "resolved" ? (
        <ConflictDiff detail={selected} busy={busy} treeNames={treeNames} onClose={() => setSelected(null)}
          onManual={(payload) => handleManualResolve(selected.id,payload)} />
      ) : null}
    </section>
  );
}

function treeParentLabel(value: unknown, names: Map<string, string>, t: TFunction): string {
  return typeof value === "string" && value
    ? names.get(value) || t("treeConflict.unknownParent")
    : t("treeConflict.root");
}

function TreeRepairReview({
  strategy,
  preview,
  requestedCount,
  names,
  busy,
  onApply,
  onClose,
}: {
  strategy: TreeRepairStrategy;
  preview: TreeRepairPreview;
  requestedCount: number;
  names: Map<string, string>;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const region = useRef<HTMLElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { region.current?.focus(); }, []);

  type Snapshot = TreeRepairPreview["changes"][number]["local"];
  const describe = (snapshot: Snapshot): string => {
    if (!snapshot) return t("treeConflict.missingStructure");
    return t("treeConflict.snapshot", {
      parent: treeParentLabel(snapshot.parentId, names, t),
      order: snapshot.sortOrder ?? "—",
      state: t(snapshot.isDeleted ? "treeConflict.deleted" : "treeConflict.active"),
    });
  };

  const exportStructure = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const exportedAt = new Date().toISOString();
      const fileName = `nowen-tree-structure-${exportedAt.replace(/[:.]/g, "-")}.json`;
      const mimeType = "application/json";
      const nodes = preview.changes.flatMap(({ local }) => local ? [{
        id: local.id,
        parentId: local.parentId,
        sortOrder: local.sortOrder,
        isDeleted: local.isDeleted,
        deletedAt: local.deletedAt,
        resourceType: local.resourceType,
        resourceId: local.resourceId,
        nodeType: local.nodeType,
      }] : []);
      const blob = new Blob([JSON.stringify({ version: 1, exportedAt, nodes }, null, 2)], { type: mimeType });
      if (isAndroidNative()) {
        await saveBlobToSystemFile({ blob, fileName, mimeType });
      } else {
        downloadBlob(blob, fileName);
      }
    } catch (err) {
      setExportError(t("treeConflict.exportFailed", { reason: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section ref={region} tabIndex={-1} aria-label={t("treeConflict.review")}
      className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
      <h5 className="font-medium">{t(strategy === "keep-local" ? "treeConflict.reviewLocal" : "treeConflict.reviewRemote", {
        count: requestedCount,
      })}</h5>
      {preview.blocked ? (
        <p role="alert" className="text-amber-700 dark:text-amber-300">
          {t("treeConflict.blocked", { reason: preview.blocked })}
        </p>
      ) : <p className="text-muted-foreground">{t("treeConflict.confirmHint")}</p>}
      {preview.changes.length > 0 ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-left">
            <thead><tr className="text-muted-foreground">
              <th scope="col">{t("treeConflict.node")}</th>
              <th scope="col">{t("treeConflict.local")}</th>
              <th scope="col">{t("treeConflict.remote")}</th>
            </tr></thead>
            <tbody>
              {preview.changes.map((change) => (
                <tr key={change.id} className="border-t align-top">
                  <th scope="row" className="break-words py-1 pr-2 font-medium">{change.title || names.get(change.local?.id ?? change.remote?.id ?? "") || t("treeConflict.untitled")}</th>
                  <td className="break-words py-1 pr-2">{describe(change.local)}</td>
                  <td className="break-words py-1">{describe(change.remote)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {exportError ? <p role="alert" className="text-destructive">{exportError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || exporting || !preview.token || Boolean(preview.blocked)} onClick={onApply}
          className="rounded bg-primary px-2.5 py-1.5 text-primary-foreground disabled:opacity-50">
          {t("treeConflict.confirm")}
        </button>
        {preview.changes.some(({ local }) => local) ? (
          <button type="button" disabled={busy || exporting} onClick={() => { void exportStructure(); }}
            className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50">
            {t("treeConflict.exportStructure")}
          </button>
        ) : null}
        <button type="button" disabled={busy || exporting} onClick={onClose}
          className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50">
          {t("treeConflict.closeReview")}
        </button>
      </div>
    </section>
  );
}

function ResolvedConflictHistory({
  items,
  total,
  entityType,
  open,
  busy,
  loadingMore,
  onToggle,
  onEntityTypeChange,
  onLoadMore,
  onView,
  onReopen,
  titleForItem,
}: {
  items: ResolvedConflictSummary[];
  total: number;
  entityType: string;
  open: boolean;
  busy: boolean;
  loadingMore: boolean;
  onToggle: () => void;
  onEntityTypeChange: (entityType: string) => void;
  onLoadMore: () => void;
  onView: (id: string) => void;
  onReopen: (item: ResolvedConflictSummary) => void;
  titleForItem: (item: ResolvedConflictSummary) => string;
}) {
  const {t}=useTranslation();
  const formatResolvedAt = (value: string) => {
    const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  };

  return (
    <section className="space-y-2 border-t pt-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <History className="h-3.5 w-3.5" />
        已解决冲突（{total}）
        <span>{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <>
          <p className="text-xs text-muted-foreground">
            撤销处理只会把记录重新放回待处理列表，不会自动回滚当前内容，也不会删除之后的新修改。
          </p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>类型</span>
            <select
              aria-label="筛选已解决冲突类型"
              value={entityType}
              disabled={busy || loadingMore}
              onChange={(event) => onEntityTypeChange(event.target.value)}
              className="rounded border bg-background px-2 py-1 text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">全部类型</option>
              {SYNC_CONFLICT_ENTITY_TYPES.map((value) => (
                <option key={value} value={value}>{value==="attachment_organization"?t("assetOrganization.syncConflictLabel"):ENTITY_TYPE_LABELS[value] || value}</option>
              ))}
            </select>
          </label>
          {items.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              没有符合当前筛选条件的已解决冲突。
            </p>
          ) : null}
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-md border border-dashed p-3 text-xs">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {titleForItem(item)}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {ENTITY_TYPE_LABELS[item.entityType] || item.entityType} · 已处理于 {formatResolvedAt(item.resolvedAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onView(item.id)}
                      className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
                    >
                      查看记录
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onReopen(item)}
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />撤销处理
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {items.length < total ? (
            <button
              type="button"
              disabled={busy || loadingMore}
              onClick={onLoadMore}
              className="inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {loadingMore ? "正在加载…" : `加载更多（已显示 ${items.length}/${total}）`}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * 差异对照。
 *
 * 只对比字段级差异并展示两侧取值。正文这类大字段做截断预览——
 * 完整逐字符 diff 属于编辑器职责，在设置页里渲染大正文只会拖慢页面。
 */
function AssetConflictFields({detail}:{detail:ConflictDetail}) {
  const {t}=useTranslation();
  const [names,setNames]=useState(new Map<string,string>());
  useEffect(()=>{
    let stale=false;
    const scope=getOfflineQueueStorageKey();
    void import("@/lib/api").then(async({api})=>{
      if(stale || scope!==getOfflineQueueStorageKey()) return;
      const {folders}=await api.attachmentFolders.list();
      if(!stale && scope===getOfflineQueueStorageKey()) setNames(new Map(folders.map(folder=>[folder.id,folder.name])));
    }).catch(()=>{ /* Unavailable folder names are shown explicitly. */ });
    return ()=>{stale=true;};
  },[detail.id]);
  const fields=["name","parentId","folderId","deleted","trashedAt"].filter(field=>
    detail.local && Object.hasOwn(detail.local,field) || detail.remote && Object.hasOwn(detail.remote,field));
  const value=(payload:Record<string,unknown>|null,field:string)=>{
    if(!payload || !Object.hasOwn(payload,field)) return "—";
    const value=payload[field];
    if(field==="parentId" || field==="folderId") return value ? names.get(String(value)) || t("assetOrganization.syncMissingFolder") : t(field==="parentId"?"assetOrganization.syncRoot":"fileExplorer.unarchived");
    if(field==="deleted") return t(value?"assetOrganization.syncDeletedState":"assetOrganization.syncActiveState");
    return value==null?"—":String(value);
  };
  return <table className="mt-2 w-full table-fixed border-collapse"><thead><tr className="text-left text-muted-foreground">
    <th>{t("assetOrganization.syncField")}</th><th>{t("assetOrganization.syncLocal")}</th><th>{t("assetOrganization.syncRemote")}</th>
  </tr></thead><tbody>{fields.map(field=><tr key={field} className="border-t align-top"><td className="py-1">{t(`assetOrganization.syncField_${field}`)}</td>
    <td className="break-words py-1">{value(detail.local,field)}</td><td className="break-words py-1">{value(detail.remote,field)}</td></tr>)}</tbody></table>;
}

function ConflictDiff({
  detail,
  busy,
  onClose,
  onManual,
  treeNames,
}: {
  detail: ConflictDetail;
  busy: boolean;
  onClose: () => void;
  onManual: (payload:Record<string,unknown>) => Promise<void>;
  treeNames: Map<string, string>;
}) {
  const {t}=useTranslation();
  const [editing,setEditing] = useState(false);
  const [draft,setDraft] = useState("");
  const [draftError,setDraftError] = useState<string|null>(null);
  const encrypted = detail.entityType === "note" && [detail.base, detail.local, detail.remote].some(isProtectedNotePayload);
  const preview = (value: unknown): string => {
    if (value === undefined || value === null) return "—";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  };

  const beginManual = () => {
    setDraft(JSON.stringify({...detail.remote,...detail.local},null,2));
    setDraftError(null);
    setEditing(true);
  };

  const submitManual = async () => {
    try {
      const payload = JSON.parse(draft) as unknown;
      if (!payload || Array.isArray(payload) || typeof payload !== "object") {
        throw new Error("合并结果必须是 JSON 对象");
      }
      setDraftError(null);
      await onManual(payload as Record<string,unknown>);
    } catch (reason) {
      setDraftError(reason instanceof Error ? reason.message : "JSON 格式不正确");
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="font-medium">差异对照</p>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          收起
        </button>
      </div>

      {isTreeConflict(detail.entityType) ? (
        <div className="mt-3 space-y-2">
          <p role="status" className="rounded border border-amber-400/40 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-300">
            {treeConflictExplanation(detail)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <p>本机结构：<strong>{detail.local ? "已存在" : "缺少/尚未同步"}</strong></p>
            <p>云端结构：<strong>{detail.remote ? "已存在" : "缺少/尚未同步"}</strong></p>
          </div>
          <p className="text-muted-foreground">
            {treeConflictAvailability(detail) === "both" ? "核对以下结构差异，再选择需要保留的版本。" : "预检会重新读取当前结构，确认所需节点与业务资源已经同步。"}
          </p>
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground"><th className="w-1/4 py-1">结构字段</th><th className="w-[37.5%] py-1">本机</th><th className="w-[37.5%] py-1">云端</th></tr>
            </thead>
            <tbody>
              {TREE_CONFLICT_FIELDS.map(([field, label]) => (
                <tr key={field} className="border-t align-top">
                  <td className="py-1">{label}</td>
                  <td className="break-all py-1">{detail.local ? (field === "parentId" ? treeParentLabel(detail.local.parentId, treeNames, t) : preview(detail.local[field])) : "尚未同步"}</td>
                  <td className="break-all py-1">{detail.remote ? (field === "parentId" ? treeParentLabel(detail.remote.parentId, treeNames, t) : preview(detail.remote[field])) : "尚未同步"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : detail.entityType==="attachment_organization" ? (
        <AssetConflictFields key={detail.id} detail={detail}/>
      ) : encrypted ? (
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div><p className="font-medium">本机版本</p><p className="mt-1">{String(detail.local?.title || "加密笔记")}</p><p className="text-muted-foreground">🔒 加密内容</p></div>
          <div><p className="font-medium">云端版本</p><p className="mt-1">{String(detail.remote?.title || "加密笔记")}</p><p className="text-muted-foreground">🔒 加密内容</p></div>
        </div>
      ) : detail.diffFields.length === 0 ? (
        <p className="mt-2 text-muted-foreground">两侧内容一致，可能只是版本号不同。</p>
      ) : (
        <table className="mt-2 w-full table-fixed border-collapse">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-1/5 py-1">字段</th>
              <th className="w-2/5 py-1">本机</th>
              <th className="w-2/5 py-1">云端</th>
            </tr>
          </thead>
          <tbody>
            {detail.diffFields.map((field) => (
              <tr key={field} className="border-t align-top">
                <td className="py-1 font-mono">{field}</td>
                <td className="py-1 break-words">{preview(detail.local?.[field])}</td>
                <td className="py-1 break-words">{preview(detail.remote?.[field])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail.status === "resolved" ? (
        <p className="mt-3 border-t pt-3 text-muted-foreground">
          这是已解决冲突的历史记录。如需重新选择版本，请先点击“撤销处理”。
        </p>
      ) : isTreeConflict(detail.entityType) ? (
        <p className="mt-3 border-t pt-3 text-muted-foreground">
          {isTreeLifecycleConflict(detail)
            ? t(canResolveNativeTreeLifecycle(detail, "keep-remote") || canResolveNativeTreeLifecycle(detail, "keep-local")
              ? "treeConflict.nativeLifecycleHint" : "treeConflict.lifecycleHint")
            : t("treeConflict.previewHint")}
        </p>
      ) : detail.entityType==="attachment_organization" ? (
        <p className="mt-3 border-t pt-3 text-muted-foreground">{t("assetOrganization.syncConflictHint")}</p>
      ) : encrypted ? (
        <p className="mt-3 border-t pt-3 text-muted-foreground">
          请选择保留本机版本或云端版本。另一个版本会保留在历史记录中。
        </p>
      ) : editing ? (
        <div className="mt-3 space-y-2 border-t pt-3">
          <p className="font-medium">编辑最终合并结果</p>
          <p className="text-muted-foreground">已用本机字段覆盖服务器字段作为初稿。可直接修改任意字段，保存后会作为一个新版本同步。</p>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false}
            className="min-h-56 w-full resize-y rounded border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" />
          {draftError ? <p className="text-destructive">{draftError}</p> : null}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => { void submitManual(); }}
              className="rounded bg-primary px-2.5 py-1.5 text-primary-foreground disabled:opacity-50">
              {busy ? "正在保存…" : "保存合并结果"}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded border px-2.5 py-1.5">取消</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={beginManual}
          className="mt-3 inline-flex items-center gap-1 rounded border px-2.5 py-1.5 hover:bg-accent">
          <Merge className="h-3.5 w-3.5" />手动编辑并合并
        </button>
      )}
    </div>
  );
}
