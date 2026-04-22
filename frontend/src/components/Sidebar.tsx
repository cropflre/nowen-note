import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BookOpen, Plus, Star, Trash2, Search, ChevronRight,
  ChevronDown, PanelLeftClose, PanelLeft, ListTodo,
  Settings, LogOut, FilePlus, FolderPlus, Edit2, X, BrainCircuit,
  Bot, CalendarDays, Smile, GripVertical,
  FolderInput, Check, Home
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import SettingsModal from "@/components/SettingsModal";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import TagColorPicker from "@/components/TagColorPicker";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useApp, useAppActions } from "@/store/AppContext";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api, broadcastLogout } from "@/lib/api";
import { Notebook, ViewMode } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";

/* ===== Emoji 图标选择器 ===== */
const EMOJI_GROUPS = [
  {
    label: "objects",
    emojis: [
      "📒", "📓", "📔", "📕", "📗", "📘", "📙", "📚", "📖",
      "📝", "📄", "📋", "📁", "📂", "🗂️", "🗃️", "🗄️",
      "💼", "🎒", "👜", "📦", "🗑️", "📌", "📎", "🔗",
      "✂️", "🔍", "🔐", "🔑", "🛠️", "⚙️", "🧲", "🧪",
    ],
  },
  {
    label: "smileys",
    emojis: [
      "😊", "😎", "🤓", "🧐", "🤔", "💡", "⭐", "🌟",
      "❤️", "🔥", "✨", "🎯", "🎨", "🎵", "🎮", "🏆",
      "🚀", "💎", "🌈", "☀️", "🌙", "⚡", "💫", "🍀",
    ],
  },
  {
    label: "tech",
    emojis: [
      "💻", "🖥️", "⌨️", "🖱️", "🖨️", "📱", "📡", "🔌",
      "🧑‍💻", "⚛️", "🐍", "🦀", "☕", "🐳", "🐙", "🤖",
    ],
  },
  {
    label: "nature",
    emojis: [
      "🌸", "🌺", "🌻", "🌹", "🌿", "🍃", "🌲", "🌴",
      "🦋", "🐱", "🐶", "🦊", "🐼", "🐨", "🐸", "🦉",
    ],
  },
  {
    label: "food",
    emojis: [
      "🍎", "🍊", "🍋", "🍇", "🍓", "🍒", "🍰", "🍩",
      "☕", "🍵", "🧃", "🍺", "🧁", "🍕", "🌮", "🍣",
    ],
  },
];

function EmojiIconPicker({
  currentIcon,
  onSelect,
  onClose,
  position,
}: {
  currentIcon: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [activeGroup, setActiveGroup] = useState(0);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // 确保弹窗不溢出视口
  const [adjustedPos, setAdjustedPos] = useState(position);
  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      let { top, left } = position;
      if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
      if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
      if (top < 8) top = 8;
      if (left < 8) left = 8;
      setAdjustedPos({ top, left });
    }
  }, [position]);

  const groupLabels: Record<string, string> = {
    objects: t("sidebar.emojiObjects"),
    smileys: t("sidebar.emojiSmileys"),
    tech: t("sidebar.emojiTech"),
    nature: t("sidebar.emojiNature"),
    food: t("sidebar.emojiFood"),
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ duration: 0.15 }}
      className="fixed z-[70] w-[260px] bg-app-elevated rounded-xl border border-app-border shadow-2xl"
      style={{ top: adjustedPos.top, left: adjustedPos.left }}
    >
      {/* 分组标签 */}
      <div className="flex items-center gap-0.5 px-2 pt-2 pb-1 border-b border-app-border/50">
        {EMOJI_GROUPS.map((g, idx) => (
          <button
            key={g.label}
            onClick={() => setActiveGroup(idx)}
            className={cn(
              "px-2 py-1 rounded-md text-[10px] font-medium transition-colors",
              activeGroup === idx
                ? "bg-accent-primary/10 text-accent-primary"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
            )}
          >
            {groupLabels[g.label] || g.label}
          </button>
        ))}
      </div>

      {/* Emoji 网格 */}
      <div className="p-2 max-h-[200px] overflow-y-auto">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_GROUPS[activeGroup].emojis.map((emoji) => (
            <button
              key={emoji}
              onClick={() => { onSelect(emoji); onClose(); }}
              className={cn(
                "w-7 h-7 rounded-md flex items-center justify-center text-base transition-all",
                currentIcon === emoji
                  ? "bg-accent-primary/15 ring-1 ring-accent-primary/30 scale-110"
                  : "hover:bg-app-hover hover:scale-110"
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function buildTree(notebooks: Notebook[]): Notebook[] {
  const map = new Map<string, Notebook>();
  const roots: Notebook[] = [];
  notebooks.forEach((nb) => map.set(nb.id, { ...nb, children: [] }));
  notebooks.forEach((nb) => {
    const node = map.get(nb.id)!;
    if (nb.parentId && map.has(nb.parentId)) {
      map.get(nb.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });
  // 按 sortOrder 稳定排序，确保拖拽后的新顺序立即反映到 UI
  const byOrder = (a: Notebook, b: Notebook) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const sortRecursive = (list: Notebook[]) => {
    list.sort(byOrder);
    list.forEach((n) => {
      if (n.children && n.children.length > 0) sortRecursive(n.children);
    });
  };
  sortRecursive(roots);
  return roots;
}

/* ===== 移动笔记本：树形选择器条目 ===== */
function NotebookMoveTreeItem({
  notebook, depth, selectedId, disabledIds, currentParentId, onSelect,
}: {
  notebook: Notebook; depth: number;
  selectedId: string | null;
  disabledIds: Set<string>;          // 自身及子孙（禁用）
  currentParentId: string | null;    // 当前父级（显示"当前"标记）
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const hasChildren = !!notebook.children && notebook.children.length > 0;
  const isDisabled = disabledIds.has(notebook.id);
  const isSelected = selectedId === notebook.id;
  const isCurrent = currentParentId === notebook.id;

  return (
    <div>
      <button
        onClick={() => !isDisabled && onSelect(notebook.id)}
        disabled={isDisabled}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
          isDisabled
            ? "opacity-40 cursor-not-allowed text-tx-tertiary"
            : isSelected
            ? "bg-accent-primary/10 text-accent-primary"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}
        <span className="text-base shrink-0">{notebook.icon || "📒"}</span>
        <span className="truncate flex-1 text-left">{notebook.name}</span>
        {isCurrent && <span className="text-[10px] text-tx-tertiary shrink-0">{t('common.current')}</span>}
        {isSelected && <Check size={14} className="text-accent-primary shrink-0" />}
      </button>
      {hasChildren && expanded && notebook.children!.map((child) => (
        <NotebookMoveTreeItem
          key={child.id}
          notebook={child}
          depth={depth + 1}
          selectedId={selectedId}
          disabledIds={disabledIds}
          currentParentId={currentParentId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MoveNotebookModal({
  isOpen, notebook, allNotebooks, onMove, onClose,
}: {
  isOpen: boolean;
  notebook: Notebook | null;
  allNotebooks: Notebook[];
  onMove: (newParentId: string | null) => void;
  onClose: () => void;
}) {
  // selectedId: null → 未选择；"__ROOT__" → 根级；其他 → 目标父 id
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen) setSelectedId(null);
  }, [isOpen, notebook?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen || !notebook) return null;

  // 计算自身及所有后代 id（禁用）
  const disabledIds = new Set<string>();
  const collect = (id: string) => {
    disabledIds.add(id);
    for (const nb of allNotebooks) {
      if (nb.parentId === id) collect(nb.id);
    }
  };
  collect(notebook.id);

  const tree = buildTree(allNotebooks);
  const currentParentId = notebook.parentId ?? null;
  // 有效选中目标（包含 root）
  const selectedTarget: string | null | undefined =
    selectedId === "__ROOT__" ? null : selectedId;
  const isChanged =
    selectedId !== null &&
    (selectedTarget ?? null) !== currentParentId;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-[360px] mx-4 max-h-[480px] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2 min-w-0">
            <FolderInput size={16} className="text-accent-primary shrink-0" />
            <span className="text-sm font-medium text-tx-primary truncate">
              {t('sidebar.moveNotebookTitle')}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-tx-tertiary truncate border-b border-app-border">
          {notebook.icon} {notebook.name}
        </div>
        <ScrollArea className="flex-1 max-h-[300px]">
          <div className="p-2">
            {/* 根级选项 */}
            <button
              onClick={() => setSelectedId("__ROOT__")}
              disabled={currentParentId === null}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                currentParentId === null
                  ? "opacity-40 cursor-not-allowed text-tx-tertiary"
                  : selectedId === "__ROOT__"
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              )}
            >
              <span className="w-4 h-4 shrink-0" />
              <Home size={14} className="shrink-0" />
              <span className="truncate flex-1 text-left">{t('sidebar.moveToRoot')}</span>
              {currentParentId === null && (
                <span className="text-[10px] text-tx-tertiary shrink-0">{t('common.current')}</span>
              )}
              {selectedId === "__ROOT__" && <Check size={14} className="text-accent-primary shrink-0" />}
            </button>
            <div className="my-1 border-t border-app-border/50" />
            {tree.map((nb) => (
              <NotebookMoveTreeItem
                key={nb.id}
                notebook={nb}
                depth={0}
                selectedId={selectedId}
                disabledIds={disabledIds}
                currentParentId={currentParentId}
                onSelect={setSelectedId}
              />
            ))}
            {tree.length === 0 && (
              <p className="text-xs text-tx-tertiary text-center py-4">{/* 无数据 */}</p>
            )}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="sm"
            disabled={!isChanged}
            onClick={() => onMove(selectedTarget ?? null)}
            className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
          >
            {t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}



function NotebookItem({
  notebook, depth, onSelect, selectedId, onToggle, onContextMenu,
  editingId, editValue, onEditChange, onEditSubmit, onEditCancel,
  onIconChange,
  draggable, onDragStart, onDragOver, onDragEnd, onDrop, dragOverId, dragOverZone,
}: {
  notebook: Notebook; depth: number; onSelect: (id: string) => void;
  selectedId: string | null; onToggle: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  editingId: string | null; editValue: string;
  onEditChange: (v: string) => void; onEditSubmit: () => void; onEditCancel: () => void;
  onIconChange: (id: string, emoji: string) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, id: string) => void;
  onDragOver?: (e: React.DragEvent, id: string) => void;
  onDragEnd?: () => void;
  onDrop?: (e: React.DragEvent, id: string) => void;
  dragOverId?: string | null;
  dragOverZone?: "before" | "inside" | null;
}) {
  const { t } = useTranslation();
  const isSelected = selectedId === notebook.id;
  const hasChildren = notebook.children && notebook.children.length > 0;
  const isExpanded = notebook.isExpanded === 1;
  const isEditing = editingId === notebook.id;
  const isDragOver = dragOverId === notebook.id;
  const showBeforeIndicator = isDragOver && dragOverZone === "before";
  const showInsideIndicator = isDragOver && dragOverZone === "inside";
  const inputRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLButtonElement>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const getIconPickerPos = () => {
    if (iconRef.current) {
      const r = iconRef.current.getBoundingClientRect();
      return { top: r.bottom + 4, left: r.left };
    }
    return { top: 100, left: 100 };
  };

  return (
    <>
      {/* 拖拽"排序到之前"的蓝线指示器 */}
      {showBeforeIndicator && (
        <div
          className="h-0.5 bg-accent-primary rounded-full mx-2 my-0.5 pointer-events-none"
          style={{ marginLeft: `${depth * 16 + 16}px` }}
        />
      )}
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm group transition-colors",
          isSelected ? "bg-app-active text-tx-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
          // inside 放置指示：显著的内边框 + 背景高亮，让用户清楚"将作为子项放入"
          showInsideIndicator && "outline outline-2 outline-accent-primary bg-accent-primary/15"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(notebook.id)}
        onContextMenu={(e) => onContextMenu(e, notebook.id)}
        draggable={draggable && !isEditing}
        // framer-motion 的 motion.div 把 onDragStart/onDrag/onDragEnd 的类型
        // 重载为手势系统签名（MouseEvent | PointerEvent | TouchEvent + PanInfo），
        // 且没有暴露 React.DragEvent 的重载分支。但只有在 motion 组件显式设置
        // drag prop 时才启用手势；我们没启用，运行时 motion 会把这些 handler
        // 原样透传到底层 DOM 的 ondragstart/ondragover 等（HTML5 DnD）。
        // 因此用 `as any` 绕过 TS 的手势签名约束，运行时行为与原生 DnD 一致。
        onDragStart={((e: React.DragEvent) => { e.stopPropagation(); onDragStart?.(e, notebook.id); }) as any}
        onDragOver={((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); onDragOver?.(e, notebook.id); }) as any}
        onDragEnd={() => onDragEnd?.()}
        onDrop={(e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); onDrop?.(e, notebook.id); }}
      >
        {draggable && (
          <GripVertical size={12} className="text-tx-tertiary opacity-0 group-hover:opacity-60 transition-opacity shrink-0 cursor-grab active:cursor-grabbing" />
        )}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(notebook.id); }}
            className="p-0.5 rounded hover:bg-app-border transition-colors"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        <button
          ref={iconRef}
          onClick={(e) => { e.stopPropagation(); setShowIconPicker(true); }}
          className="text-base hover:scale-125 transition-transform shrink-0"
          title={t("sidebar.changeIcon")}
        >
          {notebook.icon}
        </button>
        <AnimatePresence>
          {showIconPicker && (
            <EmojiIconPicker
              currentIcon={notebook.icon}
              onSelect={(emoji) => onIconChange(notebook.id, emoji)}
              onClose={() => setShowIconPicker(false)}
              position={getIconPickerPos()}
            />
          )}
        </AnimatePresence>
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit();
              if (e.key === "Escape") onEditCancel();
            }}
            onBlur={onEditSubmit}
            className="flex-1 text-sm bg-transparent border border-accent-primary/50 rounded px-1 py-0 outline-none text-tx-primary"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="flex-1 truncate">{notebook.name}</span>
            {notebook.noteCount !== undefined && notebook.noteCount > 0 && (
              <span className="text-[10px] text-tx-tertiary tabular-nums shrink-0">{notebook.noteCount}</span>
            )}
          </>
        )}
      </motion.div>
      <AnimatePresence>
        {hasChildren && isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {notebook.children!.map((child) => (
              <NotebookItem
                key={child.id}
                notebook={child}
                depth={depth + 1}
                onSelect={onSelect}
                selectedId={selectedId}
                onToggle={onToggle}
                onContextMenu={onContextMenu}
                editingId={editingId}
                editValue={editValue}
                onEditChange={onEditChange}
                onEditSubmit={onEditSubmit}
                onEditCancel={onEditCancel}
                onIconChange={onIconChange}
                draggable={draggable}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
                onDrop={onDrop}
                dragOverId={dragOverId}
                dragOverZone={dragOverZone}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// 笔记本右键菜单项 - 在组件内使用 t() 动态生成

export default function Sidebar() {
  const { state } = useApp();
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  // 标签区域折叠状态 - 从 localStorage 恢复
  const [tagsExpanded, setTagsExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem("nowen-tags-expanded");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  // 笔记本区域折叠状态 - 从 localStorage 恢复
  const [notebooksExpanded, setNotebooksExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem("nowen-notebooks-expanded");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  // 切换标签折叠状态时持久化到 localStorage
  const toggleTagsExpanded = useCallback(() => {
    setTagsExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem("nowen-tags-expanded", String(next)); } catch {}
      return next;
    });
  }, []);

  // 切换笔记本折叠状态时持久化到 localStorage
  const toggleNotebooksExpanded = useCallback(() => {
    setNotebooksExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem("nowen-notebooks-expanded", String(next)); } catch {}
      return next;
    });
  }, []);

  const notebookMenuItems: ContextMenuItem[] = [
    { id: "new_note", label: t('sidebar.newNote'), icon: <FilePlus size={14} /> },
    { id: "new_sub", label: t('sidebar.newSubNotebook'), icon: <FolderPlus size={14} /> },
    { id: "sep1", label: "", separator: true },
    { id: "change_icon", label: t('sidebar.changeIcon'), icon: <Smile size={14} /> },
    { id: "rename", label: t('common.rename'), icon: <Edit2 size={14} /> },
    { id: "move", label: t('sidebar.moveNotebook'), icon: <FolderInput size={14} /> },
    { id: "sep2", label: "", separator: true },
    { id: "delete", label: t('sidebar.deleteNotebook'), icon: <Trash2 size={14} />, danger: true },
  ];

  // 右键菜单
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();

  // 重命名状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // 更换图标状态
  const [iconPickerId, setIconPickerId] = useState<string | null>(null);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);

  // 清空回收站确认
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [trashCount, setTrashCount] = useState(0);

  // 移动笔记本模态框
  const [moveNbTarget, setMoveNbTarget] = useState<Notebook | null>(null);

  // 笔记本拖拽排序状态
  const [dragNbId, setDragNbId] = useState<string | null>(null);
  const [dragOverNbId, setDragOverNbId] = useState<string | null>(null);
  const [dragOverNbZone, setDragOverNbZone] = useState<"before" | "inside" | null>(null);

  const tree = useMemo(() => buildTree(state.notebooks), [state.notebooks]);

  useEffect(() => {
    const loadScopedData = () => {
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      api.getTags().then(actions.setTags).catch(console.error);
    };
    loadScopedData();

    // Phase 1: 工作区切换时重载数据
    const onWorkspaceChange = () => {
      // 清空选中状态避免跨空间残留
      actions.setSelectedNotebook(null);
      actions.setViewMode("all");
      loadScopedData();
      // 触发 NoteList 重新拉取
      actions.refreshNotes();
    };
    window.addEventListener("nowen:workspace-changed", onWorkspaceChange);
    return () => window.removeEventListener("nowen:workspace-changed", onWorkspaceChange);
  }, []);

  // 更换笔记本图标
  const handleIconChange = useCallback(async (id: string, emoji: string) => {
    await api.updateNotebook(id, { icon: emoji }).catch(console.error);
    actions.setNotebooks(
      state.notebooks.map((nb) => nb.id === id ? { ...nb, icon: emoji } : nb)
    );
  }, [state.notebooks, actions]);

  // 判断 candidateId 是否为 sourceId 的后代（用于循环引用防护）
  const isDescendant = useCallback((sourceId: string, candidateId: string): boolean => {
    if (sourceId === candidateId) return true;
    // 从 candidate 向上溯源，若链路包含 sourceId 则 candidate 是 source 的后代
    let cursor: string | null = candidateId;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor)) return false;
      visited.add(cursor);
      if (cursor === sourceId) return true;
      const parent = state.notebooks.find((n) => n.id === cursor)?.parentId ?? null;
      cursor = parent;
    }
    return false;
  }, [state.notebooks]);

  // 笔记本拖拽：按鼠标垂直位置区分"before"（同级排到之前）与"inside"（设为子项）
  const handleNbDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragNbId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }, []);

  const handleNbDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id === dragNbId) {
      setDragOverNbId(null);
      setDragOverNbZone(null);
      return;
    }
    // 不允许放入自身的后代
    if (dragNbId && isDescendant(dragNbId, id)) {
      e.dataTransfer.dropEffect = "none";
      setDragOverNbId(null);
      setDragOverNbZone(null);
      return;
    }
    // 根据鼠标在目标元素内的纵向位置划分区域：
    //   上 30% → before（同级排到目标之前）
    //   下 70% → inside（成为该笔记本的子项）
    // 扩大 inside 命中区，避免用户在行中央偏上时误触发 before 导致"拖了等于没拖"
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = e.clientY - rect.top;
    const zone: "before" | "inside" = offset < rect.height * 0.3 ? "before" : "inside";
    setDragOverNbId(id);
    setDragOverNbZone(zone);
  }, [dragNbId, isDescendant]);

  const handleNbDragEnd = useCallback(() => {
    setDragNbId(null);
    setDragOverNbId(null);
    setDragOverNbZone(null);
  }, []);

  const handleNbDrop = useCallback(async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = dragNbId;
    const zone = dragOverNbZone;
    setDragNbId(null);
    setDragOverNbId(null);
    setDragOverNbZone(null);
    if (!sourceId || sourceId === targetId || !zone) return;
    if (isDescendant(sourceId, targetId)) return;

    const sourceNb = state.notebooks.find((n) => n.id === sourceId);
    const targetNb = state.notebooks.find((n) => n.id === targetId);
    if (!sourceNb || !targetNb) return;

    if (zone === "inside") {
      // 放进 target 作为子项：父级改为 targetId
      if (sourceNb.parentId === targetId) return;
      // 乐观更新
      actions.setNotebooks(
        state.notebooks.map((n) =>
          n.id === sourceId ? { ...n, parentId: targetId } : n.id === targetId ? { ...n, isExpanded: 1 } : n
        )
      );
      try {
        await api.moveNotebook(sourceId, { parentId: targetId });
        // 展开父级
        if (targetNb.isExpanded !== 1) {
          api.updateNotebook(targetId, { isExpanded: 1 } as any).catch(console.error);
        }
      } catch (err) {
        console.error("Failed to move notebook:", err);
        actions.refreshNotebooks();
      }
    } else {
      // before：将 source 移到 target 的同级（父级 = target.parentId），并排到 target 之前
      const newParentId = targetNb.parentId ?? null;
      const changedParent = sourceNb.parentId !== newParentId;

      // 重新计算同级列表（target 所在的父级下的所有笔记本，按 sortOrder）
      const siblings = state.notebooks
        .filter((n) => (n.parentId ?? null) === newParentId && n.id !== sourceId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const targetIdx = siblings.findIndex((n) => n.id === targetId);
      if (targetIdx === -1) return;

      const newOrder = [...siblings];
      newOrder.splice(targetIdx, 0, { ...sourceNb, parentId: newParentId });

      // 乐观更新状态
      const updatedMap = new Map(newOrder.map((n, i) => [n.id, i]));
      actions.setNotebooks(
        state.notebooks.map((n) => {
          if (n.id === sourceId) {
            return { ...n, parentId: newParentId, sortOrder: updatedMap.get(n.id) ?? n.sortOrder };
          }
          if (updatedMap.has(n.id)) {
            return { ...n, sortOrder: updatedMap.get(n.id)! };
          }
          return n;
        })
      );

      try {
        // 如果父级变化，先调用 move 接口（允许 parentId 为 null）
        if (changedParent) {
          await api.moveNotebook(sourceId, { parentId: newParentId });
        }
        // 然后批量更新同级 sortOrder
        await api.reorderNotebooks(newOrder.map((n, i) => ({ id: n.id, sortOrder: i })));
      } catch (err) {
        console.error("Failed to move/reorder notebook:", err);
        actions.refreshNotebooks();
      }
    }
  }, [dragNbId, dragOverNbZone, isDescendant, state.notebooks, actions]);

  const handleNotebookSelect = (id: string) => {
    actions.setSelectedNotebook(id);
    actions.setViewMode("notebook");
    actions.setMobileSidebar(false);
  };

  const handleToggle = (id: string) => {
    const nb = state.notebooks.find((n) => n.id === id);
    if (nb) {
      api.updateNotebook(id, { isExpanded: nb.isExpanded === 1 ? 0 : 1 } as any).catch(console.error);
      actions.setNotebooks(
        state.notebooks.map((n) => n.id === id ? { ...n, isExpanded: n.isExpanded === 1 ? 0 : 1 } : n)
      );
    }
  };

  const handleCreateNotebook = async () => {
    const nb = await api.createNotebook({ name: t('common.newNotebook'), icon: "📒" });
    actions.setNotebooks([...state.notebooks, nb]);
    // 自动进入重命名
    setEditingId(nb.id);
    setEditValue(nb.name);
  };

  // 右键菜单操作分发
  const handleMenuAction = async (actionId: string) => {
    const targetId = menu.targetId;
    closeMenu();
    if (!targetId) return;

    const targetNb = state.notebooks.find((nb) => nb.id === targetId);

    switch (actionId) {
      case "new_note": {
        const note = await api.createNote({ notebookId: targetId, title: t('common.untitledNote') });
        actions.setActiveNote(note);
        actions.setSelectedNotebook(targetId);
        actions.setViewMode("notebook");
        actions.addNoteToList({
          id: note.id,
          userId: note.userId,
          title: note.title,
          contentText: note.contentText || "",
          notebookId: note.notebookId,
          isPinned: note.isPinned || 0,
          isFavorite: note.isFavorite || 0,
          isLocked: note.isLocked || 0,
          isArchived: note.isArchived || 0,
          isTrashed: note.isTrashed || 0,
          version: note.version || 1,
          sortOrder: note.sortOrder || 0,
          updatedAt: note.updatedAt,
          createdAt: note.createdAt,
        } as any);
        actions.refreshNotebooks();
        break;
      }
      case "new_sub": {
        const sub = await api.createNotebook({ name: t('common.newNotebook'), icon: "📁", parentId: targetId } as any);
        actions.setNotebooks([...state.notebooks, sub]);
        // 展开父级
        if (targetNb && targetNb.isExpanded !== 1) {
          api.updateNotebook(targetId, { isExpanded: 1 } as any).catch(console.error);
          actions.setNotebooks(
            [...state.notebooks, sub].map((n) => n.id === targetId ? { ...n, isExpanded: 1 } : n)
          );
        }
        setEditingId(sub.id);
        setEditValue(sub.name);
        break;
      }
      case "rename": {
        if (targetNb) {
          setEditingId(targetId);
          setEditValue(targetNb.name);
        }
        break;
      }
      case "change_icon": {
        setIconPickerId(targetId);
        break;
      }
      case "move": {
        if (targetNb) {
          setMoveNbTarget(targetNb);
        }
        break;
      }
      case "delete": {
        if (targetNb) {
          setDeleteTarget(targetNb);
        }
        break;
      }
    }
  };

  // 重命名提交
  const handleEditSubmit = async () => {
    if (!editingId || !editValue.trim()) {
      setEditingId(null);
      return;
    }
    const original = state.notebooks.find((nb) => nb.id === editingId);
    if (original && editValue.trim() !== original.name) {
      await api.updateNotebook(editingId, { name: editValue.trim() }).catch(console.error);
      actions.setNotebooks(
        state.notebooks.map((nb) => nb.id === editingId ? { ...nb, name: editValue.trim() } : nb)
      );
    }
    setEditingId(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
  };

  // 执行笔记本移动（右键菜单 → 移动至... 的结果）
  const handleMoveNotebookConfirm = async (newParentId: string | null) => {
    if (!moveNbTarget) return;
    const sourceId = moveNbTarget.id;
    // 循环引用防护
    if (newParentId && isDescendant(sourceId, newParentId)) {
      alert(t('sidebar.moveCannotSelf'));
      return;
    }
    // 无变化直接关闭
    const currentParent = moveNbTarget.parentId ?? null;
    if (currentParent === newParentId) {
      setMoveNbTarget(null);
      return;
    }
    // 乐观更新
    actions.setNotebooks(
      state.notebooks.map((n) =>
        n.id === sourceId
          ? { ...n, parentId: newParentId }
          : n.id === newParentId
          ? { ...n, isExpanded: 1 }
          : n
      )
    );
    try {
      await api.moveNotebook(sourceId, { parentId: newParentId });
      if (newParentId) {
        // 展开新父级
        const parentNb = state.notebooks.find((n) => n.id === newParentId);
        if (parentNb && parentNb.isExpanded !== 1) {
          api.updateNotebook(newParentId, { isExpanded: 1 } as any).catch(console.error);
        }
      }
    } catch (err) {
      console.error("Failed to move notebook:", err);
      alert(t('sidebar.moveFailed'));
      actions.refreshNotebooks();
    }
    setMoveNbTarget(null);
  };

  // 删除笔记本
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await api.deleteNotebook(deleteTarget.id).catch(console.error);
    // 递归收集被删除笔记本及其所有子孙笔记本的 ID
    const idsToRemove = new Set<string>();
    const collectChildren = (parentId: string) => {
      idsToRemove.add(parentId);
      for (const nb of state.notebooks) {
        if (nb.parentId === parentId && !idsToRemove.has(nb.id)) {
          collectChildren(nb.id);
        }
      }
    };
    collectChildren(deleteTarget.id);
    actions.setNotebooks(state.notebooks.filter((nb) => !idsToRemove.has(nb.id)));
    if (idsToRemove.has(state.selectedNotebookId || "")) {
      actions.setSelectedNotebook(null);
      actions.setViewMode("all");
    }
    setDeleteTarget(null);
  };

  // 打开清空回收站确认（先去查当前可清空的数量）
  const openEmptyTrashConfirm = async () => {
    try {
      const notes = await api.getNotes({ isTrashed: "1" });
      const removable = (notes as any[]).filter((n) => !n.isLocked).length;
      if (removable === 0) {
        toast.info(t('sidebar.emptyTrashEmpty'));
        return;
      }
      setTrashCount(removable);
      setEmptyTrashOpen(true);
    } catch (err: any) {
      console.error("获取回收站笔记失败:", err);
      toast.error(err?.message || t('sidebar.emptyTrashFailed'));
    }
  };

  const handleEmptyTrashConfirm = async () => {
    if (emptyingTrash) return;
    setEmptyingTrash(true);
    try {
      const res = await api.emptyTrash();
      if (res.skipped && res.skipped > 0) {
        toast.warning(t('sidebar.emptyTrashSkipped', { count: res.count, skipped: res.skipped }));
      } else {
        toast.success(t('sidebar.emptyTrashSuccess', { count: res.count }));
      }
      // 若当前正处于回收站视图，刷新列表
      if (state.viewMode === "trash") {
        actions.setNotes([]);
      }
      // 清空 activeNote 以防止指向已删除笔记
      if (state.activeNote?.isTrashed) {
        actions.setActiveNote(null);
      }
      actions.refreshNotebooks();
      setEmptyTrashOpen(false);
    } catch (err: any) {
      console.error("清空回收站失败:", err);
      toast.error(err?.message || t('sidebar.emptyTrashFailed'));
    } finally {
      setEmptyingTrash(false);
    }
  };

  const navItems: { icon: React.ReactNode; label: string; mode: ViewMode; active: boolean }[] = [
    { icon: <BookOpen size={16} />, label: t('sidebar.allNotes'), mode: "all", active: state.viewMode === "all" },
    { icon: <CalendarDays size={16} />, label: t('sidebar.diary'), mode: "diary", active: state.viewMode === "diary" },
    { icon: <ListTodo size={16} />, label: t('sidebar.tasks'), mode: "tasks", active: state.viewMode === "tasks" },
    { icon: <BrainCircuit size={16} />, label: t('sidebar.mindMaps'), mode: "mindmaps", active: state.viewMode === "mindmaps" },
    { icon: <Bot size={16} />, label: t('sidebar.aiChat'), mode: "ai-chat", active: state.viewMode === "ai-chat" },

    { icon: <Star size={16} />, label: t('sidebar.favorites'), mode: "favorites", active: state.viewMode === "favorites" },
    { icon: <Trash2 size={16} />, label: t('sidebar.trash'), mode: "trash", active: state.viewMode === "trash" },
  ];

  if (state.sidebarCollapsed) {
    return (
      <div className="hidden md:flex w-12 h-full bg-app-sidebar border-r border-app-border flex-col items-center py-3 gap-2 shrink-0 transition-colors">
        <Button variant="ghost" size="icon" onClick={actions.toggleSidebar}>
          <PanelLeft size={16} />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="w-full h-full bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-colors"
      style={{ width: undefined }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border" style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}>
        <h1 className="text-sm font-semibold text-tx-primary tracking-wide">{siteConfig.title}</h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="hidden md:inline-flex" onClick={actions.toggleSidebar}>
            <PanelLeftClose size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => actions.setMobileSidebar(false)}>
            <X size={16} />
          </Button>
        </div>
      </div>

      {/* Workspace Switcher (Phase 1 多用户协作) */}
      <div className="px-3 pt-2">
        <WorkspaceSwitcher />
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" size={14} />
          <Input
            placeholder={t('sidebar.searchPlaceholder')}
            className="pl-8 h-8 text-xs bg-app-bg border-app-border"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              if (e.target.value.trim()) {
                actions.setViewMode("search");
                actions.setSearchQuery(e.target.value);
              } else {
                actions.setViewMode("all");
                actions.setSearchQuery("");
              }
            }}
          />
        </div>
      </div>

      {/* Navigation */}
      <div className="px-3 py-1 space-y-0.5">
        {navItems.map((item) => {
          const isTrashItem = item.mode === "trash";
          return (
            <div key={item.mode} className="relative group">
              <button
                onClick={() => {
                  actions.setViewMode(item.mode);
                  actions.setSelectedNotebook(null);
                  actions.setMobileSidebar(false);
                }}
                onContextMenu={
                  isTrashItem
                    ? (e) => {
                        e.preventDefault();
                        openEmptyTrashConfirm();
                      }
                    : undefined
                }
                className={cn(
                  "flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-sm transition-colors",
                  item.active
                    ? "bg-app-active text-tx-primary"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                  isTrashItem && "pr-8"
                )}
              >
                {item.icon}
                {item.label}
              </button>
              {isTrashItem && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openEmptyTrashConfirm();
                  }}
                  title={t('sidebar.emptyTrash')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-tx-tertiary hover:text-red-500 transition-all"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Separator */}
      <div className="mx-3 my-2 border-t border-app-border" />

      {/* Notebooks */}
      <div className="px-3 flex items-center justify-between mb-1">
        <button
          onClick={() => toggleNotebooksExpanded()}
          className="flex items-center gap-1 hover:text-tx-secondary transition-colors"
        >
          <ChevronDown
            size={12}
            className={cn(
              "text-tx-tertiary transition-transform duration-200",
              !notebooksExpanded && "-rotate-90"
            )}
          />
          <span className="text-xs font-medium text-tx-tertiary uppercase tracking-wider">{t('sidebar.notebooks')}</span>
        </button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCreateNotebook}>
          <Plus size={14} />
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {notebooksExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: "hidden" }}
            animate={{ height: "auto", opacity: 1, overflow: "visible", transitionEnd: { overflow: "visible" } }}
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            transition={{ duration: 0.2 }}
            className="flex-1 min-h-0 flex flex-col"
          >
      <ScrollArea className="flex-1 min-h-0 px-1">
        <div className="space-y-0.5 pb-2">
          {tree.map((nb) => (
            <NotebookItem
              key={nb.id}
              notebook={nb}
              depth={0}
              onSelect={handleNotebookSelect}
              selectedId={state.selectedNotebookId}
              onToggle={handleToggle}
              onContextMenu={(e, id) => openMenu(e, id, "notebook")}
              editingId={editingId}
              editValue={editValue}
              onEditChange={setEditValue}
              onEditSubmit={handleEditSubmit}
              onEditCancel={handleEditCancel}
              onIconChange={handleIconChange}
              draggable={true}
              onDragStart={handleNbDragStart}
              onDragOver={handleNbDragOver}
              onDragEnd={handleNbDragEnd}
              onDrop={handleNbDrop}
              dragOverId={dragOverNbId}
              dragOverZone={dragOverNbZone}
            />
          ))}
        </div>
      </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tags —— 使用 shrink-0 + 内部 max-height + scroll，避免在小屏（如 1366x768）挤压上方 Notebooks 或与 Footer 交叠 */}
      <div className="border-t border-app-border shrink-0">
        <button
          onClick={() => toggleTagsExpanded()}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-app-hover transition-colors"
        >
          <span className="text-xs font-medium text-tx-tertiary uppercase tracking-wider">{t('sidebar.tags')}</span>
          <ChevronDown
            size={14}
            className={cn(
              "text-tx-tertiary transition-transform duration-200",
              !tagsExpanded && "-rotate-90"
            )}
          />
        </button>
        <AnimatePresence initial={false}>
          {tagsExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0, overflow: "hidden" }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0, overflow: "hidden" }}
              transition={{ duration: 0.2 }}
              style={{ overflow: "hidden" }}
            >
              {/* 限制标签区最大高度，超出可滚动 —— 避免与 Notebooks / Footer 重叠 */}
              <div
                className="px-2 pb-2 space-y-0.5 overflow-y-auto"
                style={{ maxHeight: "min(35vh, 260px)" }}
              >
                {state.tags.length === 0 ? (
                  <p className="text-[10px] text-tx-tertiary px-2 py-1">{t('sidebar.noTags')}</p>
                ) : (
                  state.tags.map((tag) => {
                    const isActive = state.viewMode === "tag" && state.selectedTagId === tag.id;
                    return (
                      <div
                        key={tag.id}
                        className={cn(
                          "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs transition-colors group/tag cursor-pointer",
                          isActive
                            ? "bg-app-active text-tx-primary"
                            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                        )}
                        onClick={() => {
                          actions.setSelectedTag(tag.id);
                          actions.setSelectedNotebook(null);
                          actions.setViewMode("tag");
                          actions.setMobileSidebar(false);
                        }}
                      >
                        <TagColorPicker
                          currentColor={tag.color}
                          size="sm"
                          onColorChange={async (color) => {
                            try {
                              await api.updateTag(tag.id, { color });
                              const allTags = await api.getTags();
                              actions.setTags(allTags);
                            } catch (err) {
                              console.error("Failed to update tag color:", err);
                            }
                          }}
                        />
                        <span className="flex-1 truncate text-left">{tag.name}</span>
                        {tag.noteCount !== undefined && tag.noteCount > 0 && (
                          <span className="text-[10px] text-tx-tertiary tabular-nums group-hover/tag:hidden">{tag.noteCount}</span>
                        )}
                        <button
                          className="hidden group-hover/tag:flex items-center justify-center w-4 h-4 rounded hover:bg-red-500/20 hover:text-red-500 text-tx-tertiary shrink-0"
                          title={t('common.delete')}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(t('sidebar.confirmDeleteTag', { name: tag.name }) || `确定删除标签「${tag.name}」吗？删除后将从所有笔记中移除该标签。`)) {
                              api.deleteTag(tag.id).then(() => {
                                api.getTags().then(actions.setTags).catch(console.error);
                                if (state.selectedTagId === tag.id) {
                                  actions.setSelectedTag(null);
                                  actions.setViewMode("all");
                                }
                              }).catch(console.error);
                            }
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer: Settings + Logout */}
      <div className="border-t border-app-border px-3 py-2.5 flex items-center gap-2 shrink-0">
        <button
          onClick={() => setShowSettings(true)}
          className="flex-1 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors group"
        >
          <div className="w-7 h-7 rounded-lg bg-app-hover group-hover:bg-accent-primary/10 flex items-center justify-center transition-colors">
            <Settings size={14} className="group-hover:text-accent-primary transition-colors" />
          </div>
          <span className="text-xs font-medium">{t('sidebar.settings')}</span>
        </button>
        <button
          onClick={() => {
            // L10: 广播给其他 tab 一起下线
            broadcastLogout("user_logout");
            window.location.reload();
          }}
          title={t('sidebar.logout')}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-tx-tertiary hover:text-accent-danger hover:bg-accent-danger/10 transition-colors"
        >
          <LogOut size={15} />
        </button>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </AnimatePresence>

      {/* Notebook Context Menu */}
      <ContextMenu
        isOpen={menu.isOpen && menu.targetType === "notebook"}
        x={menu.x}
        y={menu.y}
        menuRef={menuRef}
        items={notebookMenuItems}
        onAction={handleMenuAction}
        header={state.notebooks.find((nb) => nb.id === menu.targetId)?.name}
      />

      {/* 右键菜单触发的图标选择器 */}
      <AnimatePresence>
        {iconPickerId && (
          <EmojiIconPicker
            currentIcon={state.notebooks.find((nb) => nb.id === iconPickerId)?.icon || "📒"}
            onSelect={(emoji) => handleIconChange(iconPickerId, emoji)}
            onClose={() => setIconPickerId(null)}
            position={{ top: menu.y, left: menu.x }}
          />
        )}
      </AnimatePresence>

      {/* Move Notebook Modal */}
      <MoveNotebookModal
        isOpen={!!moveNbTarget}
        notebook={moveNbTarget}
        allNotebooks={state.notebooks}
        onMove={handleMoveNotebookConfirm}
        onClose={() => setMoveNbTarget(null)}
      />

      {/* Delete Confirmation */}
      <AnimatePresence>
        {deleteTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setDeleteTarget(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0 }}
              className="relative bg-app-elevated w-full max-w-sm p-5 rounded-xl shadow-2xl border border-app-border"
              onClick={(e) => e.stopPropagation()}
            >
              {/* 危险图标 */}
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-accent-danger/10 flex items-center justify-center shrink-0">
                  <Trash2 size={18} className="text-accent-danger" />
                </div>
                <h4 className="text-base font-bold text-tx-primary">
                  {t('sidebar.deleteNotebookTitle')}
                </h4>
              </div>
              <p className="text-sm text-tx-secondary mb-5 pl-[52px]">
                {t('sidebar.deleteNotebookConfirm', { name: `${deleteTarget.icon} ${deleteTarget.name}` })}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  className="px-4 py-2 text-sm font-medium text-white bg-accent-danger hover:bg-accent-danger/90 rounded-lg transition-colors"
                >
                  {t('sidebar.confirmDelete')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 清空回收站确认 */}
      <AnimatePresence>
        {emptyTrashOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => !emptyingTrash && setEmptyTrashOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0 }}
              className="relative bg-app-elevated w-full max-w-sm p-5 rounded-xl shadow-2xl border border-app-border"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-accent-danger/10 flex items-center justify-center shrink-0">
                  <Trash2 size={18} className="text-accent-danger" />
                </div>
                <h4 className="text-base font-bold text-tx-primary">
                  {t('sidebar.emptyTrashConfirmTitle')}
                </h4>
              </div>
              <p className="text-sm text-tx-secondary mb-5 pl-[52px]">
                {t('sidebar.emptyTrashConfirm', { count: trashCount })}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setEmptyTrashOpen(false)}
                  disabled={emptyingTrash}
                  className="px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover rounded-lg transition-colors disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleEmptyTrashConfirm}
                  disabled={emptyingTrash}
                  className="px-4 py-2 text-sm font-medium text-white bg-accent-danger hover:bg-accent-danger/90 rounded-lg transition-colors disabled:opacity-50"
                >
                  {emptyingTrash ? t('common.loading') : t('sidebar.emptyTrash')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
