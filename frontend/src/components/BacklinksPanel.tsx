import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, FileText, GitBranch, Link2, Loader2, Network, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { openInternalNoteLink } from "@/lib/blockNavigation";
import { cn } from "@/lib/utils";

interface BacklinksPanelProps { noteId: string; noteTitle: string; onClose: () => void; }
interface BacklinkItem { sourceNoteId: string; sourceBlockId: string | null; sourceNotebookId: string; title: string; updatedAt: string; linkText: string | null; linkType: "note" | "block"; targetBlockId: string | null; excerpt: string | null; }

export default function BacklinksPanel({ noteId, noteTitle, onClose }: BacklinksPanelProps) {
  const [tab, setTab] = useState<"links" | "graph">("links");
  const [backlinks, setBacklinks] = useState<BacklinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [graph, setGraph] = useState<any>({ nodes: [], edges: [] });
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphScope, setGraphScope] = useState<"local" | "global">("local");
  const [edgeType, setEdgeType] = useState<"all" | "note" | "block">("all");

  const loadLinks = useCallback(async () => {
    setLoading(true);
    try { const data = await api.getBacklinks(noteId, 200); setBacklinks(data.backlinks || []); }
    finally { setLoading(false); }
  }, [noteId]);
  useEffect(() => { void loadLinks(); }, [loadLinks]);
  useEffect(() => {
    if (tab !== "graph") return;
    let alive = true; setGraphLoading(true);
    api.getKnowledgeGraph(graphScope === "local" ? noteId : undefined).then((data) => alive && setGraph(data), () => alive && setGraph({ nodes: [], edges: [] })).finally(() => alive && setGraphLoading(false));
    return () => { alive = false; };
  }, [graphScope, noteId, tab]);

  const groups = useMemo(() => {
    const map = new Map<string, { title: string; items: BacklinkItem[] }>();
    for (const item of backlinks) {
      const group = map.get(item.sourceNoteId) || { title: item.title || "无标题笔记", items: [] };
      group.items.push(item); map.set(item.sourceNoteId, group);
    }
    return Array.from(map.entries());
  }, [backlinks]);
  const filteredEdges = useMemo(() => graph.edges.filter((edge: any) => edgeType === "all" || edge.linkType === edgeType), [edgeType, graph.edges]);
  const visibleNodeIds = new Set(filteredEdges.flatMap((edge: any) => [edge.sourceNoteId, edge.targetNoteId]));
  const graphNodes = graph.nodes.filter((node: any) => visibleNodeIds.has(node.id) || node.id === noteId);
  const positions = new Map(graphNodes.map((node: any, index: number) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, graphNodes.length) - Math.PI / 2;
    return [node.id, { x: 210 + Math.cos(angle) * 145, y: 190 + Math.sin(angle) * 135 }];
  }));

  return <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-app-border bg-app-surface shadow-2xl sm:w-[430px]">
    <div className="flex items-center justify-between border-b border-app-border px-4 py-3"><div><div className="flex items-center gap-2 text-sm font-medium"><Link2 size={16} className="text-accent-primary" />知识关系</div><div className="mt-0.5 max-w-72 truncate text-[11px] text-tx-tertiary">{noteTitle}</div></div><Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X size={15} /></Button></div>
    <div className="grid grid-cols-2 border-b border-app-border p-1"><button className={cn("rounded-md py-1.5 text-xs", tab === "links" ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover")} onClick={() => setTab("links")}>反向链接 {backlinks.length}</button><button className={cn("rounded-md py-1.5 text-xs", tab === "graph" ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover")} onClick={() => setTab("graph")}>关系图谱</button></div>
    {tab === "links" ? <ScrollArea className="flex-1"><div className="p-3">{loading ? <div className="flex justify-center py-10"><Loader2 className="animate-spin" /></div> : groups.length === 0 ? <div className="py-12 text-center text-xs text-tx-tertiary">暂无反向链接</div> : <div className="space-y-2">{groups.map(([sourceNoteId, group]) => { const open = expanded.has(sourceNoteId) || group.items.length === 1; return <div key={sourceNoteId} className="overflow-hidden rounded-xl border border-app-border"><button className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-app-hover" onClick={() => setExpanded((current) => { const next = new Set(current); next.has(sourceNoteId) ? next.delete(sourceNoteId) : next.add(sourceNoteId); return next; })}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FileText size={14} className="text-accent-primary" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{group.title}</span><span className="text-[10px] text-tx-tertiary">{group.items.length}</span></button>{open && <div className="border-t border-app-border p-1">{group.items.map((item, index) => <button key={`${item.sourceBlockId || "note"}-${index}`} onClick={() => openInternalNoteLink(`note:${item.sourceNoteId}${item.sourceBlockId ? `#blk:${item.sourceBlockId}` : ""}`)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-app-hover"><div className="flex items-center gap-2"><span className="rounded bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary">{item.linkType === "block" ? "块引用" : "笔记引用"}</span>{item.sourceBlockId && <span className="truncate text-[10px] text-tx-tertiary">{item.sourceBlockId}</span>}</div><p className="mt-1 line-clamp-3 text-xs leading-5 text-tx-secondary">{item.excerpt || item.linkText || "无上下文"}</p></button>)}</div>}</div>; })}</div>}</div></ScrollArea> : <div className="flex flex-1 flex-col overflow-hidden"><div className="flex flex-wrap gap-2 border-b border-app-border p-3"><select value={graphScope} onChange={(event) => setGraphScope(event.target.value as any)} className="rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs"><option value="local">当前笔记局部图</option><option value="global">全局关系图</option></select><select value={edgeType} onChange={(event) => setEdgeType(event.target.value as any)} className="rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs"><option value="all">全部链接</option><option value="note">笔记链接</option><option value="block">块链接</option></select></div><div className="relative flex-1 overflow-auto bg-app-hover/20">{graphLoading ? <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin" /></div> : graphNodes.length === 0 ? <div className="flex h-full flex-col items-center justify-center text-xs text-tx-tertiary"><Network size={28} className="mb-2 opacity-50" />暂无可见关系</div> : <svg viewBox="0 0 420 380" className="h-full min-h-[380px] w-full">{filteredEdges.map((edge: any, index: number) => { const a: any = positions.get(edge.sourceNoteId); const b: any = positions.get(edge.targetNoteId); if (!a || !b) return null; return <g key={index}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className="text-tx-tertiary/40" strokeWidth={edge.linkType === "block" ? 2 : 1} strokeDasharray={edge.linkType === "block" ? "4 3" : undefined} /></g>; })}{graphNodes.map((node: any) => { const p: any = positions.get(node.id); const active = node.id === noteId; return <g key={node.id} onClick={() => openInternalNoteLink(`note:${node.id}`)} className="cursor-pointer"><circle cx={p.x} cy={p.y} r={active ? 28 : 23} className={active ? "fill-accent-primary" : "fill-app-elevated stroke-app-border"} strokeWidth={1.5} /><text x={p.x} y={p.y + 4} textAnchor="middle" className={active ? "fill-white text-[10px]" : "fill-tx-primary text-[10px]"}>{String(node.title || "无标题").slice(0, 8)}</text></g>; })}</svg>}</div><div className="flex items-center gap-4 border-t border-app-border px-3 py-2 text-[10px] text-tx-tertiary"><span className="flex items-center gap-1"><GitBranch size={11} />实线：笔记</span><span>虚线：块</span><span>{graphNodes.length} 节点 / {filteredEdges.length} 边</span></div></div>}
  </motion.div>;
}
