import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  BrainCircuit, Plus, Trash2, Edit2,
  ZoomIn, ZoomOut, Maximize2,
  Loader2, Check, Map, Menu, PanelLeftClose, Image, FileImage, FileDown
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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ===== CRC-32（用于 ZIP 打包） ===== */
const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
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
  onToggleCollapse, onAddChild, onDelete, isMobile, onContextMenu,
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
  isMobile: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const color = getNodeColor(node.depth);
  const isRoot = node.depth === 0;
  const hasChildren = node.children.length > 0 || node.collapsed;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          onContextMenu={onContextMenu}
          onTouchStart={(e) => {
            if (isMobile) {
              longPressTimer.current = setTimeout(() => {
                e.stopPropagation();
                onSelect();
                onDoubleClick();
              }, 500);
            }
          }}
          onTouchEnd={() => {
            if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
          }}
          onTouchMove={() => {
            if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
          }}
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
          width={node.width + 40}
          height={isMobile ? 36 : 28}
        >
          <div className="flex items-center gap-1">
            <button
              className={cn(
                "flex items-center gap-1 rounded bg-indigo-500 text-white hover:bg-indigo-600 transition-colors",
                isMobile ? "px-3 py-2 text-xs" : "px-2 py-1 text-[11px]"
              )}
              onClick={(e) => { e.stopPropagation(); onAddChild(); }}
            >
              <Plus size={isMobile ? 14 : 10} />
            </button>
            <button
              className={cn(
                "flex items-center gap-1 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors",
                isMobile ? "px-3 py-2 text-xs" : "px-2 py-1 text-[11px]"
              )}
              onClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
            >
              <Edit2 size={isMobile ? 14 : 10} />
            </button>
            {!isRoot && (
              <button
                className={cn(
                  "flex items-center gap-1 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors",
                  isMobile ? "px-3 py-2 text-xs" : "px-2 py-1 text-[11px]"
                )}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
              >
                <Trash2 size={isMobile ? 14 : 10} />
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
  item, isActive, onSelect, onDelete, onContextMenu,
}: {
  item: MindMapListItem;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const date = new Date(item.updatedAt + (item.updatedAt.endsWith("Z") ? "" : "Z"));
  const dateStr = date.toLocaleDateString();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-4 py-3 rounded-lg border transition-all cursor-pointer",
        isActive
          ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-500/5"
          : "border-app-border bg-app-elevated hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-800"
      )}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onTouchStart={(e) => {
        longPressTimer.current = setTimeout(() => {
          // 长按触发右键菜单（移动端导出入口）
          const touch = e.touches[0];
          if (touch) {
            const syntheticEvent = {
              preventDefault: () => {},
              stopPropagation: () => {},
              clientX: touch.clientX,
              clientY: touch.clientY,
            } as React.MouseEvent;
            onContextMenu(syntheticEvent);
          }
        }, 600);
      }}
      onTouchEnd={() => {
        if (longPressTimer.current) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      }}
      onTouchMove={() => {
        if (longPressTimer.current) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      }}
    >
      <BrainCircuit size={18} className="text-indigo-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-tx-primary truncate">{item.title}</div>
        <div className="text-xs text-tx-tertiary mt-0.5">{dateStr}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-tx-tertiary hover:text-accent-danger transition-all flex-shrink-0"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/* ===== 主组件 ===== */
export default function MindMapCenter() {
  const { t } = useTranslation();

  // 移动端检测
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
      else setSidebarOpen(true);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

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

  // 平移（鼠标）
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

  // 触摸手势（移动端）
  const touchRef = useRef<{ startX: number; startY: number; panX: number; panY: number; dist: number; zoom: number; isTap: boolean; tapTimer: ReturnType<typeof setTimeout> | null }>({
    startX: 0, startY: 0, panX: 0, panY: 0, dist: 0, zoom: 1, isTap: true, tapTimer: null,
  });

  const getTouchDist = (t1: React.Touch, t2: React.Touch) =>
    Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const t = touchRef.current;
    if (e.touches.length === 1) {
      t.startX = e.touches[0].clientX;
      t.startY = e.touches[0].clientY;
      t.panX = pan.x;
      t.panY = pan.y;
      t.isTap = true;
    } else if (e.touches.length === 2) {
      e.preventDefault();
      t.dist = getTouchDist(e.touches[0], e.touches[1]);
      t.zoom = zoom;
      t.isTap = false;
    }
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const t = touchRef.current;
    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - t.startX;
      const dy = e.touches[0].clientY - t.startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) t.isTap = false;
      setPan({ x: t.panX + dx, y: t.panY + dy });
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const newDist = getTouchDist(e.touches[0], e.touches[1]);
      const scale = newDist / t.dist;
      setZoom(Math.max(0.3, Math.min(2.5, t.zoom * scale)));
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    // tap 由 onClick 处理
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
  const { layoutNodes, edges, viewBox, bounds } = useMemo(() => {
    if (!mapData) return { layoutNodes: [], edges: [], viewBox: "0 0 800 600", bounds: { minX: 0, minY: 0, width: 800, height: 600 } };

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
    const bounds = { minX: minX - pad, minY: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };

    return { layoutNodes: all, edges: edgeList, viewBox: vb, bounds };
  }, [mapData]);

  const [showMiniMap, setShowMiniMap] = useState(!isMobile);

  // 列表右键菜单
  const [listContextMenu, setListContextMenu] = useState<{ x: number; y: number; mapId: string; title: string } | null>(null);

  const handleListContextMenu = useCallback((e: React.MouseEvent, item: MindMapListItem) => {
    e.preventDefault();
    e.stopPropagation();
    setListContextMenu({ x: e.clientX, y: e.clientY, mapId: item.id, title: item.title });
  }, []);

  // 点击其他地方关闭列表右键菜单
  useEffect(() => {
    if (!listContextMenu) return;
    const close = () => setListContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("contextmenu", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("contextmenu", close, true);
    };
  }, [listContextMenu]);

  // 根据 MindMapData 生成布局并构建导出用的干净 SVG 字符串
  const buildExportSvgFromData = useCallback((data: MindMapData) => {
    const root = buildLayout(data.root, 0, null);
    const treeH = getSubtreeHeight(root);
    layoutTree(root, 0, treeH / 2);
    const allNodes = flattenNodes(root);

    const edgeList: { from: LayoutNode; to: LayoutNode }[] = [];
    const collectEdges = (n: LayoutNode) => {
      n.children.forEach((c) => {
        edgeList.push({ from: n, to: c });
        collectEdges(c);
      });
    };
    collectEdges(root);

    if (allNodes.length === 0) return null;

    const pad = 40;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    allNodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;

    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX - pad} ${minY - pad} ${w} ${h}" style="background:#fff">\n`;

    edgeList.forEach((e) => {
      const x1 = e.from.x + e.from.width;
      const y1 = e.from.y + e.from.height / 2;
      const x2 = e.to.x;
      const y2 = e.to.y + e.to.height / 2;
      const mx = (x1 + x2) / 2;
      svgContent += `  <path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="rgb(203,213,225)" stroke-width="2"/>\n`;
    });

    allNodes.forEach((n) => {
      const color = getNodeColor(n.depth);
      const isRoot = n.depth === 0;
      const fontSize = isRoot ? 14 : 13;
      const fontWeight = isRoot ? 700 : 500;
      svgContent += `  <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${color.bg}" stroke="${color.border}" stroke-width="1.5"/>\n`;
      svgContent += `  <text x="${n.x + 12}" y="${n.y + n.height / 2}" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${color.text}">${escapeXml(n.text)}</text>\n`;
    });

    svgContent += `</svg>`;
    return { svgContent, width: w, height: h };
  }, []);

  // 加载指定导图数据
  const loadMapData = useCallback(async (mapId: string): Promise<{ data: MindMapData; title: string } | null> => {
    try {
      const map = await api.getMindMap(mapId);
      const parsed = JSON.parse(map.data) as MindMapData;
      return { data: parsed, title: map.title };
    } catch {
      return null;
    }
  }, []);

  const handleListDownloadSVG = useCallback(async () => {
    if (!listContextMenu) return;
    const { mapId, title } = listContextMenu;
    setListContextMenu(null);
    const result = await loadMapData(mapId);
    if (!result) return;
    const svgResult = buildExportSvgFromData(result.data);
    if (!svgResult) return;
    const blob = new Blob([svgResult.svgContent], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "mindmap"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [listContextMenu, loadMapData, buildExportSvgFromData]);

  const handleListDownloadPNG = useCallback(async () => {
    if (!listContextMenu) return;
    const { mapId, title } = listContextMenu;
    setListContextMenu(null);
    const result = await loadMapData(mapId);
    if (!result) return;
    const svgResult = buildExportSvgFromData(result.data);
    if (!svgResult) return;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = svgResult.width * scale;
    canvas.height = svgResult.height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new window.Image();
    const svgBlob = new Blob([svgResult.svgContent], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = pngUrl;
        a.download = `${title || "mindmap"}.png`;
        a.click();
        URL.revokeObjectURL(pngUrl);
      }, "image/png");
    };
    img.src = url;
  }, [listContextMenu, loadMapData, buildExportSvgFromData]);

  // 将 MindMapNode 转换为 xmind 的 content.json 格式
  const buildXmindContent = useCallback((data: MindMapData, title: string) => {
    const convertNode = (node: MindMapNode): Record<string, unknown> => {
      const result: Record<string, unknown> = {
        id: node.id,
        title: node.text,
      };
      if (node.children && node.children.length > 0) {
        result.children = {
          attached: node.children.map(convertNode),
        };
      }
      return result;
    };

    return [
      {
        id: "sheet-1",
        title: title,
        rootTopic: convertNode(data.root),
      },
    ];
  }, []);

  const handleListDownloadXmind = useCallback(async () => {
    if (!listContextMenu) return;
    const { mapId, title } = listContextMenu;
    setListContextMenu(null);
    const result = await loadMapData(mapId);
    if (!result) return;

    const content = buildXmindContent(result.data, title);
    const contentJson = JSON.stringify(content);
    const metadata = JSON.stringify({ creator: { name: "nowen-note", version: "1.0.0" } });
    const manifest = JSON.stringify({ "file-entries": { "content.json": {}, "metadata.json": {} } });

    // 使用简易 ZIP 打包（无压缩），xmind 本质是 ZIP
    const encoder = new TextEncoder();
    const files: { name: string; data: Uint8Array }[] = [
      { name: "content.json", data: encoder.encode(contentJson) },
      { name: "metadata.json", data: encoder.encode(metadata) },
      { name: "manifest.json", data: encoder.encode(manifest) },
    ];

    // 构建 ZIP 格式
    const parts: Uint8Array[] = [];
    const centralDir: Uint8Array[] = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      // Local file header
      const header = new ArrayBuffer(30 + nameBytes.length);
      const hView = new DataView(header);
      hView.setUint32(0, 0x04034b50, true); // signature
      hView.setUint16(4, 20, true); // version needed
      hView.setUint16(6, 0, true); // flags
      hView.setUint16(8, 0, true); // compression (store)
      hView.setUint16(10, 0, true); // mod time
      hView.setUint16(12, 0, true); // mod date
      // CRC-32
      const crc = crc32(file.data);
      hView.setUint32(14, crc, true);
      hView.setUint32(18, file.data.length, true); // compressed size
      hView.setUint32(22, file.data.length, true); // uncompressed size
      hView.setUint16(26, nameBytes.length, true); // name length
      hView.setUint16(28, 0, true); // extra length
      new Uint8Array(header).set(nameBytes, 30);

      const headerBytes = new Uint8Array(header);
      parts.push(headerBytes);
      parts.push(file.data);

      // Central directory entry
      const cde = new ArrayBuffer(46 + nameBytes.length);
      const cView = new DataView(cde);
      cView.setUint32(0, 0x02014b50, true); // signature
      cView.setUint16(4, 20, true); // version made by
      cView.setUint16(6, 20, true); // version needed
      cView.setUint16(8, 0, true); // flags
      cView.setUint16(10, 0, true); // compression
      cView.setUint16(12, 0, true); // mod time
      cView.setUint16(14, 0, true); // mod date
      cView.setUint32(16, crc, true);
      cView.setUint32(20, file.data.length, true);
      cView.setUint32(24, file.data.length, true);
      cView.setUint16(28, nameBytes.length, true);
      cView.setUint16(30, 0, true); // extra length
      cView.setUint16(32, 0, true); // comment length
      cView.setUint16(34, 0, true); // disk number
      cView.setUint16(36, 0, true); // internal attrs
      cView.setUint32(38, 0, true); // external attrs
      cView.setUint32(42, offset, true); // local header offset
      new Uint8Array(cde).set(nameBytes, 46);
      centralDir.push(new Uint8Array(cde));

      offset += headerBytes.length + file.data.length;
    }

    const centralDirOffset = offset;
    let centralDirSize = 0;
    centralDir.forEach((cd) => { parts.push(cd); centralDirSize += cd.length; });

    // End of central directory
    const eocd = new ArrayBuffer(22);
    const eView = new DataView(eocd);
    eView.setUint32(0, 0x06054b50, true);
    eView.setUint16(4, 0, true);
    eView.setUint16(6, 0, true);
    eView.setUint16(8, files.length, true);
    eView.setUint16(10, files.length, true);
    eView.setUint32(12, centralDirSize, true);
    eView.setUint32(16, centralDirOffset, true);
    eView.setUint16(20, 0, true);
    parts.push(new Uint8Array(eocd));

    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const zipData = new Uint8Array(totalLen);
    let pos = 0;
    parts.forEach((p) => { zipData.set(p, pos); pos += p.length; });

    const blob = new Blob([zipData], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "mindmap"}.xmind`;
    a.click();
    URL.revokeObjectURL(url);
  }, [listContextMenu, loadMapData, buildXmindContent]);

  // 自动居中
  useEffect(() => {
    if (mapData && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPan({ x: 60, y: rect.height / 2 - 40 });
    }
  }, [activeMap?.id]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 移动端遮罩层 */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Left: Map List Panel */}
      <div
        className={cn(
          "border-r border-app-border bg-app-surface flex flex-col transition-all duration-200",
          isMobile
            ? "fixed inset-y-0 left-0 z-40 w-[280px] shadow-2xl"
            : "w-[260px] min-w-[260px] shrink-0",
          isMobile && !sidebarOpen && "-translate-x-full"
        )}
      >
        <div className="px-4 py-4 border-b border-app-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrainCircuit size={18} className="text-indigo-500" />
              <h2 className="text-sm font-bold text-tx-primary">{t("mindMap.title")}</h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleCreate}
                className="p-1.5 rounded-md hover:bg-app-hover transition-colors text-tx-secondary hover:text-indigo-500"
                title={t("mindMap.create")}
              >
                <Plus size={16} />
              </button>
              {isMobile && (
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="p-1.5 rounded-md hover:bg-app-hover transition-colors text-tx-secondary"
                >
                  <PanelLeftClose size={16} />
                </button>
              )}
            </div>
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
                onSelect={() => { handleSelect(m.id); if (isMobile) setSidebarOpen(false); }}
                onDelete={() => handleDeleteMap(m.id)}
                onContextMenu={(e) => handleListContextMenu(e, m)}
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
            <div className="px-2 sm:px-4 py-2 border-b border-app-border flex items-center justify-between bg-app-surface/50 gap-1">
              <div className="flex items-center gap-2 min-w-0">
                {isMobile && (
                  <button
                    onClick={() => setSidebarOpen(true)}
                    className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors flex-shrink-0"
                  >
                    <Menu size={16} />
                  </button>
                )}
                <h1 className="text-sm font-semibold text-tx-primary truncate max-w-[120px] sm:max-w-[300px]">
                  {activeMap.title}
                </h1>
                {isSaving ? (
                  <span className="flex items-center gap-1 text-xs text-tx-tertiary flex-shrink-0">
                    <Loader2 size={12} className="animate-spin" />
                    <span className="hidden sm:inline">{t("mindMap.saving")}</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-green-500 flex-shrink-0">
                    <Check size={12} />
                    <span className="hidden sm:inline">{t("mindMap.saved")}</span>
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
                <span className="text-xs text-tx-tertiary w-12 text-center tabular-nums hidden sm:inline-block">
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
                <div className="w-px h-4 bg-app-border mx-0.5" />
                <button
                  onClick={() => setShowMiniMap((v) => !v)}
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    showMiniMap
                      ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-500"
                      : "hover:bg-app-hover text-tx-secondary"
                  )}
                  title={t("mindMap.miniMap")}
                >
                  <Map size={16} />
                </button>
              </div>
            </div>

            {/* Canvas */}
            <div
              className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing relative"
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
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={() => { setSelectedNodeId(null); setEditingNodeId(null); }}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "0 0",
                  touchAction: "none",
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
                    isMobile={isMobile}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                ))}
              </svg>

              {/* MiniMap 小地图 */}
              {showMiniMap && layoutNodes.length > 0 && (
                <div
                  className="absolute right-2 bottom-2 sm:right-3 sm:bottom-3 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg overflow-hidden"
                  style={{ width: isMobile ? 140 : 180, height: isMobile ? 90 : 120 }}
                >
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={viewBox}
                    preserveAspectRatio="xMidYMid meet"
                    className="cursor-pointer"
                    onClick={(e) => {
                      const svg = e.currentTarget;
                      const rect = svg.getBoundingClientRect();
                      const svgX = ((e.clientX - rect.left) / rect.width) * bounds.width + bounds.minX;
                      const svgY = ((e.clientY - rect.top) / rect.height) * bounds.height + bounds.minY;
                      if (containerRef.current) {
                        const cr = containerRef.current.getBoundingClientRect();
                        setPan({
                          x: cr.width / 2 - svgX * zoom,
                          y: cr.height / 2 - svgY * zoom,
                        });
                      }
                    }}
                  >
                    {/* 连线 */}
                    {edges.map((e, i) => {
                      const x1 = e.from.x + e.from.width;
                      const y1 = e.from.y + e.from.height / 2;
                      const x2 = e.to.x;
                      const y2 = e.to.y + e.to.height / 2;
                      return (
                        <line
                          key={`mini-e-${i}`}
                          x1={x1} y1={y1} x2={x2} y2={y2}
                          stroke="rgb(203,213,225)"
                          strokeWidth={3}
                          className="dark:stroke-zinc-600"
                        />
                      );
                    })}
                    {/* 节点 */}
                    {layoutNodes.map((n) => {
                      const color = getNodeColor(n.depth);
                      return (
                        <rect
                          key={`mini-n-${n.id}`}
                          x={n.x} y={n.y}
                          width={n.width} height={n.height}
                          rx={4}
                          fill={color.bg}
                          stroke={color.border}
                          strokeWidth={2}
                        />
                      );
                    })}
                    {/* 视口指示框 */}
                    {containerRef.current && (() => {
                      const cr = containerRef.current!.getBoundingClientRect();
                      const vpX = -pan.x / zoom;
                      const vpY = (-pan.y + 40) / zoom;
                      const vpW = cr.width / zoom;
                      const vpH = (cr.height - 80) / zoom;
                      return (
                        <rect
                          x={vpX} y={vpY}
                          width={vpW} height={vpH}
                          fill="rgba(99,102,241,0.08)"
                          stroke="rgb(99,102,241)"
                          strokeWidth={4}
                          rx={3}
                        />
                      );
                    })()}
                  </svg>
                </div>
              )}

            </div>
            {!isMobile && (
            <div className="px-4 py-1.5 border-t border-app-border bg-app-surface/30 flex items-center gap-4 text-[11px] text-tx-tertiary">
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Tab</kbd> {t("mindMap.shortcutAdd")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Enter</kbd> {t("mindMap.shortcutEdit")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Del</kbd> {t("mindMap.shortcutDelete")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Space</kbd> {t("mindMap.shortcutCollapse")}</span>
              <span>{t("mindMap.dragToMove")}</span>
            </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-tx-tertiary relative">
            {isMobile && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="absolute top-3 left-3 p-2 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
              >
                <Menu size={20} />
              </button>
            )}
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

      {/* 列表右键菜单 */}
      {listContextMenu && (
        <MindMapContextMenuOverlay
          menu={listContextMenu}
          onClose={() => setListContextMenu(null)}
          onDownloadPNG={handleListDownloadPNG}
          onDownloadSVG={handleListDownloadSVG}
          onDownloadXmind={handleListDownloadXmind}
          t={t}
        />
      )}
    </div>
  );
}

/* ===== 列表右键菜单（带位置修正） ===== */
function MindMapContextMenuOverlay({
  menu,
  onClose,
  onDownloadPNG,
  onDownloadSVG,
  onDownloadXmind,
  t,
}: {
  menu: { x: number; y: number; mapId: string; title: string };
  onClose: () => void;
  onDownloadPNG: () => void;
  onDownloadSVG: () => void;
  onDownloadXmind: () => void;
  t: (key: string) => string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // 位置边界修正
  useEffect(() => {
    requestAnimationFrame(() => {
      const el = menuRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let newX = menu.x;
      let newY = menu.y;
      if (newX + rect.width > vw - 8) newX = vw - rect.width - 8;
      if (newY + rect.height > vh - 8) newY = vh - rect.height - 8;
      if (newX < 8) newX = 8;
      if (newY < 8) newY = 8;
      setPos({ x: newX, y: newY });
    });
  }, [menu.x, menu.y]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
        onClick={onDownloadPNG}
      >
        <Image size={15} className="text-indigo-500" />
        {t("mindMap.downloadPNG")}
      </button>
      <button
        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
        onClick={onDownloadSVG}
      >
        <FileImage size={15} className="text-emerald-500" />
        {t("mindMap.downloadSVG")}
      </button>
      <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
      <button
        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
        onClick={onDownloadXmind}
      >
        <FileDown size={15} className="text-orange-500" />
        {t("mindMap.downloadXmind")}
      </button>
    </div>
  );
}
