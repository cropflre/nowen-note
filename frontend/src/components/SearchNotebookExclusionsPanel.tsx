import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FolderArchive, Loader2, RotateCcw, SearchX } from "lucide-react";

import {
  includeNotebookInSearch,
  listSearchNotebookExclusions,
  SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT,
  type SearchNotebookExclusion,
  type SearchNotebookExclusionList,
} from "@/lib/searchNotebookExclusions";
import { toast } from "@/lib/toast";
import { useApp } from "@/store/AppContext";

interface Props {
  includeExcluded: boolean;
  onIncludeExcludedChange: (value: boolean) => void;
  onScopeChanged: () => void;
}

export default function SearchNotebookExclusionsPanel({
  includeExcluded,
  onIncludeExcludedChange,
  onScopeChanged,
}: Props) {
  const { state } = useApp();
  const [data, setData] = useState<SearchNotebookExclusionList | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listSearchNotebookExclusions());
    } catch (error: any) {
      console.warn("[SearchNotebookExclusionsPanel] load failed", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = () => void reload();
    window.addEventListener(SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT, onChanged);
  }, [reload]);

  const paths = useMemo(() => {
    const byId = new Map(state.notebooks.map((notebook) => [notebook.id, notebook]));
    const result = new Map<string, string>();
    const resolve = (id: string) => {
      if (result.has(id)) return result.get(id)!;
      const labels: string[] = [];
      const visited = new Set<string>();
      let cursor: string | null | undefined = id;
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const notebook = byId.get(cursor);
        if (!notebook) break;
        labels.unshift(notebook.name);
        cursor = notebook.parentId;
      }
      const path = labels.join(" / ");
      result.set(id, path);
      return path;
    };
    for (const item of data?.direct || []) resolve(item.notebookId);
    return result;
  }, [data?.direct, state.notebooks]);

  const restore = async (item: SearchNotebookExclusion) => {
    if (restoringId) return;
    setRestoringId(item.notebookId);
    try {
      await includeNotebookInSearch(item.notebookId);
      await reload();
      onScopeChanged();
      toast.success(`“${item.name}”已重新纳入全局搜索`);
    } catch (error: any) {
      toast.error(error?.message || "恢复搜索范围失败");
    } finally {
      setRestoringId(null);
    }
  };

  if (!loading && (!data || data.directCount === 0)) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-app-border bg-app-surface" data-search-exclusions-panel="true">
      <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between md:px-4">
        <div className="flex min-w-0 items-center gap-2 text-xs text-tx-secondary">
          <SearchX size={15} className="shrink-0 text-amber-500" />
          {loading && !data ? (
            <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />读取搜索范围…</span>
          ) : (
            <span>
              已跳过 <strong className="font-semibold text-tx-primary">{data?.effectiveNotebookCount || data?.directCount || 0}</strong> 个笔记本
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-tx-secondary hover:bg-app-hover">
            <input
              type="checkbox"
              checked={includeExcluded}
              onChange={(event) => onIncludeExcludedChange(event.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
            />
            本次搜索包含已排除笔记本
          </label>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-accent-primary hover:bg-accent-primary/10"
          >
            管理已排除笔记本
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-app-border px-3 py-3 md:px-4">
          <div className="mb-2 text-[11px] leading-5 text-tx-tertiary">
            排除仅影响你自己的全局全文搜索，不会删除、隐藏或修改这些笔记本。父目录规则默认包含所有子目录。
          </div>
          <div className="space-y-2">
            {(data?.direct || []).map((item) => (
              <div key={item.notebookId} className="flex items-center gap-3 rounded-xl bg-app-bg/80 px-3 py-2.5 ring-1 ring-app-border/70">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
                  <FolderArchive size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-tx-primary">{item.icon || "📁"} {item.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-tx-tertiary" title={paths.get(item.notebookId) || item.name}>
                    {paths.get(item.notebookId) || item.name} · 包含子目录
                  </div>
                </div>
                <button
                  type="button"
                  disabled={restoringId !== null}
                  onClick={() => void restore(item)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent-primary hover:bg-accent-primary/10 disabled:opacity-40"
                >
                  {restoringId === item.notebookId ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  重新纳入
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
