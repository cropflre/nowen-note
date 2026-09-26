import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, RotateCcw, Trash2 } from "lucide-react";

import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";

export function deletedMindmapRestorePath(node: KnowledgeTreeNode, nodes: KnowledgeTreeNode[]): KnowledgeTreeNode[] {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const path = [node];
  let target = node;
  while (target.parentId) {
    const parent = byId.get(target.parentId);
    if (!parent?.isDeleted) break;
    path.unshift(parent);
    target = parent;
  }
  return path;
}

export default function MindmapTrashSection({
  workspaceId,
  onCountChange,
}: {
  workspaceId: string;
  onCountChange: (count: number | null) => void;
}) {
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await knowledgeTreeApi.listForWorkspace(workspaceId, true);
      setNodes(result.nodes);
      onCountChange(result.nodes.filter((node) => node.resourceType === "mindmap" && node.isDeleted).length);
      setError(false);
    } catch {
      onCountChange(null);
      setError(true);
    }
  }, [workspaceId, onCountChange]);

  useEffect(() => {
    void reload();
    window.addEventListener("nowen:knowledge-tree-changed", reload);
    return () => window.removeEventListener("nowen:knowledge-tree-changed", reload);
  }, [reload]);

  const maps = nodes.filter((node) => node.resourceType === "mindmap" && node.isDeleted);

  const restore = async (node: KnowledgeTreeNode) => {
    const path = deletedMindmapRestorePath(node, nodes);
    if (path.length > 1 && !await confirm({
      title: "恢复所在文件夹？",
      description: `“${node.title}”所在文件夹也在回收站，恢复时会一并恢复该文件夹中同时删除的内容。`,
      confirmText: "恢复文件夹",
    })) return;
    setBusyId(node.id);
    let changed = false;
    try {
      const restored = new Set<string>();
      for (const target of path) {
        if (restored.has(target.id)) continue;
        const result = await knowledgeTreeApi.restore(target.id);
        changed = true;
        result.restoredNodeIds.forEach((id) => restored.add(id));
      }
      emitKnowledgeTreeRefresh("mindmap-restored");
      toast.success("已恢复思维导图");
    } catch (cause) {
      if (changed) emitKnowledgeTreeRefresh("mindmap-restore-partial");
      toast.error(cause instanceof Error ? cause.message : "恢复思维导图失败");
    } finally {
      setBusyId(null);
    }
  };

  const removePermanently = async (node: KnowledgeTreeNode) => {
    if (!await confirm({
      title: "永久删除思维导图？",
      description: `“${node.title}”将无法恢复。`,
      confirmText: "永久删除",
      danger: true,
    })) return;
    setBusyId(node.id);
    try {
      await api.deleteMindMapPermanently(node.resourceId);
      emitKnowledgeTreeRefresh("mindmap-permanently-deleted");
      toast.success("已永久删除思维导图");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "删除思维导图失败");
    } finally {
      setBusyId(null);
    }
  };

  if (error) return <div className="px-4 py-2 text-xs text-accent-danger">脑图回收站加载失败。<button onClick={() => void reload()} className="underline">重试</button></div>;
  if (!maps.length) return null;
  return (
    <section className="border-b border-app-border/50 px-3 py-2" aria-label="已删除的思维导图">
      <p className="mb-1 px-1 text-xs font-medium text-tx-secondary">思维导图 · {maps.length}</p>
      {maps.map((node) => (
        <div key={node.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-app-hover">
          <BrainCircuit size={15} className="shrink-0 text-tx-tertiary" />
          <span className="min-w-0 flex-1 truncate text-sm text-tx-primary" title={node.title}>{node.title}</span>
          {node.access.capabilities.canDelete && (
            <>
              <button type="button" disabled={busyId !== null} onClick={() => void restore(node)}
                className="rounded p-1 text-tx-secondary hover:bg-app-active disabled:opacity-50" title="恢复脑图" aria-label={`恢复${node.title}`}>
                <RotateCcw size={15} />
              </button>
              <button type="button" disabled={busyId !== null} onClick={() => void removePermanently(node)}
                className="rounded p-1 text-accent-danger hover:bg-accent-danger/10 disabled:opacity-50" title="永久删除脑图" aria-label={`永久删除${node.title}`}>
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
