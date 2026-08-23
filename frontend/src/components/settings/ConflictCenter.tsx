import { useCallback, useEffect, useState } from "react";
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
  fetchConflictDetail,
  fetchConflicts,
  fetchResolvedConflicts,
  forkConflict,
  reopenConflict,
  resolveConflict,
  SYNC_CONFLICT_ENTITY_TYPES,
  type ConflictDetail,
  type ConflictSummary,
  type ResolvedConflictSummary,
} from "@/lib/syncLocalApi";
import { buildAutomaticConflictMerge } from "@/lib/syncConflictAutoMerge";

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
  const [items, setItems] = useState<ConflictSummary[]>([]);
  const [historyItems, setHistoryItems] = useState<ResolvedConflictSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyEntityType, setHistoryEntityType] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ConflictDetail | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [result, history] = await Promise.all([
        fetchConflicts(),
        fetchResolvedConflicts({
          limit: HISTORY_PAGE_SIZE,
          offset: 0,
          entityType: historyEntityType || undefined,
        }),
      ]);
      setItems(result.items);
      setHistoryItems(history.items);
      setHistoryTotal(history.total);
      const availableIds = new Set(result.items.map((item) => item.id));
      setSelectedIds((current) => new Set(
        [...current].filter((id) => availableIds.has(id)),
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [historyEntityType]);

  useEffect(() => { void reload(); }, [reload]);

  const openDetail = async (id: string) => {
    setError(null);
    try {
      setSelected(await fetchConflictDetail(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResolve = async (
    id: string,
    resolution: "keep-local" | "keep-remote",
  ) => {
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
      setError(err instanceof Error ? err.message : String(err));
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

  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };

  const toggleItem = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkResolve = async (resolution: "keep-local" | "keep-remote") => {
    const targets = items.filter((item) => selectedIds.has(item.id));
    if (targets.length === 0) return;

    const sourceLabel = resolution === "keep-local" ? "本机" : "服务器";
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
    const targets = items.filter((item) => selectedIds.has(item.id));
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
    const title = item.localTitle || item.remoteTitle || item.entityId;
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
      <p className="text-xs text-muted-foreground">
        同一条内容在两处被分别修改。两个版本都完整保留，请选择要采用哪一个。
      </p>

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
            disabled={busy || selectedIds.size === 0}
            onClick={() => { void handleAutomaticMerge(); }}
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1.5 text-primary-foreground disabled:opacity-50"
            title="只自动合并双方修改字段不重叠的冲突"
          >
            <Merge className="h-3.5 w-3.5" />
            {busy ? "处理中…" : "智能合并选中项"}
          </button>
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={() => { void handleBulkResolve("keep-local"); }}
            className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50"
          >
            {busy ? "处理中…" : "一键采用本机"}
          </button>
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={() => { void handleBulkResolve("keep-remote"); }}
            className="rounded border px-2.5 py-1.5 hover:bg-accent disabled:opacity-50"
          >
            {busy ? "处理中…" : "一键采用服务器"}
          </button>
        </div>
      </div>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="rounded-md border p-3 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  disabled={busy}
                  onChange={() => toggleItem(item.id)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                  aria-label={`选择冲突 ${item.localTitle || item.remoteTitle || item.entityId}`}
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {item.localTitle || item.remoteTitle || item.entityId}
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    {item.entityType} · 本机 v{item.localVersion ?? "?"} ·
                    {" "}服务器 v{item.remoteVersion ?? "?"}
                    {item.diffFields.length > 0
                      ? ` · 差异：${item.diffFields.slice(0, 4).join("、")}`
                      : ""}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { void openDetail(item.id); }}
                className="shrink-0 rounded border px-2 py-1 hover:bg-accent"
              >
                查看
              </button>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => { void handleResolve(item.id, "keep-local"); }}
                className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              >
                保留本机
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { void handleResolve(item.id, "keep-remote"); }}
                className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              >
                保留服务器
              </button>
              <button type="button" disabled={busy}
                onClick={() => { void openDetail(item.id); }}
                className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50">
                <Merge className="h-3.5 w-3.5" />手动合并
              </button>
              {item.entityType === "note" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void handleFork(item.id, "remote"); }}
                  className="rounded border px-2 py-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
                  title="把服务器版本另存为一条新笔记，两个版本都保留"
                >
                  另存服务器版本
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
        </>
      )}

      {warning ? (
        <p className="flex items-start gap-2 text-xs text-amber-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {warning}
        </p>
      ) : null}

      {error ? (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="flex items-start gap-2 text-xs text-emerald-600">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {notice}
        </p>
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
          onReopen={(item) => { void handleReopen(item); }}
        />
      ) : null}

      {selected ? (
        <ConflictDiff detail={selected} busy={busy} onClose={() => setSelected(null)}
          onManual={(payload) => handleManualResolve(selected.id,payload)} />
      ) : null}
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
}) {
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
                <option key={value} value={value}>{ENTITY_TYPE_LABELS[value] || value}</option>
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
                      {item.localTitle || item.remoteTitle || item.entityId}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {item.entityType} · 已处理于 {formatResolvedAt(item.resolvedAt)}
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
function ConflictDiff({
  detail,
  busy,
  onClose,
  onManual,
}: {
  detail: ConflictDetail;
  busy: boolean;
  onClose: () => void;
  onManual: (payload:Record<string,unknown>) => Promise<void>;
}) {
  const [editing,setEditing] = useState(false);
  const [draft,setDraft] = useState("");
  const [draftError,setDraftError] = useState<string|null>(null);
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

      {detail.diffFields.length === 0 ? (
        <p className="mt-2 text-muted-foreground">两侧内容一致，可能只是版本号不同。</p>
      ) : (
        <table className="mt-2 w-full table-fixed border-collapse">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-1/5 py-1">字段</th>
              <th className="w-2/5 py-1">本机</th>
              <th className="w-2/5 py-1">服务器</th>
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
