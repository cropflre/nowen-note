import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  BrainCircuit, Plus, Trash2, Edit2,
  ZoomIn, ZoomOut, Maximize2, Minimize2, Scan,
  Loader2, Check, Map, Menu, PanelLeftClose, Image, FileImage, FileDown, MoreHorizontal,
  User as UserIcon, Undo2, Redo2, PanelLeft, ChevronRight, ChevronDown, Link as LinkIcon, StickyNote, Palette, ExternalLink, FileText, ArrowDownToLine, Spline, Square, Pipette, Search as SearchIcon, ChevronUp, Star, Folder as FolderIcon, FolderPlus
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace } from "@/lib/api";
import { MindMap, MindMapListItem, MindMapNode, MindMapData, MindMapRelation, MindMapBoundary } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useMindMapHistory } from "@/hooks/useMindMapHistory";
import { buildXmindContent, buildZip, downloadBlob } from "@/lib/mindmapExport";
import { markdownToMindMapData, mindMapDataToMarkdown } from "@/lib/mindmapTransform";

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

/**
 * Layout children to the LEFT of the parent node.
 * Child right edge = parent.x - H_GAP; child extends leftward.
 */
function layoutTreeLeft(node: LayoutNode, x: number, yCenter: number) {
  // x here is the RIGHT edge of the subtree (parent left edge)
  node.x = x - node.width;
  node.y = yCenter - node.height / 2;
  if (node.children.length === 0) return;

  const childRightX = x - node.width - H_GAP;
  const totalH = node.children.reduce(
    (sum, c, i) => sum + getSubtreeHeight(c) + (i > 0 ? V_GAP : 0),
    0
  );
  let cy = yCenter - totalH / 2;
  node.children.forEach((c) => {
    const ch = getSubtreeHeight(c);
    layoutTreeLeft(c, childRightX, cy + ch / 2);
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
  { bg: "rgb(99,102,241)", text: "#fff", border: "rgb(99,102,241)" },
  { bg: "#f0f4ff", text: "rgb(55,65,81)", border: "#dbeafe" },
  { bg: "#f8fafc", text: "rgb(55,65,81)", border: "#e2e8f0" },
  { bg: "#fafafa", text: "rgb(55,65,81)", border: "#e5e7eb" },
  { bg: "#fafafa", text: "rgb(55,65,81)", border: "#e5e7eb" },
  { bg: "#fafafa", text: "rgb(55,65,81)", border: "#e5e7eb" },
];

const NODE_COLORS = [
  { bg: "#6366f1", color: "#fff" },
  { bg: "#3b82f6", color: "#fff" },
  { bg: "#22c55e", color: "#fff" },
  { bg: "#f59e0b", color: "#fff" },
  { bg: "#ef4444", color: "#fff" },
  { bg: "#8b5cf6", color: "#fff" },
  { bg: "#ec4899", color: "#fff" },
  { bg: "#06b6d4", color: "#fff" },
  { bg: "#f0fdf4", color: "#374151" },
  { bg: "#fff7ed", color: "#374151" },
  { bg: "#faf5ff", color: "#374151" },
  { bg: "#fef2f2", color: "#374151" },
];

/* ===== Theme templates ===== */
interface ThemeTemplate {
  name: string;
  colors: { bg: string; text: string; border: string; accent: string }[];
}
const THEME_TEMPLATES: ThemeTemplate[] = [
  { name: "Indigo", colors: [
    { bg: "#6366f1", text: "#fff", border: "#4f46e5", accent: "#6366f1" },
    { bg: "#eef2ff", text: "#374151", border: "#c7d2fe", accent: "#6366f1" },
    { bg: "#e0e7ff", text: "#374151", border: "#a5b4fc", accent: "#6366f1" },
  ]},
  { name: "Emerald", colors: [
    { bg: "#10b981", text: "#fff", border: "#059669", accent: "#10b981" },
    { bg: "#ecfdf5", text: "#374151", border: "#a7f3d0", accent: "#10b981" },
    { bg: "#d1fae5", text: "#374151", border: "#6ee7b7", accent: "#10b981" },
  ]},
  { name: "Sunset", colors: [
    { bg: "#f97316", text: "#fff", border: "#ea580c", accent: "#f97316" },
    { bg: "#fff7ed", text: "#374151", border: "#fed7aa", accent: "#f97316" },
    { bg: "#ffedd5", text: "#374151", border: "#fdba74", accent: "#f97316" },
  ]},
  { name: "Rose", colors: [
    { bg: "#f43f5e", text: "#fff", border: "#e11d48", accent: "#f43f5e" },
    { bg: "#fff1f2", text: "#374151", border: "#fecdd3", accent: "#f43f5e" },
    { bg: "#ffe4e6", text: "#374151", border: "#fda4af", accent: "#f43f5e" },
  ]},
  { name: "Dark", colors: [
    { bg: "#18181b", text: "#fafafa", border: "#3f3f46", accent: "#a1a1aa" },
    { bg: "#27272a", text: "#e4e4e7", border: "#3f3f46", accent: "#a1a1aa" },
    { bg: "#3f3f46", text: "#fafafa", border: "#52525b", accent: "#a1a1aa" },
  ]},
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

/* ===== Undo/Redo history ===== */
interface HistoryEntry {
  data: MindMapData;
  title?: string;
}
const MAX_HISTORY = 50;

/* ===== Marker icon SVGs ===== */
const MARKER_SVGS: Record<string, string> = {
  done: '<circle cx="8" cy="8" r="7" fill="#22c55e"/><path d="M5 8l2 2 4-4" stroke="white" stroke-width="1.5" fill="none"/>',
  todo: '<circle cx="8" cy="8" r="7" fill="#e5e7eb" stroke="#9ca3af" stroke-width="1"/><path d="M5 8h6M8 5v6" stroke="#9ca3af" stroke-width="1.5" fill="none"/>',
  "priority-high": '<circle cx="8" cy="8" r="7" fill="#ef4444"/><text x="8" y="11" text-anchor="middle" font-size="10" font-weight="bold" fill="white">!</text>',
  warning: '<path d="M8 1l7 14H1z" fill="#f59e0b"/><text x="8" y="12" text-anchor="middle" font-size="10" font-weight="bold" fill="white">!</text>',
  idea: '<circle cx="8" cy="8" r="7" fill="#8b5cf6"/><text x="8" y="11" text-anchor="middle" font-size="10" fill="white">★</text>',
  pin: '<circle cx="8" cy="8" r="7" fill="#06b6d4"/><path d="M8 4v5M6 9l2 3 2-3" stroke="white" stroke-width="1.5" fill="none"/>',
};

function MarkerIcons({ markers }: { markers?: string[] }) {
  if (!markers || markers.length === 0) return null;
  return (
    <span className="flex items-center gap-0.5 mr-1 shrink-0">
      {markers.map((m) => {
        const svg = MARKER_SVGS[m];
        if (!svg) return null;
        return (
          <svg key={m} width="14" height="14" viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: svg }} />
        );
      })}
    </span>
  );
}

/* ===== 连线组件 ===== */
function Edge({ from, to }: { from: LayoutNode; to: LayoutNode }) {
  const toIsLeft = to.x + to.width < from.x;
  let x1: number, y1: number, x2: number, y2: number;
  if (toIsLeft) {
    x1 = from.x;
    y1 = from.y + from.height / 2;
    x2 = to.x + to.width;
    y2 = to.y + to.height / 2;
  } else {
    x1 = from.x + from.width;
    y1 = from.y + from.height / 2;
    x2 = to.x;
    y2 = to.y + to.height / 2;
  }
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
  onToggleCollapse, isMobile, onContextMenu, nodeData,
  markerIcons, isSearchMatch, isSearchActive, onDragStart, onDragOver, onDragLeave, onDrop, isDragTarget,
}: {
  node: LayoutNode;
  isSelected: boolean;
  isEditing: boolean;
  editValue: string;
  onSelect: (e?: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  onToggleCollapse: () => void;
  isMobile: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  nodeData?: MindMapNode;
  markerIcons?: React.ReactNode;
  isSearchMatch?: boolean;
  isSearchActive?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragTarget?: boolean;
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
            isSelected && "ring-2 ring-indigo-400/60 ring-offset-1 dark:ring-offset-zinc-900 shadow-sm", isSearchMatch && "ring-2 ring-amber-400/70", isSearchActive && "ring-2 ring-amber-500 shadow-lg shadow-amber-500/20", isDragTarget && "ring-2 ring-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/20"
          )}
          style={{
            background: nodeData?.style?.bg || color.bg,
            color: nodeData?.style?.color || color.text,
            border: `1.5px solid ${nodeData?.style?.border || color.border}`,
            fontSize: isRoot ? 14 : 13,
            fontWeight: isRoot ? 700 : 500,
          }}
          draggable={!!onDragStart}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
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
          {markerIcons}
          {nodeData?.link && (<a href={nodeData.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center mr-1 shrink-0 text-blue-500 hover:text-blue-600"><ExternalLink size={10} /></a>)}
          {nodeData?.note && (<span className="inline-flex items-center mr-0.5 shrink-0 text-amber-500" title={nodeData.note}><StickyNote size={10} /></span>)}
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

    </g>
  );
}

/* ===== 列表项组件 ===== */

/* ===== Floating toolbar: HTML absolute overlay ===== */
function FloatingToolbar({
  position, isRoot, isMobile,
  onAddChild, onAddSibling, onEdit, onDelete, onAddMarker, onSetLink, onSetNote, onSetColor, currentStyle, onApplyTheme, onStartRelation, onCreateBoundary, onFocusNode, onCopy, onCut, onPaste, t,
}: {
  position: { x: number; y: number };
  isRoot: boolean;
  isMobile: boolean;
  onAddChild: () => void;
  onAddSibling: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddMarker: (marker: string) => void;
  onSetLink: (link: string) => void;
  onSetNote: (note: string) => void;
  onSetColor: (style: { bg: string; color: string; border: string } | undefined) => void;
  currentStyle?: { bg?: string; color?: string; border?: string };
  onApplyTheme: (idx: number) => void;
  onStartRelation: () => void;
  onCreateBoundary: () => void;
  onFocusNode?: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  t: (key: string) => string;
}) {
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  
  useEffect(() => {
    if (!showMore) return;
    const close = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMore(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showMore]);

  return (
    <div className="absolute z-40 flex items-center gap-1"
      style={{ left: position.x, top: position.y, transform: "translateX(-50%)" }}>
      <button className={cn("flex items-center gap-1 rounded-md bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-md", isMobile ? "px-3 py-2 text-xs" : "px-2 py-1 text-[11px]")}
        onClick={(e) => { e.stopPropagation(); onAddChild(); }}>
        <Plus size={isMobile ? 14 : 10} />
        <span className="hidden sm:inline">{t("mindMap.addChild")}</span>
      </button>
      {!isRoot && (
        <button className={cn("flex items-center gap-1 rounded-md bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-900/50 transition-colors shadow-md", isMobile ? "px-3 py-2 text-xs" : "px-2 py-1 text-[11px]")}
          onClick={(e) => { e.stopPropagation(); onAddSibling(); }}>
          <MoreHorizontal size={isMobile ? 14 : 10} />
          <span className="hidden sm:inline">{t("mindMap.addSibling")}</span>
        </button>
      )}
      <button className={cn("flex items-center gap-1 rounded-md bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors shadow-md", isMobile ? "px-3 py-2 text-xs" : "px-2 py-1 text-[11px]")}
        onClick={(e) => { e.stopPropagation(); onEdit(); }}>
        <Edit2 size={isMobile ? 14 : 10} />
        <span className="hidden sm:inline">{t("mindMap.editNode")}</span>
      </button>
      <div className="relative" ref={moreRef}>
        <button className={cn("rounded-md bg-zinc-100 dark:bg-zinc-700 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors shadow-md", isMobile ? "p-2" : "p-1")}
          onClick={(e) => { e.stopPropagation(); setShowMore(!showMore); }}>
          <MoreHorizontal size={isMobile ? 14 : 10} />
        </button>
        {showMore && (
          <div className="absolute top-full mt-1 right-0 min-w-[180px] py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 z-50 max-h-[300px] overflow-auto">
            <div className="px-3 py-1 text-[10px] text-tx-tertiary uppercase tracking-wider">{t("mindMap.markers")}</div>
            {[{ key: "done", label: "\u2705 Done" }, { key: "todo", label: "\u2611 Todo" }, { key: "priority-high", label: "\u26a0 High" }, { key: "warning", label: "\u26a0 Warning" }, { key: "idea", label: "\u2b50 Idea" }, { key: "pin", label: "\u1f4cc Pin" }].map((m) => (
              <button key={m.key} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                onClick={(e) => { e.stopPropagation(); onAddMarker(m.key); setShowMore(false); }}>
                {m.label}
              </button>
            ))}
            <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
            <div className="px-3 py-1 text-[10px] text-tx-tertiary uppercase tracking-wider">{t("mindMap.nodeColors")}</div>
            <div className="flex flex-wrap gap-1 px-3 py-1">
              {currentStyle?.bg && (
                <button className="w-6 h-6 rounded-full border-2 border-zinc-400 flex items-center justify-center text-[10px]"
                  onClick={(e) => { e.stopPropagation(); onSetColor(undefined); setShowMore(false); }} title={t("mindMap.clearColor")}>\u2715</button>
              )}
              {NODE_COLORS.map((nc) => (
                <button key={nc.bg} className="w-6 h-6 rounded-full border border-zinc-300 dark:border-zinc-600 hover:scale-110 transition-transform"
                  style={{ background: nc.bg }} title={nc.bg}
                  onClick={(e) => { e.stopPropagation(); onSetColor({ bg: nc.bg, color: nc.color, border: nc.bg }); setShowMore(false); }} />
              ))}
            </div>
            <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                const link = window.prompt(t("mindMap.enterLink"), "https://");
                if (link !== null) onSetLink(link);
                setShowMore(false);
              }}>
              <LinkIcon size={14} className="text-blue-500" /> {t("mindMap.setLink")}
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                const note = window.prompt(t("mindMap.enterNote"), "");
                if (note !== null) onSetNote(note);
                setShowMore(false);
              }}>
              <StickyNote size={14} className="text-amber-500" /> {t("mindMap.setNote")}
            </button>
            <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
            <div className="px-3 py-1 text-[10px] text-tx-tertiary uppercase tracking-wider">{t("mindMap.themes")}</div>
            {THEME_TEMPLATES.map((theme, idx) => (
              <button key={theme.name} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                onClick={(e) => { e.stopPropagation(); onApplyTheme(idx); setShowMore(false); }}>
                <span className="flex gap-0.5">{theme.colors.map((c, ci) => <span key={ci} className="w-3 h-3 rounded-full" style={{ background: c.bg }} />)}</span>
                {theme.name}
              </button>
            ))}
            <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
            {onFocusNode && (
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => { e.stopPropagation(); onFocusNode(); setShowMore(false); }}>
              <Scan size={14} className="text-emerald-500" /> {t("mindMap.focusNode")}
            </button>
            )}
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => { e.stopPropagation(); onCopy(); setShowMore(false); }}>
              <span className="text-[14px]">⎘</span> {t("mindMap.copyNode")} <span className="ml-auto text-[10px] text-tx-tertiary">Ctrl+C</span>
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => { e.stopPropagation(); onCut(); setShowMore(false); }}>
              <span className="text-[14px]">✂</span> {t("mindMap.cutNode")} <span className="ml-auto text-[10px] text-tx-tertiary">Ctrl+X</span>
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => { e.stopPropagation(); onPaste(); setShowMore(false); }}>
              <span className="text-[14px]">⧉</span> {t("mindMap.pasteNode")} <span className="ml-auto text-[10px] text-tx-tertiary">Ctrl+V</span>
            </button>
            <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => { e.stopPropagation(); onStartRelation(); setShowMore(false); }}>
              <Spline size={14} className="text-amber-500" /> {t("mindMap.addRelation")}
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              onClick={(e) => { e.stopPropagation(); onCreateBoundary(); setShowMore(false); }}>
              <Square size={14} className="text-cyan-500" /> {t("mindMap.addBoundary")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== Outline panel ===== */
function OutlinePanel({
  mapData, selectedNodeId, onSelectNode, onAddChild, onEdit, onToggleCollapse,
  editNodeId, editValue, onEditChange, onEditSubmit, t,
}: {
  mapData: MindMapData;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEdit: (nodeId: string, text: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  editNodeId: string | null;
  editValue: string;
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  t: (key: string) => string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editNodeId && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editNodeId]);

  const renderNode = (node: MindMapNode, depth: number) => {
    const hasChildren = node.children && node.children.length > 0;
    const isEditing = editNodeId === node.id;
    const isSelected = selectedNodeId === node.id;
    return (
      <div key={node.id}>
        <div className={cn("flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-sm transition-colors group",
          isSelected && "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300",
          !isSelected && "hover:bg-zinc-100 dark:hover:bg-zinc-700/50 text-tx-primary"
        )} style={{ paddingLeft: depth * 20 + 8 }}
          onClick={() => onSelectNode(node.id)} onDoubleClick={() => onEdit(node.id, node.text)}>
          {hasChildren ? (
            <button className="p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-600 rounded transition-colors"
              onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id); }}>
              {node.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : <span className="w-4" />}
          {isEditing ? (
            <input ref={inputRef} value={editValue} onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEditSubmit(); } if (e.key === "Escape") onEditSubmit(); }}
              onBlur={onEditSubmit} className="flex-1 bg-transparent outline-none border-b border-indigo-400 text-sm min-w-0" />
          ) : <span className="truncate flex-1 text-xs">{node.text}</span>}
        </div>
        {hasChildren && !node.collapsed && <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b border-app-border flex items-center gap-2">
        <PanelLeft size={14} className="text-indigo-500" />
        <span className="text-xs font-semibold text-tx-primary">{t("mindMap.outline")}</span>
      </div>
      <div className="flex-1 overflow-auto p-1">{renderNode(mapData.root, 0)}</div>
    </div>
  );
}
function MindMapListRow({
  item, isActive, onSelect, onDelete, onContextMenu, onToggleStar, onDragStart, onDragEnd, isDropTarget,
}: {
  item: MindMapListItem;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onToggleStar?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  isDropTarget?: boolean;
}) {
  const date = new Date(item.updatedAt + (item.updatedAt.endsWith("Z") ? "" : "Z"));
  const dateStr = date.toLocaleDateString();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 工作区下展示创建者（与 Note/Task/Diary 一致）。User 图标本身具语义，
  // 此处不再额外加 i18n 文案前缀，节省横向空间。
  const showCreator =
    !!item.creatorName && getCurrentWorkspace() !== "personal";

  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-3 py-2.5 rounded-md transition-all cursor-pointer border-l-2",
        isActive
          ? "border-l-indigo-500 bg-indigo-50/40 dark:bg-indigo-500/10"
          : isDropTarget
          ? "border-l-emerald-500 bg-emerald-50/40 dark:bg-emerald-500/10"
          : "border-l-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      )}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
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
        <div className="flex items-center gap-2 text-xs text-tx-tertiary mt-0.5 min-w-0">
          <span className="shrink-0">{dateStr}</span>
          {showCreator && (
            <>
              <span className="text-tx-tertiary/60 shrink-0">·</span>
              <span
                className="flex items-center gap-1 truncate"
                title={item.creatorName ?? ""}
              >
                <UserIcon size={11} className="shrink-0" />
                <span className="truncate">{item.creatorName}</span>
              </span>
            </>
          )}
        </div>
      </div>
      {onToggleStar && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all flex-shrink-0"
        >
          <Star size={14} className={item.starred ? "fill-amber-400 text-amber-400" : "text-tx-tertiary hover:text-amber-400"} />
        </button>
      )}
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
  const [folders, setFolders] = useState<any[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

  // 加载文件夹
  const loadFolders = useCallback(async () => {
    try {
      const data = await api.getMindMapFolders();
      setFolders(data);
    } catch (err) {
      console.error("Failed to load folders:", err);
    }
  }, []);
  const [activeMap, setActiveMap] = useState<MindMap | null>(null);
  const [mapData, setMapData] = useState<MindMapData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<{ node: MindMapNode; isCut: boolean } | null>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dragMapId, setDragMapId] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  useEffect(() => { setSelectedNodeIds([]); setClipboard(null); setFocusedNodeId(null); }, [activeMap?.id]);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 60, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [listSearch, setListSearch] = useState("");
  const [showStarredOnly, setShowStarredOnly] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  // 节点搜索
  useEffect(() => {
    if (!searchQuery.trim() || !mapData) { setSearchResults([]); setSearchIndex(0); return; }
    const q = searchQuery.trim().toLowerCase();
    const results: string[] = [];
    const walk = (n: MindMapNode) => {
      if (n.text.toLowerCase().includes(q) || n.note?.toLowerCase().includes(q) || n.link?.toLowerCase().includes(q)) {
        results.push(n.id);
      }
      n.children?.forEach(walk);
    };
    walk(mapData.root);
    setSearchResults(results);
    setSearchIndex(results.length > 0 ? 0 : -1);
  }, [searchQuery, mapData]);

  // 自动展开匹配节点的父级 + 居中
  useEffect(() => {
    if (searchResults.length === 0 || searchIndex < 0 || !mapData) return;
    const targetId = searchResults[searchIndex];
    const expandParents = (node: MindMapNode, path: MindMapNode[]): boolean => {
      if (node.id === targetId) {
        path.forEach(p => { if (p.collapsed) p.collapsed = false; });
        return true;
      }
      return node.children?.some(c => expandParents(c, [...path, node])) ?? false;
    };
    const newRoot = JSON.parse(JSON.stringify(mapData.root));
    expandParents(newRoot, []);
    if (JSON.stringify(newRoot) !== JSON.stringify(mapData.root)) {
      setMapData({ ...mapData, root: newRoot });
    }
    const targetNode = layoutNodes.find(n => n.id === targetId);
    if (targetNode && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const cx = targetNode.x + targetNode.width / 2;
      const cy = targetNode.y + targetNode.height / 2;
      setPan({ x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom });
    }
    setSelectedNodeId(targetId);
  }, [searchIndex, searchResults]);

  // Ctrl+F 打开搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && activeMap) {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
        setSearchQuery("");
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showSearch, activeMap]);

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
    loadMaps(); loadFolders();
  }, [loadMaps]);

  // 工作区切换：清空当前打开的导图 + 重拉列表，避免显示其他 scope 的图
  useEffect(() => {
    const onWs = () => {
      setActiveMap(null);
      setMapData(null);
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setEditingNodeId(null);
      loadMaps();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [loadMaps]);

  // 选择一个导图
  // 收藏/取消收藏
  const handleToggleStar = useCallback(async (mapId: string) => {
    try {
      const updated = await api.toggleStarMindMap(mapId);
      setMaps((prev) => prev.map((m) => m.id === mapId ? { ...m, starred: (updated as any).starred } : m));
    } catch (err) {
      console.error("Failed to toggle star:", err);
    }
  }, []);

  const handleSelect = useCallback(async (id: string) => {
    try {
      const map = await api.getMindMap(id);
      setActiveMap(map);
      try {
        const parsed = JSON.parse(map.data);
        setMapData(parsed);
        setLayoutMode(parsed.layout || "right");
        // Initialize history
        const entry: HistoryEntry = { data: JSON.parse(JSON.stringify(parsed)) };
        historyRef.current = { stack: [entry], idx: 0 };
        setHistory([entry]);
        setHistoryIndex(0);
      } catch {
        setMapData({ root: { id: "root", text: map.title, children: [] } });
      }
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      setEditingNodeId(null);
      setZoom(1);
      setPan({ x: 60, y: 0 });
    } catch (err) {
      console.error("Failed to load mindmap:", err);
    }
  }, []);

  // 监听来自笔记编辑器的"保存为思维导图"事件 + sessionStorage 持久化
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (id) {
        sessionStorage.setItem("pendingOpenMindMapId", id);
        loadMaps().then(() => handleSelect(id));
      }
    };
    window.addEventListener("nowen:open-mindmap", handler);

    // 组件挂载时检查是否有待打开的导图（从笔记编辑器保存后切换过来的）
    const pendingId = sessionStorage.getItem("pendingOpenMindMapId");
    if (pendingId) {
      sessionStorage.removeItem("pendingOpenMindMapId");
      loadMaps().then(() => handleSelect(pendingId));
    }

    return () => window.removeEventListener("nowen:open-mindmap", handler);
  }, [loadMaps, handleSelect]);

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

  // Undo/Redo
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef<{ stack: HistoryEntry[]; idx: number }>({ stack: [], idx: -1 });

  const pushHistory = useCallback((data: MindMapData, title?: string) => {
    const h = historyRef.current;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push({ data: JSON.parse(JSON.stringify(data)), title });
    if (h.stack.length > MAX_HISTORY) h.stack.shift();
    h.idx = h.stack.length - 1;
    setHistory([...h.stack]);
    setHistoryIndex(h.idx);
  }, []);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const handleUndo = useCallback(() => {
    const h = historyRef.current;
    if (h.idx <= 0) return;
    h.idx--;
    const entry = h.stack[h.idx];
    setMapData(entry.data);
    setHistoryIndex(h.idx);
    triggerSave(entry.data, entry.title);
  }, [triggerSave]);

  const handleRedo = useCallback(() => {
    const h = historyRef.current;
    if (h.idx >= h.stack.length - 1) return;
    h.idx++;
    const entry = h.stack[h.idx];
    setMapData(entry.data);
    setHistoryIndex(h.idx);
    triggerSave(entry.data, entry.title);
  }, [triggerSave]);

  // Outline mode
  const [showOutline, setShowOutline] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"right" | "left-right">("right");


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

  const findParentNode = useCallback(
    (root: MindMapNode, nodeId: string, parent: MindMapNode | null = null): MindMapNode | null => {
      if (root.id === nodeId) return parent;
      for (const c of root.children) {
        const found = findParentNode(c, nodeId, root);
        if (found) return found;
      }
      return null;
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
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditValue(newNode.text);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, updateNode, triggerSave, t]);

  // 操作：添加同级节点
  const handleAddSibling = useCallback((nodeId: string) => {
    if (!mapData || nodeId === "root") {
      toast.error(t("mindMap.cannotAddSiblingToRoot"));
      return;
    }
    const parent = findParentNode(mapData.root, nodeId);
    if (!parent) return;
    const newId = `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newNode: MindMapNode = { id: newId, text: t("mindMap.newNode"), children: [] };
    const idx = parent.children.findIndex(c => c.id === nodeId);
    const newParent = {
      ...parent,
      children: [
        ...parent.children.slice(0, idx + 1),
        newNode,
        ...parent.children.slice(idx + 1),
      ],
    };
    const newRoot = updateNode(mapData.root, parent.id, () => newParent);
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditValue(newNode.text);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, findParentNode, updateNode, triggerSave, t]);

  // 操作：删除节点
  const handleDeleteNode = useCallback((nodeId: string) => {
    if (!mapData || nodeId === "root") return;
    const newRoot = removeNode(mapData.root, nodeId);
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    setSelectedNodeId(null);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, removeNode, triggerSave]);

  // 操作：编辑提交
  const handleEditSubmit = useCallback(() => {
    if (!mapData || !editingNodeId) return;
    const trimmed = editValue.trim() || t("mindMap.newNode");
    const newRoot = updateNode(mapData.root, editingNodeId, (n) => ({ ...n, text: trimmed }));
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    pushHistory(newData);
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
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, updateNode, triggerSave]);

  const handleAddMarker = useCallback((marker: string) => {
    if (!mapData || !selectedNodeId) return;
    const node = findNode(mapData.root, selectedNodeId);
    if (!node) return;
    const existing = node.markers || [];
    const newMarkers = existing.includes(marker as any)
      ? existing.filter(m => m !== marker)
      : [...existing, marker as any];
    const newRoot = updateNode(mapData.root, selectedNodeId, (n) => ({
      ...n,
      markers: newMarkers.length > 0 ? newMarkers : undefined,
    }));
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, selectedNodeId, findNode, updateNode, triggerSave, pushHistory]);

  const handleSetLink = useCallback((link: string) => {
    if (!mapData || !selectedNodeId) return;
    const newRoot = updateNode(mapData.root, selectedNodeId, (n) => ({ ...n, link: link || undefined }));
    const newData = { ...mapData, root: newRoot }; setMapData(newData); pushHistory(newData); triggerSave(newData);
  }, [mapData, selectedNodeId, updateNode, triggerSave, pushHistory]);

  const handleSetNote = useCallback((note: string) => {
    if (!mapData || !selectedNodeId) return;
    const newRoot = updateNode(mapData.root, selectedNodeId, (n) => ({ ...n, note: note || undefined }));
    const newData = { ...mapData, root: newRoot }; setMapData(newData); pushHistory(newData); triggerSave(newData);
  }, [mapData, selectedNodeId, updateNode, triggerSave, pushHistory]);


  // Theme application
  const [currentTheme, setCurrentTheme] = useState<string | undefined>(undefined);

  const handleApplyTheme = useCallback((themeIdx: number) => {
    if (!mapData) return;
    const theme = THEME_TEMPLATES[themeIdx];
    if (!theme) return;
    const rootColor = theme.colors[0];
    function applyTheme(node: MindMapNode, depth: number): MindMapNode {
      const colorSet = theme.colors[Math.min(depth, theme.colors.length - 1)];
      return {
        ...node,
        style: { bg: colorSet.bg, color: colorSet.text, border: colorSet.border },
        children: (node.children || []).map(c => applyTheme(c, depth + 1)),
      };
    }
    const newData = { ...mapData, root: applyTheme(mapData.root, 0), theme: theme.name };
    setMapData(newData);
    setCurrentTheme(theme.name);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, pushHistory, triggerSave]);

  // Relation drawing mode
  const [drawingRelation, setDrawingRelation] = useState(false);
  const [relationStart, setRelationStart] = useState<string | null>(null);

  const handleRelationClick = useCallback((nodeId: string) => {
    if (!drawingRelation) return;
    if (!relationStart) {
      setRelationStart(nodeId);
      toast.success(t("mindMap.relationStart"));
      return;
    }
    if (relationStart === nodeId) { setRelationStart(null); return; }
    if (!mapData) return;
    const existing = mapData.relations || [];
    const dup = existing.find(r => r.fromId === relationStart && r.toId === nodeId);
    if (dup) { setRelationStart(null); setDrawingRelation(false); return; }
    const newRelation: MindMapRelation = {
      id: "rel_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      fromId: relationStart,
      toId: nodeId,
    };
    const newData = { ...mapData, relations: [...existing, newRelation] };
    setMapData(newData);
    pushHistory(newData);
    triggerSave(newData);
    setRelationStart(null);
    setDrawingRelation(false);
    toast.success(t("mindMap.relationCreated"));
  }, [drawingRelation, relationStart, mapData, pushHistory, triggerSave, t]);

  // Boundary creation
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());

  const handleCreateBoundary = useCallback(() => {
    if (!mapData || selectedNodes.size < 2) {
      toast.error(t("mindMap.selectNodesFirst"));
      return;
    }
    const existing = mapData.boundaries || [];
    const colors = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
    const color = colors[existing.length % colors.length];
    const boundary: MindMapBoundary = {
      id: "bnd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      nodeIds: Array.from(selectedNodes),
      color,
    };
    const newData = { ...mapData, boundaries: [...existing, boundary] };
    setMapData(newData);
    pushHistory(newData);
    triggerSave(newData);
    setSelectedNodes(new Set());
    toast.success(t("mindMap.boundaryCreated"));
  }, [mapData, selectedNodes, pushHistory, triggerSave, t]);
  const handleSetColor = useCallback((style: { bg: string; color: string; border: string } | undefined) => {
    if (!mapData || !selectedNodeId) return;
    const newRoot = updateNode(mapData.root, selectedNodeId, (n) => ({ ...n, style: style || undefined }));
    const newData = { ...mapData, root: newRoot }; setMapData(newData); pushHistory(newData); triggerSave(newData);
  }, [mapData, selectedNodeId, updateNode, triggerSave, pushHistory]);

  // 创建新导图
  const handleImportMarkdown = useCallback(async () => {
    const md = window.prompt(t("mindMap.enterMarkdown"));
    if (!md) return;
    try {
      const data = markdownToMindMapData(md);
      const title = data.root.text.slice(0, 50) || t("mindMap.untitled");
      const created = await api.createMindMap({ title, data: JSON.stringify(data) });
      setMaps((prev) => [{ id: created.id, userId: created.userId, workspaceId: created.workspaceId, title: created.title, createdAt: created.createdAt, updatedAt: created.updatedAt }, ...prev]);
      handleSelect(created.id);
      toast.success(t("mindMap.importSuccess"));
    } catch (e: any) {
      toast.error(e?.message || t("mindMap.importFailed"));
    }
  }, [handleSelect, t]);

  const handleExportMarkdown = useCallback(() => {
    if (!mapData) return;
    const md = mindMapDataToMarkdown(mapData);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeMap?.title || "mindmap"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [mapData, activeMap]);

  // ????
  const MINDMAP_TEMPLATES = useMemo(() => [
    { name: t("mindMap.templateBlank"), icon: "📜", data: null },
    { name: t("mindMap.templateProject"), icon: "💻", data: { root: { id: "root", text: t("mindMap.templateProject"), children: [
      { id: "n1", text: "目标", children: [{ id: "n1a", text: "核心目标", children: [] }, { id: "n1b", text: "关键指标", children: [] }] },
      { id: "n2", text: "任务", children: [{ id: "n2a", text: "待办", children: [] }, { id: "n2b", text: "进行中", children: [] }, { id: "n2c", text: "已完成", children: [] }] },
      { id: "n3", text: "时间线", children: [{ id: "n3a", text: "Q1", children: [] }, { id: "n3b", text: "Q2", children: [] }] },
    ] } } },
    { name: t("mindMap.templateMeeting"), icon: "📝", data: { root: { id: "root", text: "会议纪要", children: [
      { id: "n1", text: "参会人", children: [] },
      { id: "n2", text: "议题", children: [{ id: "n2a", text: "议题 1", children: [{ id: "n2a1", text: "结论", children: [] }, { id: "n2a2", text: "待跟进", children: [] }] }] },
      { id: "n3", text: "行动项", children: [{ id: "n3a", text: "负责人 | 截止日期", children: [] }] },
    ] } } },
    { name: t("mindMap.templateReading"), icon: "📚", data: { root: { id: "root", text: "读书笔记", children: [
      { id: "n1", text: "书名 / 作者", children: [] },
      { id: "n2", text: "核心观点", children: [{ id: "n2a", text: "观点 1", children: [] }, { id: "n2b", text: "观点 2", children: [] }] },
      { id: "n3", text: "重要摘录", children: [] },
      { id: "n4", text: "我的思考", children: [] },
    ] } } },
    { name: t("mindMap.templateAnalysis"), icon: "🔍", data: { root: { id: "root", text: "问题分析", children: [
      { id: "n1", text: "问题描述", children: [] },
      { id: "n2", text: "原因分析", children: [{ id: "n2a", text: "根因 1", children: [] }, { id: "n2b", text: "根因 2", children: [] }] },
      { id: "n3", text: "解决方案", children: [{ id: "n3a", text: "方案 A", children: [] }, { id: "n3b", text: "方案 B", children: [] }] },
      { id: "n4", text: "行动计划", children: [] },
    ] } } },
  ], [t]);

  const handleCreateWithTemplate = useCallback(async (templateIdx: number) => {
    setShowTemplates(false);
    try {
      const template = MINDMAP_TEMPLATES[templateIdx];
      const title = templateIdx === 0 ? t("mindMap.untitled") : template.name;
      const data = template.data ? JSON.stringify(template.data) : undefined;
      const map = await api.createMindMap({ title, data });
      setMaps((prev) => [{ id: map.id, userId: map.userId, workspaceId: map.workspaceId, title: map.title, createdAt: map.createdAt, updatedAt: map.updatedAt }, ...prev]);
      handleSelect(map.id);
    } catch (err) {
      console.error("Failed to create mindmap:", err);
    }
  }, [handleSelect, t, MINDMAP_TEMPLATES]);

  const handleCreate = useCallback(async () => {
    setShowTemplates(true);
  }, []);


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

  // 全屏时锁定 body 滚动 + Esc 退出
  useEffect(() => {
    if (!isFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editingNodeId) setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    // 切换后触发 resize 适配画布
    const t = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [isFullscreen, editingNodeId]);

  // 平移（鼠标）
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.target === canvasRef.current) || (e.button === 0 && e.target === svgRef.current)) {
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

  // ?? wheel ?????passive: false ?? preventDefault ????????
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        setZoom((z) => {
          const newZoom = Math.max(0.3, Math.min(2.5, z + delta));
          const scale = newZoom / z;
          setPan((p) => ({
            x: mouseX - (mouseX - p.x) * scale,
            y: mouseY - (mouseY - p.y) * scale,
          }));
          return newZoom;
        });
      } else {
        setPan((p) => ({ x: p.x - e.deltaX * 0.5, y: p.y - e.deltaY * 0.5 }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
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

  // 拖拽移动节点到目标节点下
  const handleMoveNode = useCallback((sourceId: string, targetId: string) => {
    if (!mapData || sourceId === targetId) return;
    // 不能移动到自己的子树下
    const isDescendant = (root: MindMapNode, ancestorId: string, checkId: string): boolean => {
      if (root.id === ancestorId) {
        const walk = (n: MindMapNode): boolean => {
          if (n.id === checkId) return true;
          return n.children?.some(walk) ?? false;
        };
        return root.children?.some(walk) ?? false;
      }
      return root.children?.some(c => isDescendant(c, ancestorId, checkId)) ?? false;
    };
    if (isDescendant(mapData.root, sourceId, targetId)) return;
    const sourceNode = findNode(mapData.root, sourceId);
    if (!sourceNode) return;
    // 从原位置移除
    let newRoot = removeNode(mapData.root, sourceId);
    // 插入到目标节点下
    newRoot = updateNode(newRoot, targetId, (n) => ({
      ...n,
      collapsed: false,
      children: [...n.children, sourceNode],
    }));
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    pushHistory(newData);
    triggerSave(newData);
  }, [mapData, findNode, removeNode, updateNode, pushHistory, triggerSave]);

  // 复制节点
  const handleCopyNode = useCallback((nodeId: string) => {
    if (!mapData) return;
    const node = findNode(mapData.root, nodeId);
    if (!node) return;
    const cloneWithNewIds = (n: MindMapNode): MindMapNode => ({
      ...n,
      id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      children: n.children?.map(cloneWithNewIds) ?? [],
    });
    setClipboard({ node: cloneWithNewIds(node), isCut: false });
    toast.success(t("mindMap.copied"));
  }, [mapData, findNode, t]);

  // 剪切节点
  const handleCutNode = useCallback((nodeId: string) => {
    if (!mapData || nodeId === "root") return;
    const node = findNode(mapData.root, nodeId);
    if (!node) return;
    setClipboard({ node: JSON.parse(JSON.stringify(node)), isCut: true });
    toast.success(t("mindMap.cut"));
  }, [mapData, findNode, t]);

  // 粘贴节点为当前选中节点的子节点
  const handlePasteNode = useCallback(() => {
    if (!mapData || !clipboard || !selectedNodeId) return;
    const pasteNode = (src: MindMapNode): MindMapNode => ({
      ...src,
      id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      children: src.children?.map(pasteNode) ?? [],
    });
    const newNode = pasteNode(clipboard.node);
    let newRoot = updateNode(mapData.root, selectedNodeId, (n) => ({
      ...n,
      collapsed: false,
      children: [...n.children, newNode],
    }));
    if (clipboard.isCut) {
      newRoot = removeNode(newRoot, clipboard.node.id);
    }
    const newData = { ...mapData, root: newRoot };
    setMapData(newData);
    setSelectedNodeId(newNode.id);
    pushHistory(newData);
    triggerSave(newData);
    if (clipboard.isCut) setClipboard(null);
    toast.success(t("mindMap.pasted"));
  }, [mapData, clipboard, selectedNodeId, updateNode, removeNode, triggerSave, t]);

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!mapData) return;
      // Undo: Ctrl+Z
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        if (editingNodeId) return;
        e.preventDefault(); handleUndo(); return;
      }
      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        if (editingNodeId) return;
        e.preventDefault(); handleRedo(); return;
      }

      if (!selectedNodeId || editingNodeId) return;


      if (e.key === "Tab") {
        e.preventDefault();
        handleAddChild(selectedNodeId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNodeId !== "root") {
          e.preventDefault();
          handleDeleteNode(selectedNodeId);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleAddSibling(selectedNodeId);
      } else if (e.key === "F2") {
        e.preventDefault();
        const node = findNode(mapData.root, selectedNodeId);
        if (node) {
          setEditingNodeId(selectedNodeId);
          setEditValue(node.text);
        }
      } else if (e.key === " ") {
        e.preventDefault();
        handleToggleCollapse(selectedNodeId);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        handleCopyNode(selectedNodeId);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "x") {
        e.preventDefault();
        handleCutNode(selectedNodeId);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        e.preventDefault();
        handlePasteNode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mapData, selectedNodeId, editingNodeId, handleAddChild, handleAddSibling, handleDeleteNode, handleToggleCollapse, findNode, findParentNode, handleCopyNode, handleCutNode, handlePasteNode]);

  // 构建布局
  const { layoutNodes, edges, viewBox, bounds } = useMemo(() => {
    if (!mapData) return { layoutNodes: [], edges: [], viewBox: "0 0 800 600", bounds: { minX: 0, minY: 0, width: 800, height: 600 } };

    // ???????????????
    let layoutRoot = mapData.root;
    if (focusedNodeId) {
      const found = (function find(n: MindMapNode): MindMapNode | null {
        if (n.id === focusedNodeId) return n;
        for (const c of n.children) { const r = find(c); if (r) return r; }
        return null;
      })(mapData.root);
      if (found) layoutRoot = found;
    }
    const root = buildLayout(layoutRoot, 0, null);
    const treeH = getSubtreeHeight(root);
    if (layoutMode === "left-right" && root.children.length > 1) {
      // Split children: odd index right, even index left
      const leftChildren: LayoutNode[] = [];
      const rightChildren: LayoutNode[] = [];
      root.children.forEach((c, idx) => {
        if (idx % 2 === 0) rightChildren.push(c);
        else leftChildren.push(c);
      });
      root.children = rightChildren;
      // Create a virtual left root for layout
      if (leftChildren.length > 0) {
        const leftRoot: LayoutNode = { ...root, id: root.id + "-left", children: leftChildren };
        layoutTree(root, 0, treeH / 2);
        layoutTreeLeft(leftRoot, 0, treeH / 2);
        // Merge left children positions back
        leftChildren.forEach((c, i) => { root.children.push(c); });
      } else {
        layoutTree(root, 0, treeH / 2);
      }
    } else {
      layoutTree(root, 0, treeH / 2);
    }
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
  }, [mapData, layoutMode]);

  const [showMiniMap, setShowMiniMap] = useState(!isMobile);

  // 列表右键菜单
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folderId: string; folderName: string } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState("");
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
    <div className={cn(
      isFullscreen
        ? "fixed inset-0 z-[80] flex flex-col bg-app-bg"
        : "flex h-full w-full overflow-hidden"
    )}>
      {/* 移动端遮罩层 */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {!isFullscreen && (/* Left: Map List Panel */
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
        <div className="px-3 pb-2">
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-app-bg border border-app-border">
            <SearchIcon size={13} className="text-tx-tertiary flex-shrink-0" />
            <input
              type="text"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder={t("mindMap.searchNodes")}
              className="flex-1 bg-transparent text-xs text-tx-primary placeholder:text-tx-tertiary outline-none"
            />
            <button onClick={() => setShowStarredOnly(v => !v)} className={cn("p-0.5 rounded transition-colors", showStarredOnly ? "text-amber-400" : "text-tx-tertiary hover:text-amber-400")} title={t("mindMap.starred")}>
              <Star size={13} className={showStarredOnly ? "fill-amber-400" : ""} />
            </button>
            {listSearch && (
              <button onClick={() => setListSearch("")} className="text-tx-tertiary hover:text-tx-secondary">
                <span className="text-[10px]">✕</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-0.5">
          {isLoading ? (
            <div className="flex items-center justify-center h-20 text-tx-tertiary text-sm">
              {t("common.loading")}
            </div>
          ) : (() => {
            const q = listSearch.trim().toLowerCase();
            const filteredMaps = maps.filter(m => (!q || m.title.toLowerCase().includes(q)) && (!showStarredOnly || m.starred));
            const filteredFolders = folders.filter(f => !q || f.name.toLowerCase().includes(q));
            const topFolders = filteredFolders.filter((f: any) => !f.parentId);
            const childFolders = (parentId: string) => filteredFolders.filter((f: any) => f.parentId === parentId);
            const mapsInFolder = (folderId: string) => filteredMaps.filter(m => m.folderId === folderId);
            const uncategorized = filteredMaps.filter(m => !m.folderId);
            const hasResults = filteredMaps.length > 0 || filteredFolders.length > 0;

            const renderFolder = (folder: any, depth: number) => {
              const isExpanded = expandedFolders.has(folder.id);
              const children = childFolders(folder.id);
              const folderMaps = mapsInFolder(folder.id);
              return (
                <div key={folder.id}>
                  <div
                    className={cn("group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-sm", dropFolderId === folder.id && "ring-2 ring-emerald-400/60 bg-emerald-50/40 dark:bg-emerald-500/10")}
                    style={{ paddingLeft: depth * 16 + 8 }}
                    onClick={() => setExpandedFolders(prev => { const next = new Set(prev); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}
                    onDragOver={(e) => { if (dragMapId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropFolderId(folder.id); } }}
                    onDragLeave={() => { if (dropFolderId === folder.id) setDropFolderId(null); }}
                    onDrop={(e) => { e.preventDefault(); if (dragMapId) { api.moveMindMap(dragMapId, folder.id).then(() => { loadMaps(); loadFolders(); }); setDragMapId(null); setDropFolderId(null); } }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId: folder.id, folderName: folder.name }); }}
                  >
                    <ChevronRight size={12} className={cn("text-tx-tertiary transition-transform flex-shrink-0", isExpanded && "rotate-90")} />
                    <FolderIcon size={14} className={cn("flex-shrink-0", isExpanded ? "text-amber-500" : "text-tx-tertiary")} />
                    {renamingFolderId === folder.id ? (
                      <input
                        type="text"
                        value={renamingFolderName}
                        onChange={(e) => setRenamingFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && renamingFolderName.trim()) {
                            api.updateMindMapFolder(folder.id, { name: renamingFolderName.trim() }).then(() => { loadFolders(); setRenamingFolderId(null); });
                          }
                          if (e.key === "Escape") { setRenamingFolderId(null); }
                        }}
                        onBlur={() => {
                          if (renamingFolderName.trim() && renamingFolderName !== folder.name) {
                            api.updateMindMapFolder(folder.id, { name: renamingFolderName.trim() }).then(() => { loadFolders(); });
                          }
                          setRenamingFolderId(null);
                        }}
                        className="flex-1 bg-transparent text-sm text-tx-primary outline-none border-b border-indigo-400"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="flex-1 truncate text-tx-primary">{folder.name}</span>
                    )}
                    <span className="text-[10px] text-tx-tertiary">{folder.mindmapCount ?? 0}</span>
                    <button onClick={(e) => { e.stopPropagation(); if (confirm(t("mindMap.confirmDeleteFolder"))) { api.deleteMindMapFolder(folder.id).then(() => { loadFolders(); loadMaps(); }); } }} className="opacity-0 group-hover:opacity-100 text-tx-tertiary hover:text-accent-danger transition-all"><Trash2 size={12} /></button>
                  </div>
                  {isExpanded && (
                    <>
                      {children.map(f => renderFolder(f, depth + 1))}
                      {folderMaps.map(m => (
                        <div key={m.id} style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
                          <MindMapListRow item={m} isActive={activeMap?.id === m.id} onSelect={() => { handleSelect(m.id); if (isMobile) setSidebarOpen(false); }} onDelete={() => handleDeleteMap(m.id)} onContextMenu={(e) => handleListContextMenu(e, m)} onToggleStar={() => handleToggleStar(m.id)} onDragStart={(e) => { e.stopPropagation(); setDragMapId(m.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDragMapId(null); setDropFolderId(null); }} isDropTarget={false} />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              );
            };

            if (!hasResults && q) return (
              <div className="flex flex-col items-center justify-center h-32 text-tx-tertiary">
                <SearchIcon size={24} className="mb-2 opacity-30" />
                <span className="text-xs">{t("mindMap.noResults")}</span>
              </div>
            );

            if (!hasResults && !q) return (
              <div className="flex flex-col items-center justify-center h-32 text-tx-tertiary">
                <BrainCircuit size={32} className="mb-2 opacity-30" />
                <span className="text-xs">{t("mindMap.empty")}</span>
                <button onClick={handleCreate} className="mt-3 text-xs text-indigo-500 hover:text-indigo-600 font-medium">{t("mindMap.createFirst")}</button>
              </div>
            );

            return (
              <>
                <div className="pb-2">
                  <button onClick={() => setShowNewFolder(true)} className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-xs text-tx-tertiary hover:text-tx-secondary hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                    <FolderPlus size={13} /> {t("mindMap.newFolder")}
                  </button>
                  {showNewFolder && (
                    <div className="flex items-center gap-1 px-2 py-1">
                      <input type="text" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newFolderName.trim()) { api.createMindMapFolder({ name: newFolderName.trim() }).then(() => { loadFolders(); setShowNewFolder(false); setNewFolderName(""); }); } if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); } }} placeholder={t("mindMap.folderName")} className="flex-1 bg-transparent text-xs text-tx-primary placeholder:text-tx-tertiary outline-none border-b border-app-border py-0.5" autoFocus />
                    </div>
                  )}
                </div>
                {topFolders.map(f => renderFolder(f, 0))}
                {uncategorized.length > 0 && (
                  <div>
                    <div className={cn("rounded-md transition-colors", dropFolderId === "__uncategorized__" && "ring-2 ring-emerald-400/60 bg-emerald-50/40 dark:bg-emerald-500/10 p-1")} onDragOver={(e) => { if (dragMapId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropFolderId("__uncategorized__"); } }} onDragLeave={() => { if (dropFolderId === "__uncategorized__") setDropFolderId(null); }} onDrop={(e) => { e.preventDefault(); if (dragMapId) { api.moveMindMap(dragMapId, null).then(() => { loadMaps(); loadFolders(); }); setDragMapId(null); setDropFolderId(null); } }}>
                    {!q && topFolders.length > 0 && (
                      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] text-tx-tertiary uppercase tracking-wider">
                        {t("mindMap.uncategorized")}
                      </div>
                    )}
                    {uncategorized.map(m => (
                      <MindMapListRow key={m.id} item={m} isActive={activeMap?.id === m.id} onSelect={() => { handleSelect(m.id); if (isMobile) setSidebarOpen(false); }} onDelete={() => handleDeleteMap(m.id)} onContextMenu={(e) => handleListContextMenu(e, m)} onToggleStar={() => handleToggleStar(m.id)} onDragStart={(e) => { e.stopPropagation(); setDragMapId(m.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDragMapId(null); setDropFolderId(null); }} isDropTarget={false} />
                    ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </div>

      )}
      {/* Template selection modal */}
      {showTemplates && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowTemplates(false)}>
          <div className="bg-app-surface rounded-xl shadow-xl border border-app-border p-5 w-80 max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-tx-primary mb-3">{t("mindMap.chooseTemplate")}</h3>
            <div className="space-y-1">
              {MINDMAP_TEMPLATES.map((tpl, idx) => (
                <button
                  key={idx}
                  onClick={() => handleCreateWithTemplate(idx)}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left hover:bg-app-hover transition-colors"
                >
                  <span className="text-xl">{tpl.icon}</span>
                  <span className="text-sm text-tx-primary">{tpl.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Center: Mind Map Canvas */}
      <div className="flex-1 flex flex-col overflow-hidden bg-app-bg transition-colors" ref={containerRef}>
        {activeMap && mapData ? (
          <>
            {/* Toolbar */}
            <div className="px-2 sm:px-4 py-2 border-b border-app-border flex items-center justify-between bg-app-surface/50 gap-1">
              <div className="flex items-center gap-2 min-w-0">
                {focusedNodeId && (
                  <button
                    onClick={() => setFocusedNodeId(null)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors flex-shrink-0"
                  >
                    <Scan size={12} />
                    {t("mindMap.showAll")}
                  </button>
                )}
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
                {/* Edit: Undo / Redo */}
                <button onClick={handleUndo} disabled={!canUndo}
                  className={cn("p-1.5 rounded-md transition-colors", canUndo ? "hover:bg-app-hover text-tx-secondary" : "text-tx-tertiary/40 cursor-not-allowed")}
                  title={t("mindMap.undo")}><Undo2 size={16} /></button>
                {/* Redo */}
                <button onClick={handleRedo} disabled={!canRedo}
                  className={cn("p-1.5 rounded-md transition-colors", canRedo ? "hover:bg-app-hover text-tx-secondary" : "text-tx-tertiary/40 cursor-not-allowed")}
                  title={t("mindMap.redo")}><Redo2 size={16} /></button>
                <div className="w-px h-4 bg-app-border mx-0.5" />
                {/* View: Outline / Layout / Zoom / Fullscreen / MiniMap */}
                <button onClick={() => setShowOutline((v) => !v)}
                  className={cn("p-1.5 rounded-md transition-colors", showOutline ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-500" : "hover:bg-app-hover text-tx-secondary")}
                  title={t("mindMap.outline")}><PanelLeft size={16} /></button>
                <button
                  onClick={() => {
                    const newMode: "right" | "left-right" = layoutMode === "right" ? "left-right" : "right";
                    setLayoutMode(newMode);
                    if (mapData) {
                      const newData = { ...mapData, layout: newMode };
                      setMapData(newData);
                      triggerSave(newData);
                    }
                  }}
                  className={cn("p-1.5 rounded-md transition-colors",
                    layoutMode === "left-right" ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-500" : "hover:bg-app-hover text-tx-secondary")}
                  title={layoutMode === "right" ? t("mindMap.layoutRight") : t("mindMap.layoutBoth")}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="8" cy="8" r="3" />
                    <path d="M5 8H2M11 8h3" />
                    <path d="M2 5v6M14 5v6" />
                  </svg>
                </button>
                <div className="w-px h-4 bg-app-border mx-0.5" />
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
                  <Scan size={16} />
                </button>
                <div className="w-px h-4 bg-app-border mx-0.5" />
                <button
                  onClick={() => setIsFullscreen(v => !v)}
                  className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
                  title={isFullscreen ? t("mindMap.exitFullscreen") : t("mindMap.fullscreen")}
                >
                  {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
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
                {drawingRelation && (
                  <span className="text-xs text-amber-500 animate-pulse ml-1">{t("mindMap.drawingRelation")}</span>
                )}
                <button
                  onClick={handleExportMarkdown}
                  className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
                  title={t("mindMap.exportMarkdown")}
                >
                  <FileText size={16} />
                </button>
                <button
                  onClick={handleImportMarkdown}
                  className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
                  title={t("mindMap.importMarkdown")}
                >
                  <ArrowDownToLine size={16} />
                </button>
                <button
                  onClick={() => { setShowSearch(v => !v); setTimeout(() => searchInputRef.current?.focus(), 50); }}
                  className={cn("p-1.5 rounded-md transition-colors", showSearch ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-500" : "hover:bg-app-hover text-tx-secondary")}
                >
                  <SearchIcon size={16} />
                </button>
              </div>
            </div>
            {showSearch && (
              <div className="px-2 sm:px-4 py-1.5 border-b border-app-border bg-app-surface/30 flex items-center gap-2">
                <SearchIcon size={14} className="text-tx-tertiary flex-shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (e.shiftKey) setSearchIndex(i => searchResults.length > 0 ? (i - 1 + searchResults.length) % searchResults.length : -1);
                      else setSearchIndex(i => searchResults.length > 0 ? (i + 1) % searchResults.length : -1);
                    }
                    if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(""); }
                  }}
                  placeholder={t("mindMap.searchNodes")}
                  className="flex-1 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary outline-none"
                />
                <span className="text-xs text-tx-tertiary whitespace-nowrap">
                  {searchResults.length > 0 ? `${searchIndex + 1} / ${searchResults.length}` : searchQuery ? t("mindMap.noResults") : ""}
                </span>
                <button onClick={() => setSearchIndex(i => searchResults.length > 0 ? (i - 1 + searchResults.length) % searchResults.length : -1)} className="p-1 rounded hover:bg-app-hover text-tx-secondary disabled:opacity-30" disabled={searchResults.length === 0}><ChevronUp size={14} /></button>
                <button onClick={() => setSearchIndex(i => searchResults.length > 0 ? (i + 1) % searchResults.length : -1)} className="p-1 rounded hover:bg-app-hover text-tx-secondary disabled:opacity-30" disabled={searchResults.length === 0}><ChevronDown size={14} /></button>
                <button onClick={() => { setShowSearch(false); setSearchQuery(""); }} className="p-1 rounded hover:bg-app-hover text-tx-secondary"><span className="text-xs">✕</span></button>
              </div>
            )}

            <div className="flex-1 flex overflow-hidden">
              {showOutline && (
                <div className="w-[240px] min-w-[200px] border-r border-app-border bg-app-surface/50 shrink-0 overflow-hidden">
                  <OutlinePanel
                    mapData={mapData!}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(id) => { setSelectedNodeId(id); setEditingNodeId(null); }}
                    onAddChild={handleAddChild}
                    onEdit={(id, text) => { setEditingNodeId(id); setEditValue(text); }}
                    onToggleCollapse={handleToggleCollapse}
                    editNodeId={editingNodeId}
                    editValue={editValue}
                    onEditChange={setEditValue}
                    onEditSubmit={handleEditSubmit}
                    t={t}
                  />
                </div>
              )}
            <div
              className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing relative"
              style={{ userSelect: "none" }}
            >
              <div
                ref={canvasRef}
                className="absolute inset-0"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px)`,
                  userSelect: "none",
                  touchAction: "none",
                  cursor: "inherit",
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}

                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={(e) => { if (!e.ctrlKey && !e.metaKey) setSelectedNodeIds([]); setSelectedNodeId(null); setEditingNodeId(null); setDragNodeId(null); setDropTargetId(null); }}
              >
                <svg
                  ref={svgRef}
                  width="100%"
                  height="100%"
                  viewBox={viewBox}
                  style={{
                    transform: `scale(${zoom})`,
                    transformOrigin: "0 0",
                  }}
                >
                {/* Edges */}
                {edges.map((e, i) => (
                  <Edge key={`${e.from.id}-${e.to.id}-${i}`} from={e.from} to={e.to} />
                ))}
                {/* Relation lines */}
                {mapData?.relations?.map((rel) => {
                  const fromNode = layoutNodes.find(n => n.id === rel.fromId);
                  const toNode = layoutNodes.find(n => n.id === rel.toId);
                  if (!fromNode || !toNode) return null;
                  const fx = fromNode.x + fromNode.width / 2;
                  const fy = fromNode.y + fromNode.height / 2;
                  const tx = toNode.x + toNode.width / 2;
                  const ty = toNode.y + toNode.height / 2;
                  const mx = (fx + tx) / 2;
                  const my = (fy + ty) / 2 - 40;
                  return (
                    <g key={rel.id}>
                      <path
                        d={`M${fx},${fy} Q${mx},${my} ${tx},${ty}`}
                        fill="none"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        markerEnd="url(#arrowhead)"
                      />
                      {rel.label && <text x={mx} y={my - 6} textAnchor="middle" fontSize={11} fill="#f59e0b">{rel.label}</text>}
                    </g>
                  );
                })}
                {/* Arrowhead marker definition */}
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#f59e0b" />
                  </marker>
                </defs>
                {/* Boundary rectangles */}
                {mapData?.boundaries?.map((bnd) => {
                  const nodes = bnd.nodeIds
                    .map(id => layoutNodes.find(n => n.id === id))
                    .filter(Boolean) as LayoutNode[];
                  if (nodes.length < 2) return null;
                  const pad = 16;
                  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                  nodes.forEach(n => {
                    minX = Math.min(minX, n.x - pad);
                    minY = Math.min(minY, n.y - pad);
                    maxX = Math.max(maxX, n.x + n.width + pad);
                    maxY = Math.max(maxY, n.y + n.height + pad);
                  });
                  return (
                    <g key={bnd.id}>
                      <rect
                        x={minX} y={minY}
                        width={maxX - minX} height={maxY - minY}
                        rx={8} fill={bnd.color + "10"} stroke={bnd.color || "#6366f1"}
                        strokeWidth={2} strokeDasharray="8 4"
                      />
                      {bnd.label && <text x={minX + 8} y={minY - 4} fontSize={11} fill={bnd.color || "#6366f1"}>{bnd.label}</text>}
                    </g>
                  );
                })}

                {/* Nodes */}
                {((() => { const ids = selectedNodeIds.length > 0 ? selectedNodeIds : (selectedNodeId ? [selectedNodeId] : []); return ids.length > 0 ? [...layoutNodes.filter(n => !ids.includes(n.id)), ...layoutNodes.filter(n => ids.includes(n.id))] : layoutNodes; })()).map((n) => (
                  <NodeBox
                    key={n.id}
                    node={n}
                    isSelected={selectedNodeIds.length > 0 ? selectedNodeIds.includes(n.id) : selectedNodeId === n.id}
                    isSearchMatch={searchResults.includes(n.id)}
                    isSearchActive={searchResults.length > 0 && searchIndex >= 0 && searchResults[searchIndex] === n.id}
                    onDragStart={(e) => { e.stopPropagation(); setDragNodeId(n.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", n.id); }}
                    onDragOver={(e) => { if (dragNodeId && dragNodeId !== n.id) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; setDropTargetId(n.id); } }}
                    onDragLeave={() => { if (dropTargetId === n.id) setDropTargetId(null); }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragNodeId && dragNodeId !== n.id) { handleMoveNode(dragNodeId, n.id); } setDragNodeId(null); setDropTargetId(null); }}
                    isDragTarget={dropTargetId === n.id}
                    isEditing={editingNodeId === n.id}
                    editValue={editValue}
                    onSelect={(e?: React.MouseEvent) => { if (drawingRelation) { handleRelationClick(n.id); return; } if (e && (e.ctrlKey || e.metaKey)) { setSelectedNodeIds((ids) => ids.includes(n.id) ? ids.filter((id) => id !== n.id) : [...ids, n.id]); setSelectedNodeId(n.id); } else { setSelectedNodeIds([n.id]); setSelectedNodeId(n.id); }}}
                    onDoubleClick={() => {
                      setEditingNodeId(n.id);
                      setEditValue(n.text);
                    }}
                    onEditChange={setEditValue}
                    onEditSubmit={handleEditSubmit}
                    onToggleCollapse={() => handleToggleCollapse(n.id)}
                    isMobile={isMobile}
                    onContextMenu={(e) => e.preventDefault()}
                    markerIcons={<MarkerIcons markers={findNode(mapData.root, n.id)?.markers} />}
                    nodeData={findNode(mapData.root, n.id) ?? undefined}
                  />
                ))}
              </svg>

                {/* Floating toolbar: HTML absolute overlay */}
                {(() => {
                  if (!selectedNodeId || editingNodeId === selectedNodeId) return null;
                  const node = layoutNodes.find(n => n.id === selectedNodeId);
                  if (!node) return null;
                  return (
                    <FloatingToolbar
                      position={(() => {
                        const svg = svgRef.current;
                        const container = canvasRef.current;
                        if (!svg || !container) return { x: 0, y: 0 };
                        const point = svg.createSVGPoint();
                        point.x = node.x + node.width / 2;
                        point.y = node.y + node.height + 4;
                        const ctm = svg.getScreenCTM();
                        if (!ctm) return { x: 0, y: 0 };
                        const screen = point.matrixTransform(ctm);
                        const rect = container.getBoundingClientRect();
                        let x = screen.x - rect.left;
                        let y = screen.y - rect.top;
                        const toolbarWidth = 320;
                        const toolbarHeight = 36;
                        const pad = 8;
                        x = Math.max(pad, Math.min(x, rect.width - toolbarWidth - pad));
                        y = Math.max(pad, Math.min(y, rect.height - toolbarHeight - pad));
                        return { x, y };
                      })()}
                      isRoot={node.depth === 0} isMobile={isMobile}
                      onAddChild={() => handleAddChild(node.id)}
                      onAddSibling={() => handleAddSibling(node.id)}
                      onEdit={() => { setEditingNodeId(node.id); const n = findNode(mapData!.root, node.id); setEditValue(n?.text || ""); }}
                      onDelete={() => handleDeleteNode(node.id)}
                      onAddMarker={handleAddMarker}
                      onSetLink={handleSetLink}
                      onSetNote={handleSetNote}
                      onSetColor={handleSetColor}
                      currentStyle={findNode(mapData!.root, selectedNodeId)?.style}
                      onApplyTheme={handleApplyTheme}
                      onStartRelation={() => { setDrawingRelation(true); setRelationStart(selectedNodeId); toast.success(t("mindMap.relationStart")); }}
                      onCreateBoundary={handleCreateBoundary}
                      onFocusNode={() => setFocusedNodeId(selectedNodeId)}
                      onCopy={() => handleCopyNode(selectedNodeId)}
                      onCut={() => handleCutNode(selectedNodeId)}
                      onPaste={handlePasteNode}
                      t={t}
                    />
                  );
                })()}

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
            </div>
            </div>
            {!isMobile && (
            <div className="px-4 py-1.5 border-t border-app-border bg-app-surface/30 flex items-center gap-4 text-[11px] text-tx-tertiary">
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Tab</kbd> {t("mindMap.shortcutAdd")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Enter</kbd> {t("mindMap.shortcutEdit")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Del</kbd> {t("mindMap.shortcutDelete")}</span>
              <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Space</kbd> {t("mindMap.shortcutCollapse")}</span>
                <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Ctrl+Z</kbd> {t("mindMap.undo")}</span>
                <span><kbd className="px-1 py-0.5 rounded border border-app-border bg-app-bg text-[10px]">Ctrl+Y</kbd> {t("mindMap.redo")}</span>
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
      {/* Folder context menu */}
      {folderContextMenu && (() => {
        const close = () => setFolderContextMenu(null);
        return (
          <div className="fixed inset-0 z-50" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
            <div
              className="fixed z-50 min-w-[160px] py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800"
              style={{ left: Math.min(folderContextMenu.x, window.innerWidth - 180), top: Math.min(folderContextMenu.y, window.innerHeight - 120) }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-primary hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                onClick={() => { setRenamingFolderId(folderContextMenu.folderId); setRenamingFolderName(folderContextMenu.folderName); close(); }}
              >
                <Edit2 size={15} className="text-indigo-500" />
                {t("mindMap.renameFolder")}
              </button>
              <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                onClick={() => {
                  if (confirm(t("mindMap.confirmDeleteFolder"))) {
                    api.deleteMindMapFolder(folderContextMenu.folderId).then(() => { loadFolders(); loadMaps(); });
                  }
                  close();
                }}
              >
                <Trash2 size={15} />
                {t("mindMap.deleteFolder")}
              </button>
            </div>
          </div>
        );
      })()}

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

