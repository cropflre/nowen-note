import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BrainCircuit, Plus, Trash2, ChevronRight, X, Edit2,
  ZoomIn, ZoomOut, Maximize2, Download, ChevronDown,
  ChevronUp, Loader2, Check
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { MindMap, MindMapListItem, MindMapNode, MindMapData } from "@/types";
import { cn } from "@/lib/utils";

/* ===== 布局算法：计算树节点的 x,y 位置 ===== */
interface LayoutNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  collapsed: boolean;
  children: LayoutNode[];
  parent: LayoutNode | null;
}

const NODE_H = 36;
const NODE_MIN_W = 80;
const NODE_CHAR_W = 14;
const H_GAP = 50;
const V_GAP = 12;

function measureNode(text: string): { width: number; height: number } {
  const w = Math.max(NODE_MIN_W, Math.min(text.length * NODE_CHAR_W + 32, 260));
  return { width: w, height: NODE_H };
}

function buildLayout(node: MindMapNode, depth: number, parent: LayoutNode | null): LayoutNode {
  const { width, height } = measureNode(node.text);
  const ln: LayoutNode = {
    id: node.id,
    text: node.text,
    x: 0,
    y: 0,
    width,
    height,
    depth,
    collapsed: !!node.collapsed,
    children: [],
    parent,
  };
  if (!node.collapsed && node.children) {
    ln.children = node.children.map((c) => buildLayout(c, depth + 1, ln));
  }
  return ln;
}

function getSubtreeHeight(node: LayoutNode): number {
  if (node.children.length === 0) return node.height;
  let total = 0;
  node.children.forEach((c, i) => {
    total += getSubtreeHeight(c);
    if (i > 0) total += V_GAP;
  });
  return Math.max(node.height, total);
}

function layoutTree(node: LayoutNode, x: number, yCenter: number) {
  node.x = x;
  node.y = yCenter - node.height / 2;
  if (node.children.length === 0) return;

  const childX = x + node.width + H_GAP;
  const totalH = node.children.reduce(
    (sum, c, i) => sum + getSubtreeHeight(c) + (i > 0 ? V_GAP : 0),
    0
  );
  let cy = yCenter - totalH / 2;
  node.children.forEach((c) => {
    const ch = getSubtreeHeight(c);
    layoutTree(c, childX, cy + ch / 2);
    cy += ch + V_GAP;
  });
}

function flattenNodes(node: LayoutNode): LayoutNode[] {
  const result: LayoutNode[] = [node];
  node.children.forEach((c) => result.push(...flattenNodes(c)));
  return result;
}

/* ===== 颜色方案 ===== */
const DEPTH_COLORS = [
  { bg: "rgb(99,102,241)", text: "#fff", border: "rgb(79,82,221)" },       // indigo (root)
  { bg: "rgb(236,242,255)", text: "rgb(55,65,81)", border: "rgb(165,180,252)" }, // light indigo
  { bg: "rgb(240,253,244)", text: "rgb(55,65,81)", border: "rgb(134,239,172)" }, // light green
  { bg: "rgb(255,247,237)", text: "rgb(55,65,81)", border: "rgb(253,186,116)" }, // light orange
  { bg: "rgb(245,243,255)", text: "rgb(55,65,81)", border: "rgb(196,181,253)" }, // light purple
  { bg: "rgb(254,242,242)", text: "rgb(55,65,81)", border: "rgb(252,165,165)" }, // light red
];

function getNodeColor(depth: number) {
  return DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)];
}

/* ===== 连线组件 ===== */
function Edge({ from, to }: { from: LayoutNode; to: LayoutNode }) {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const mx = (x1 + x2) / 2;

  return (
    <path
      d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
      fill="none"
      stroke="rgb(203,213,225)"
      strokeWidth={2}
      className="dark:stroke-zinc-600"
    />
  );
}

/* ===== 节点组件 ===== */
function NodeBox({
  node, isSelected, isEditing, editValue,
  onSelect, onDoubleClick, onEditChange, onEditSubmit,
  onToggleCollapse, onAddChild, onDelete,
}: {
  node: LayoutNode;
  isSelected: boolean;
  isEditing: boolean;
  editValue: string;
  onSelect: () => void;
  onDoubleClick: () => void;
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  onToggleCollapse: () => void;
  onAddChild: () => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const color = getNodeColor(node.depth);
  const isRoot = node.depth === 0;
  const hasChildren = node.children.length > 0 || node.collapsed;

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <g>
      <foreignObject x={node.x} y={node.y} width={node.width} height={node.height}>
        <div
          className={cn(
            "flex items-center h-full px-3 rounded-lg cursor-pointer select-none transition-shadow text-sm font-medium whitespace-nowrap overflow-hidden",
            isSelected && "ring-2 ring-indigo-500 ring-offset-1 dark:ring-offset-zinc-900"
          )}
          style={{
            background: color.bg,
            color: color.text,
            border: `1.5px solid ${color.border}`,
            fontSize: isRoot ? 14 : 13,
            fontWeight: isRoot ? 700 : 500,
          }}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
        >
          {isEditing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onEditSubmit();
                if (e.key === "Escape") onEditSubmit();
              }}
              onBlur={onEditSubmit}
              className="flex-1 bg-transparent outline-none text-inherit min-w-0"
              style={{ fontSize: "inherit", fontWeight: "inherit" }}
            />
          ) : (
            <span className="truncate">{node.text}</span>
          )}
        </div>
      </foreignObject>

      {/* 折叠/展开按钮 */}
      {hasChildren && !isEditing && (
        <foreignObject
          x={node.x + node.width - 2}
          y={node.y + node.height / 2 - 10}
          width={20}
          height={20}
        >
          <div
            className="w-5 h-5 rounded-full bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 flex items-center justify-center cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          >
            {node.collapsed ? (
              <Plus size={10} className="text-zinc-500" />
            ) : (
              <span className="text-zinc-500 text-[10px] font-bold">−</span>
            )}
          </div>
        </foreignObject>
      )}

      {/* 选中时的操作按钮 */}
      {isSelected && !isEditing && (
        <foreignObject
          x={node.x}
          y={node.y + node.height + 4}
          width={node.width}
          height={28}
        >
          <div className="flex items-center gap-1">
            <button
              className="flex items-center gap-1 px-2 py-1 rounded bg-indigo-500 text-white text-[11px] hover:bg-indigo-600 transition-colors"
              onClick={(e) => { e.stopPropagation(); onAddChild(); }}
            >
              <Plus size={10} />
            </button>
            <button
              className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 text-[11px] hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
              onClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
            >
              <Edit2 size={10} />
            </button>
            {!isRoot && (
              <button
                className="flex items-center gap-1 px-2 py-1 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-[11px] hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

/* ===== 列表项组件 ===== */
function MindMapListRow({
  item, isActive, onSelect, onDelete, onRename,
}: {
  item: MindMapListItem;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const { t } = useTranslation();
  const date = new Date(item.updatedAt + (item.updatedAt.endsWith("Z") ? "" : "Z"));
  const dateStr = date.toLocaleDateString();

  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-4 py-3 rounded-lg border transition-all cursor-pointer",
        isActive
          ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-500/5"
          : "border-app-border bg-app-elevated hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-800"
      )}
      onClick={onSelect}
    >
      <BrainCircuit size={18} className="text-indigo-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-tx-primary truncate">{item.title}</div>
        <div className="text-xs text-tx-tertiary mt-0.5">{dateStr}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 text-tx-tertiary hover:text-accent-danger transition-all flex-shrink-0"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/* ===== 主组件 ===== */
export default function MindMapCenter() {
  const { t } = useTranslation();

  const [maps, setMaps] = useState<MindMapListItem[]>([]);
  const [activeMap, setActiveMap] = useState<MindMap | null>(null);
  const [mapData, setMapData] = useState<MindMapData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 60, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 加载列表
  const loadMaps = useCallback(async () => {
    try {
      const data = await api.getMindMaps();
      setMaps(data);
    } catch (err) {
      console.error("Failed to load mindmaps:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMaps();
  }, [loadMaps]);

  // 选择一个导图
  const handleSelect = useCallback(async (id: string) => {
    try {
      const map = await api.getMindMap(id);
      setActiveMap(map);
      try {
        const parsed = JSON.parse(map.data);
        setMapData(parsed);
      } catch {
        setMapData({ root: { id: "root", text: map.title, children: [] } });
      }
      setSelectedNodeId(null);
      setEditingNodeId(null);
      setZoom(1);
      setPan({ x: 60, y: 0 });
    } catch (err) {
      console.error("Failed to load mindmap:", err);
    }
  }, []);

  // 自动保存
  const triggerSave = useCallback((data: MindMapData, title?: string) => {
    if (!activeMap) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setIsSaving(true);
      try {
        const payload: { data: string; title?: string } = { data: JSON.stringify(data) };
        if (title !== undefined) payload.title = title;
        const updated = await api.updateMindMap(activeMap.id, payload);
        setActiveMap(updated);
        setMaps((prev) =>
          prev.map((m) => (m.id === updated.id ? { ...m, title: updated.title, updatedAt: updated.updatedAt } : m))
        );
      } catch (err) {
        console.error("Failed to save mindmap:", err);
      } finally {
        setIsSaving(false);
      }
    }, 600);
  }, [activeMap]);

  // 更新节点树（递归辅助函数）
  const updateNode = useCallback(
    (root: MindMapNode, nodeId: string, updater: (n: MindMapNode) => MindMapNode): MindMapNode => {
      if (root.id === nodeId) return updater(root);
      return {
        ...root,
        children: root.children.map((c) => updateNode(c, nodeId, updater)),
      };
    }, []
  );

  const findNode = useCallback(
    (root: MindMapNode, nodeId: string): MindMapNode | null => {
      if (root.id === nodeId) return root;
      for (const c of root.children) {
        const found = findNode(c, nodeId);
        if (found) return found;
      }
      return null;
    }, []
  );

  const removeNode = useCallback(
    (root: MindMapNode, nodeId: string): MindMapNode => {
      return {
        ...root,
        children: root.children
          .filter((c) => c.id !== nodeId)
          .map((c) => removeNode(c, nodeId)),
      };
    }, []
  );

  // 操作：添加子节点
  const handleAddChild = useCallback((parentId: string) => {
    if (!mapData) return;
    const newId = `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newNode: MindMapNode = { id: newId, text: t("mindMap.newNode"), children: [] };
    const newRoot = updateNode(mapData.root, parentId, (n) => ({
      ...n,
      collapsed: false,
      children: [...n.children, newNode],
    }));
    const newData = { root: newRoot };
    setMapData(newData);
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditValue(newNode.text);
    triggerSave(newData);
  }, [mapData, updateNode, triggerSave, t]);

  // 操作：删除节点
  const handleDeleteNode = useCallback((nodeId: string) => {
    if (!mapData || nodeId === "root") return;
    const newRoot = removeNode(mapData.root, nodeId);
    const newData = { root: newRoot };
    setMapData(newData);
    setSelectedNodeId(null);
    triggerSave(newData);
  }, [mapData, removeNode, triggerSave]);

  // 操作：编辑提交
  const handleEditSubmit = useCallback(() => {
    if (!mapData || !editingNodeId) return;
    const trimmed = editValue.trim() || t("mindMap.newNode");
    const newRoot = updateNode(mapData.root, editingNodeId, (n) => ({ ...n, text: trimmed }));
    const newData = { root: newRoot };
    setMapData(newData);
    setEditingNodeId(null);
    // 如果编辑的是根节点，同步更新标题
    const isRoot = editingNodeId === "root";
    triggerSave(newData, isRoot ? trimmed : undefined);
    if (isRoot) {
      setMaps((prev) =>
        prev.map((m) => (m.id === activeMap?.id ? { ...m, title: trimmed } : m))
      );
    }
  }, [mapData, editingNodeId, editValue, updateNode, triggerSave, activeMap, t]);

  // 操作：折叠/展开
  const handleToggleCollapse = useCallback((nodeId: string) => {
    if (!mapData) return;
    const newRoot = updateNode(mapData.root, nodeId, (n) => ({
      ...n,
      collapsed: !n.collapsed,
    }));
    const newData = { root: newRoot };
    setMapData(newData);
    triggerSave(newData);
  }, [mapData, updateNode, triggerSave]);

  // 创建新导图
  const handleCreate = useCallback(async () => {
    try {
      const map = await api.createMindMap({ title: t("mindMap.untitled") });
      setMaps((prev) => [{ id: map.id, userId: map.userId, title: map.title, createdAt: map.createdAt, updatedAt: map.updatedAt }, ...prev]);
      handleSelect(map.id);
    } catch (err) {
      console.error("Failed to create mindmap:", err);
    }
  }, [handleSelect, t]);

  // 删除导图
  const handleDeleteMap = useCallback(async (id: string) => {
    try {
      await api.deleteMindMap(id);
      setMaps((prev) => prev.filter((m) => m.id !== id));
      if (activeMap?.id === id) {
        setActiveMap(null);
        setMapData(null);
      }
    } catch (err) {
      console.error("Failed to delete mindmap:", err);
    }
  }, [activeMap]);

  // 缩放
  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.15, 2.5));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.15, 0.3));
  const handleZoomReset = () => { setZoom(1); setPan({ x: 60, y: 0 }); };

  // 平移
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.target === svgRef.current)) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
  }, [isPanning, panStart]);

  const handleMouseUp = useCallback(() => setIsPanning(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      setZoom((z) => Math.max(0.3, Math.min(2.5, z + delta)));
    } else {
      setPan((p) => ({ x: p.x - e.deltaX * 0.5, y: p.y - e.deltaY * 0.5 }));
    }
  }, []);

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!mapData || !selectedNodeId || editingNodeId) return;

      if (e.key === "Tab") {
        e.preventDefault();
        handleAddChild(selectedNodeId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNodeId !== "root") {
          e.preventDefault();
          handleDeleteNode(selectedNodeId);
        }
      } else if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        const node = findNode(mapData.root, selectedNodeId);
        if (node) {
          setEditingNodeId(selectedNodeId);
          setEditValue(node.text);
        }
      } else if (e.key === " ") {
        e.preventDefault();
        handleToggleCollapse(selectedNodeId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mapData, selectedNodeId, editingNodeId, handleAddChild, handleDeleteNode, handleToggleCollapse, findNode]);

  // 构建布局
  const { layoutNodes, edges, viewBox } = useMemo(() => {
    if (!mapData) return { layoutNodes: [], edges: [], viewBox: "0 0 800 600" };

    const root = buildLayout(mapData.root, 0, null);
    const treeH = getSubtreeHeight(root);
    layoutTree(root, 0, treeH / 2);
    const all = flattenNodes(root);

    const edgeList: { from: LayoutNode; to: LayoutNode }[] = [];
    const collectEdges = (n: LayoutNode) => {
      n.children.forEach((c) => {
        edgeList.push({ from: n, to: c });
        collectEdges(c);
      });
    };
    collectEdges(root);

    // 计算 viewBox 边界
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    all.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height + 36);
    });
    const pad = 80;
    const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;

    return { layoutNodes: all, edges: edgeList, viewBox: vb };
  }, [mapData]);

  // 自动居中
  useEffect(() => {
    if (mapData && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPan({ x: 60, y: rect.height / 2 - 40 });
    }
  }, [activeMap?.id]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left: Map List Panel */}
      <div className="w-[260px] min-w-[260px] shrink-0 border-r border-app-border bg-app-surface flex flex-col transition-colors">
        <div className="px-4 py-4 border-b border-app-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrainCircuit size={18} className="text-indigo-500" />
              <h2 className="text-sm font-bold text-tx-primary">{t("mindMap.title")}</h2>
            </div>
            <button
              onClick={handleCreate}
              className="p-1.5 rounded-md hover:bg-app-hover transition-colors text-tx-secondary hover:text-indigo-500"
              title={t("mindMap.create")}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="mt-1 text-xs text-tx-tertiary">
            {t("mindMap.totalCount", { count: maps.length })}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center h-20 text-tx-tertiary text-sm">
              {t("common.loading")}
            </div>
          ) : maps.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-tx-tertiary">
              <BrainCircuit size={32} className="mb-2 opacity-30" />
              <span className="text-xs">{t("mindMap.empty")}</span>
              <button
                onClick={handleCreate}
                className="mt-3 text-xs text-indigo-500 hover:text-indigo-600 font-medium"
              >
                {t("mindMap.createFirst")}
              </button>
            </div>
          ) : (
            maps.map((m) => (
              <MindMapListRow
                key={m.id}
                item={m}
                isActive={activeMap?.id === m.id}
                onSelect={() => handleSelect(m.id)}
                onDelete={() => handleDeleteMap(m.id)}
                onRename={() => {}}
              />
            ))
          )}
        </div>
      </div>

      {/* Center: Mind Map Canvas */}
      <div className="flex-1 flex flex-col overflow-hidden bg-app-bg transition-colors" ref={containerRef}>
        {activeMap && mapData ? (
          <>
            {/* Toolbar */}
            <div className="px-4 py-2 border-b border-app-border flex items-center justify-between bg-app-surface/50">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold text-tx-primary truncate max-w-[300px]">
                  {activeMap.title}
                </h1>
                {isSaving ? (
                  <span className="flex items-center gap-1 text-xs text-tx-tertiary">
                    <Loader2 size={12} className="animate-spin" />
                    {t("mindMap.saving")}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-green-500">
                    <Check size={12} />
                    {t("mindMap.saved")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleZoomOut}
                  className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
                  title={t("mindMap.zoomOut")}
                >
                  <ZoomOut size={16} />
                </button>
                <span className="text-xs text-tx-tertiary w-12 text-center tabular-nums">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  onClick={handleZoomIn}
                  className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
                  title={t("mindMap.zoomIn")}
                >
                  <ZoomIn size={16} />
                </button>
                <button
                  onClick={handleZoomReset}
                  className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
                  title={t("mindMap.fitView")}
                >
                  <Maximize2 size={16} />
                </button>
              </div>
            </div>

            {/* Canvas */}
            <div
              className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
              style={{ userSelect: "none" }}
            >
              <svg
                ref={svgRef}
                width="100%"
                height="100%"
                viewBox={viewBox}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
                onClick={() => { setSelectedNodeId(null); setEditingNodeId(null); }}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                {/* Edges */}
                {edges.map((e, i) => (
                  <Edge key={`${e.from.id}-${e.to.id}-${i}`} from={e.from} to={e.to} />
                ))}

                {/* Nodes */}
                {layoutNodes.map((n) => (
                  <NodeBox
                    key={n.id}
                    node={n}
                    isSelected={selectedNodeId === n.id}
                    isEditing={editingNodeId === n.id}
                    editValue={editValue}
                    onSelect={() => setSelectedNodeId(n.id)}
                    onDoubleClick={() => {
                      setEditingNodeId(n.id);
                      setEditValue(n.text);
                    }}
                    onEditChange={setEditValue}
                    onEditSubmit={handleEditSubmit}
                    onToggleCollapse={() => handleToggleCollapse(n.id)}
                    onAddChild={() => handleAddChild(n.id)}
                    onDelete={() => handleDeleteNode(n.id)}
                  />
                ))}
              </svg>
            </div>

            {/* 底部快捷键提示 */}
            <div className="px-4 py-1.5 border-t border-app-border bg-app-surface/30 flex items-center gap-4 text-[11px] text-tx-tertiary">
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Tab</kbd> {t("mindMap.shortcutAdd")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Enter</kbd> {t("mindMap.shortcutEdit")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Del</kbd> {t("mindMap.shortcutDelete")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Space</kbd> {t("mindMap.shortcutCollapse")}</span>
              <span>{t("mindMap.dragToMove")}</span>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-tx-tertiary">
            <BrainCircuit size={48} className="mb-3 opacity-20" />
            <span className="text-sm">{t("mindMap.selectOrCreate")}</span>
            <button
              onClick={handleCreate}
              className="mt-4 flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors"
            >
              <Plus size={16} />
              {t("mindMap.create")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
