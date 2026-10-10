import React, { useMemo, useState } from "react";
import { BrainCircuit, Folder, Loader2, Plus, Search, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { buildMindMapOverviewItems, getMindMapCreationLocations, type MindMapOverviewFilter } from "@/lib/mindMapOverview";
import { loadMobileKnowledgeTreeRecentEntries } from "@/lib/mobileKnowledgeTree";
import type { MindMapListItem } from "@/types";
import { cn } from "@/lib/utils";

export default function MindMapOverview({
  maps,
  treeNodes,
  loading,
  onOpen,
  onCreate,
  onToggleStar,
  onDelete,
  onContextMenu,
}: {
  maps: MindMapListItem[];
  treeNodes: KnowledgeTreeNode[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onToggleStar: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, map: MindMapListItem) => void;
}) {
  const { i18n } = useTranslation();
  const isZh = (i18n.resolvedLanguage || i18n.language || "zh").startsWith("zh");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MindMapOverviewFilter>("all");
  const [parentId, setParentId] = useState<string | null>(null);
  const [recentEntries] = useState(() => loadMobileKnowledgeTreeRecentEntries());
  const locations = useMemo(() => getMindMapCreationLocations(treeNodes), [treeNodes]);
  const selectedParentId = parentId && locations.some((location) => location.id === parentId) ? parentId : null;
  const rows = useMemo(() => buildMindMapOverviewItems(maps, treeNodes, recentEntries, query, filter),
    [maps, treeNodes, recentEntries, query, filter]);

  return (
    <section className="h-full w-full overflow-y-auto bg-app-bg px-4 py-6 text-tx-primary md:px-8 md:py-8" aria-label={isZh ? "全部脑图" : "All mind maps"}>
      <div className="mx-auto max-w-[960px]">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><BrainCircuit size={22} className="text-accent-primary" />{isZh ? "全部脑图" : "All mind maps"}</h1>
            <p className="mt-1 text-sm text-tx-secondary">{isZh ? `共 ${maps.length} 张脑图 · 与笔记共用左侧目录` : `${maps.length} mind maps · Organized in the same tree as notes`}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-tx-secondary" htmlFor="mindmap-create-location">{isZh ? "保存到" : "Save in"}</label>
            <select
              id="mindmap-create-location"
              value={selectedParentId || ""}
              onChange={(event) => setParentId(event.target.value || null)}
              className="max-w-[230px] rounded-lg border border-app-border bg-app-surface px-2 py-2 text-sm text-tx-primary"
            >
              <option value="">{isZh ? "当前空间根目录" : "Workspace root"}</option>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.path}</option>)}
            </select>
            <button type="button" onClick={() => onCreate(selectedParentId)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-tx-inverse hover:opacity-90">
              <Plus size={16} />{isZh ? "新建脑图" : "New mind map"}
            </button>
          </div>
        </header>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2">
            <Search size={16} className="shrink-0 text-tx-tertiary" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isZh ? "搜索脑图或所在目录" : "Search mind maps or folders"} aria-label={isZh ? "搜索脑图" : "Search mind maps"} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-tx-tertiary" />
          </label>
          <div className="inline-flex rounded-lg border border-app-border bg-app-surface p-1" aria-label={isZh ? "脑图筛选" : "Mind map filter"}>
            {(["all", "recent", "starred"] as const).map((value) => (
              <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={cn("rounded-md px-3 py-1.5 text-xs", filter === value ? "bg-accent-primary/10 font-medium text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}>
                {value === "all" ? (isZh ? "全部" : "All") : value === "recent" ? (isZh ? "最近使用" : "Recent") : (isZh ? "收藏" : "Favorites")}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20 text-tx-tertiary" role="status"><Loader2 size={22} className="animate-spin" /></div>
        ) : rows.length === 0 ? (
          <div className="py-20 text-center text-sm text-tx-tertiary">{maps.length === 0 ? (isZh ? "还没有脑图，可从左侧目录或这里新建" : "No mind maps yet. Create one here or in the tree.") : (isZh ? "没有匹配的脑图" : "No matching mind maps")}</div>
        ) : (
          <div className="mt-4 space-y-2 pb-8">
            {rows.map(({ map, path }) => (
              <div key={map.id} className="group flex items-center gap-2 rounded-xl border border-app-border bg-app-surface p-3 hover:border-accent-primary/40" onContextMenu={(event) => onContextMenu(event, map)}>
                <button type="button" onClick={() => onOpen(map.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary"><BrainCircuit size={19} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{map.title}</span>
                    <span className="mt-1 flex items-center gap-1 truncate text-xs text-tx-tertiary"><Folder size={12} className="shrink-0" />{path}</span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-tx-tertiary sm:inline">{new Date(map.updatedAt).toLocaleDateString()}</span>
                </button>
                <button type="button" onClick={() => onToggleStar(map.id)} aria-label={map.starred ? (isZh ? "取消收藏" : "Remove favorite") : (isZh ? "收藏" : "Favorite")} className="rounded-md p-2 text-tx-tertiary hover:bg-app-hover hover:text-amber-500"><Star size={16} className={map.starred ? "fill-amber-400 text-amber-400" : ""} /></button>
                <button type="button" onClick={() => { if (window.confirm(isZh ? `将“${map.title}”移入回收站？` : `Move “${map.title}” to Trash?`)) onDelete(map.id); }} aria-label={isZh ? "删除脑图" : "Delete mind map"} className="rounded-md p-2 text-tx-tertiary hover:bg-app-hover hover:text-accent-danger"><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
