import { useMemo, useState } from "react";
import { FileText, Folder, FolderInput, Loader2, Trash2, TreePine, X } from "lucide-react";

import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  knowledgeTreeDescendantIds,
  topLevelSelectedKnowledgeNodes,
} from "@/lib/knowledgeTreeMultiSelect";
import { toast } from "@/lib/toast";

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
  onMoved,
  onClose,
}: {
  selectedNodes: KnowledgeTreeNode[];
  nodes: KnowledgeTreeNode[];
  targetNodes: KnowledgeTreeNode[];
  onMoved: (movedNodeIds: string[]) => void;
  onClose: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const roots = useMemo(
    () => topLevelSelectedKnowledgeNodes(nodes, selectedNodes.map((node) => node.id)),
    [nodes, selectedNodes],
  );
  const blocked = useMemo(
    () => knowledgeTreeDescendantIds(roots.map((node) => node.id), nodes),
    [nodes, roots],
  );
  const candidates = useMemo(() => targetNodes.filter((candidate) => (
    !blocked.has(candidate.id)
    && candidate.access.capabilities.canCreate
    && roots.every((source) => (
      source.scopeKey === candidate.scopeKey
      && (source.sharedRootId
        ? source.sharedRootId === candidate.sharedRootId
        : !candidate.sharedRootId)
    ))
  )).sort((left, right) => left.title.localeCompare(right.title)), [blocked, roots, targetNodes]);
  const allowRoot = roots.length > 0 && roots.every((node) => !node.sharedRootId);

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
    <div className="absolute inset-0 z-[220] flex flex-col bg-app-sidebar" onClick={(event) => event.stopPropagation()}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-app-border px-3">
        <FolderInput size={16} className="text-amber-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">移动 {selectedNodes.length} 项</div>
        {moving && <Loader2 size={14} className="animate-spin text-tx-tertiary" />}
        <button type="button" disabled={moving} onClick={onClose} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover disabled:opacity-40" aria-label="关闭移动面板"><X size={16} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {allowRoot && (
          <button type="button" disabled={moving || roots.every((node) => node.parentId === null)} onClick={() => void move(null)} className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40">
            <TreePine size={15} className="text-accent-primary" /><span className="truncate">根目录</span>
          </button>
        )}
        {candidates.map((candidate) => (
          <button key={candidate.id} type="button" disabled={moving || roots.every((node) => node.parentId === candidate.id)} onClick={() => void move(candidate.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40">
            {candidate.nodeType === "folder" ? <Folder size={15} className="shrink-0 text-amber-500" /> : <FileText size={15} className="shrink-0 text-accent-primary" />}
            <span className="truncate">{candidate.title}</span>
          </button>
        ))}
        {candidates.length === 0 && !allowRoot && <p className="py-10 text-center text-xs text-tx-tertiary">没有可用目标节点</p>}
      </div>
    </div>
  );
}
