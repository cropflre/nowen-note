import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, GitCompare, Loader2, Merge } from "lucide-react";
import {
  fetchConflictDetail,
  fetchConflicts,
  forkConflict,
  resolveConflict,
  type ConflictDetail,
  type ConflictSummary,
} from "@/lib/syncLocalApi";

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
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ConflictDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchConflicts();
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

  if (items.length === 0) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium">冲突</h3>
        <p className="text-xs text-muted-foreground">没有需要处理的冲突。</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <GitCompare className="h-4 w-4" />
        冲突（{items.length}）
      </h3>
      <p className="text-xs text-muted-foreground">
        同一条内容在两处被分别修改。两个版本都完整保留，请选择要采用哪一个。
      </p>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="rounded-md border p-3 text-xs">
            <div className="flex items-start justify-between gap-2">
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

      {error ? (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {selected ? (
        <ConflictDiff detail={selected} busy={busy} onClose={() => setSelected(null)}
          onManual={(payload) => handleManualResolve(selected.id,payload)} />
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
      {editing ? <div className="mt-3 space-y-2 border-t pt-3">
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
      </div> : <button type="button" onClick={beginManual}
        className="mt-3 inline-flex items-center gap-1 rounded border px-2.5 py-1.5 hover:bg-accent">
        <Merge className="h-3.5 w-3.5" />手动编辑并合并
      </button>}
    </div>
  );
}
