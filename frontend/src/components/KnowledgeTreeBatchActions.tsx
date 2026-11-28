import { useMemo, useState } from "react";
import { FileText, Folder, FolderInput, Loader2, Search, Trash2, TreePine, X } from "lucide-react";

import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  knowledgeTreeDescendantIds,
  topLevelSelectedKnowledgeNodes,
} from "@/lib/knowledgeTreeMultiSelect";
import {
  KNOWLEDGE_TREE_SORT_OPTIONS,
  loadKnowledgeTreeSortMode,
  sortKnowledgeTreeMoveTargets,
  type KnowledgeTreeSortMode,
} from "@/lib/knowledgeTreeSort";
import { buildMobileKnowledgeTreePath } from "@/lib/mobileKnowledgeTree";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function KnowledgeTreeBatchToolbar({
  count,
  canMove,
  canDelete,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  canMove: boolean;
  canDelete: boolean;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mx-2 mb-1 flex h-9 shrink-0 items-center gap-1 rounded-lg border border-accent-primary/20 bg-accent-primary/5 px-2 text-xs text-tx-secondary">
      <span className="min-w-0 flex-1 truncate font-medium">已选择 {count} 项</span>
      <button type="button" disabled={!canMove || count === 0} onClick={onMove} className="inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40">
        <FolderInput size={13} />移动
      </button>
      <button type="button" disabled={!canDelete || count === 0} onClick={onDelete} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40">
        <Trash2 size={13} />删除
      </button>
      <button type="button" onClick={onClear} className="flex h-7 w-7 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" aria-label="取消选择" title="取消选择">
        <X size={14} />
      </button>
    </div>
  );
}

export function KnowledgeTreeBatchMovePanel({
  selectedNodes,
  nodes,
  targetNodes,
  sortMode = loadKnowledgeTreeSortMode(),
  onMoved,
  onClose,
}: {
  selectedNodes: KnowledgeTreeNode[];
  nodes: KnowledgeTreeNode[];
  targetNodes: KnowledgeTreeNode[];
  sortMode?: KnowledgeTreeSortMode;
  onMoved: (movedNodeIds: string[]) => void;
  onClose: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [foldersOnly, setFoldersOnly] = useState(false);
  const roots = useMemo(
    () => topLevelSelectedKnowledgeNodes(nodes, selectedNodes.map((node) => node.id)),
    [nodes, selectedNodes],
  );
  const blocked = useMemo(
    () => knowledgeTreeDescendantIds(roots.map((node) => node.id), nodes),
    [nodes, roots],
  );
  const sortedCandidates = useMemo(() => sortKnowledgeTreeMoveTargets(
    targetNodes.filter((candidate) => (
      !blocked.has(candidate.id)
      && candidate.access.capabilities.canCreate
      && roots.every((source) => (
        source.scopeKey === candidate.scopeKey
        && (source.sharedRootId
          ? source.sharedRootId === candidate.sharedRootId
          : !candidate.sharedRootId)
      ))
    )),
    sortMode,
    nodes,
  ), [blocked, nodes, roots, sortMode, targetNodes]);
  const candidates = useMemo(() => {
    const keyword = filterQuery.trim().toLocaleLowerCase();
    return sortedCandidates.filter((candidate) => {
      if (foldersOnly && candidate.nodeType !== "folder") return false;
      if (!keyword) return true;
      if (candidate.title.toLocaleLowerCase().includes(keyword)) return true;
      const parentPath = candidate.parentId ? buildMobileKnowledgeTreePath(candidate, nodes) : "";
      return parentPath.toLocaleLowerCase().includes(keyword);
    });
  }, [filterQuery, foldersOnly, nodes, sortedCandidates]);
  const sortLabel = KNOWLEDGE_TREE_SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? "手动排序";
  const allowRoot = roots.length > 0 && roots.every((node) => !node.sharedRootId) && !filterQuery.trim();

  const move = async (parentId: string | null) => {
    if (roots.length === 0 || moving) return;
    if (roots.every((node) => (node.parentId ?? null) === parentId)) {
      onClose();
      return;
    }
    setMoving(true);
    try {
      const result = await knowledgeTreeApi.batchMove(roots.map((node) => node.id), { parentId });
      toast.success(`已移动 ${selectedNodes.length} 项`);
      onMoved(result.nodeIds);
      onClose();
    } catch (error: any) {
      toast.error(error?.message || "批量移动失败");
    } finally {
      setMoving(false);
    }
  };

  return (
    <div data-knowledge-tree-batch-move-panel="" className="absolute inset-0 z-30 flex flex-col bg-app-sidebar" onClick={(event) => event.stopPropagation()}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-app-border px-3">
        <FolderInput size={16} className="shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">移动 {selectedNodes.length} 项</div>
        {moving && <Loader2 size={14} className="shrink-0 animate-spin text-tx-tertiary" />}
        <button type="button" disabled={moving} onClick={onClose} className="shrink-0 rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover disabled:opacity-40" aria-label="关闭移动面板"><X size={16} /></button>
      </header>
      <div className="shrink-0 space-y-1.5 border-b border-app-border/70 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
            <input
              type="text"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder="搜索目标文件夹或文档..."
              aria-label="搜索移动目标"
              className="h-8 w-full rounded-md border border-app-border bg-app-bg pl-7 pr-7 text-xs text-tx-primary placeholder:text-tx-tertiary outline-none focus:border-accent-primary"
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => setFilterQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                aria-label="清空目标搜索"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFoldersOnly((current) => !current)}
            aria-pressed={foldersOnly}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
              foldersOnly
                ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
                : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
            )}
          >
            <Folder size={12} className="shrink-0" />
            <span>仅文件夹</span>
          </button>
        </div>
        <div className="flex items-center justify-between px-0.5 text-[11px] text-tx-tertiary">
          <span>文件夹优先 · {sortLabel}</span>
          <span className="tabular-nums">{candidates.length} 项</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {allowRoot && (
          <button type="button" disabled={moving || roots.every((node) => node.parentId === null)} onClick={() => void move(null)} className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40">
            <TreePine size={15} className="shrink-0 text-accent-primary" /><span className="min-w-0 flex-1 truncate">根目录</span>
          </button>
        )}
        {candidates.map((candidate) => {
          const parentPath = candidate.parentId ? buildMobileKnowledgeTreePath(candidate, nodes) : "";
          return (
            <button
              key={candidate.id}
              type="button"
              disabled={moving || roots.every((node) => node.parentId === candidate.id)}
              onClick={() => void move(candidate.id)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
              title={parentPath ? `${parentPath} / ${candidate.title}` : candidate.title}
            >
              {candidate.nodeType === "folder" ? <Folder size={15} className="shrink-0 text-amber-500" /> : <FileText size={15} className="shrink-0 text-accent-primary" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{candidate.title}</span>
                {parentPath && (
                  <span className="block truncate text-[11px] text-tx-tertiary">{parentPath}</span>
                )}
              </span>
            </button>
          );
        })}
        {candidates.length === 0 && !allowRoot && <p className="py-10 text-center text-xs text-tx-tertiary">没有可用目标节点</p>}
      </div>
    </div>
  );
}
