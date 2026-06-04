import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BookOpen, Plus, Star, Trash2, Search, ChevronRight, FileText,
  ChevronDown, ListTodo,
  Settings, LogOut, FilePlus, FolderPlus, Edit2, X, BrainCircuit,
  Sparkles, NotebookPen, Smile, GripVertical,
  FolderInput, Check, Home, Download, FolderOpen,
  Columns2, Columns3, FileType2, Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import SettingsModal from "@/components/SettingsModal";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import TagColorPopover from "@/components/TagColorPopover";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useApp, useAppActions } from "@/store/AppContext";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { useRailMode, nextRailMode } from "@/hooks/useRailMode";
import { api, broadcastLogout, getCurrentWorkspace } from "@/lib/api";
import { exportNotebook } from "@/lib/exportService";
import { Notebook, NoteListItem, ViewMode, WorkspaceFeatures } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { prompt as appPrompt } from "@/components/ui/confirm";

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
        className="relative w-full max-w-[360px] mx-4 max-h-[80vh] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
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
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
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
        </div>
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
  notebook, depth, onSelect, selectedId, onToggle, onContextMenu, onLongPress,
  editingId, editValue, onEditChange, onEditSubmit, onEditCancel,
  onIconChange,
  draggable, onDragStart, onDragOver, onDragEnd, onDrop, dragOverId, dragOverZone,
  notebookNotes, activeNoteId, onCreateNote, onDeleteNote, onRenameNote, onToggleFavorite, onTogglePin,
}: {
  notebook: Notebook; depth: number; onSelect: (id: string) => void;
  selectedId: string | null; onToggle: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  /**
   * 移动端长按触发，与 onContextMenu 等价但携带的是 touch 坐标。
   * Android WebView 上不会派发 contextmenu 事件，因此必须有这条手动通路，
   * 否则在手机上"建立的笔记本不能在手机端删除"。
   */
  onLongPress?: (clientX: number, clientY: number, id: string) => void;
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
  notebookNotes?: Map<string, NoteListItem[]>;
  activeNoteId?: string | null;
  onCreateNote?: (notebookId: string) => void;
  onDeleteNote?: (noteId: string, notebookId: string) => void;
  onRenameNote?: (noteId: string, notebookId: string, newTitle: string) => void;
  onToggleFavorite?: (noteId: string, notebookId: string) => void;
  onTogglePin?: (noteId: string, notebookId: string) => void;
}) {
  const { t } = useTranslation();
  const notes = notebookNotes?.get(notebook.id);
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

  // 移动端长按 → 触发上下文菜单（删除/重命名/导出 等）。
  // - 600ms 阈值与笔记列表 (NoteList) / 思维导图项保持一致，避免用户跨场景手感不同。
  // - touchmove / touchend / touchcancel 任一触发都要清掉计时器，否则用户只是
  //   在列表上滑动也会误触菜单。
  // - 计时器记录起始坐标：iOS/Android 在长按期间触摸点会有几像素抖动，
  //   超过 ~10px 视为"用户在滚动"，主动取消。
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  };

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
          "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm group transition-colors min-w-0",
          isSelected ? "bg-app-active text-tx-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
          // inside 放置指示：显著的内边框 + 背景高亮，让用户清楚"将作为子项放入"
          showInsideIndicator && "outline outline-2 outline-accent-primary bg-accent-primary/15"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(notebook.id)}
        onContextMenu={(e) => onContextMenu(e, notebook.id)}
        onTouchStart={(e) => {
          if (isEditing || !onLongPress) return;
          const touch = e.touches[0];
          if (!touch) return;
          longPressStart.current = { x: touch.clientX, y: touch.clientY };
          longPressTimer.current = setTimeout(() => {
            const start = longPressStart.current;
            if (!start) return;
            // 长按命中：把 touch 坐标交给上层 openMenuAt
            onLongPress(start.x, start.y, notebook.id);
            longPressTimer.current = null;
          }, 600);
        }}
        onTouchMove={(e) => {
          const start = longPressStart.current;
          if (!start) return;
          const touch = e.touches[0];
          if (!touch) return;
          // 抖动容差：> 10px 视为用户在滚动 / 拖动，撤销长按
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (dx * dx + dy * dy > 100) cancelLongPress();
        }}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
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
            <span className="flex-1 min-w-0 truncate">{notebook.name}</span>
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
                onLongPress={onLongPress}
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
                notebookNotes={notebookNotes}
                activeNoteId={activeNoteId}
                onCreateNote={onCreateNote}
                onDeleteNote={onDeleteNote}
                onRenameNote={onRenameNote}
                onToggleFavorite={onToggleFavorite}
                onTogglePin={onTogglePin}
              />
            ))}
            {/* Inline notes for this notebook */}
            {notes && notes.length > 0 && (
              <div className="space-y-0.5">
                {notes.map((note) => (
                  <NoteNoteItem
                    key={note.id}
                    note={note}
                    depth={depth + 1}
                    isActive={activeNoteId === note.id}
                    onSelect={(noteId) => {
                      import("@/lib/api").then(({ api }) => {
                        api.getNote(noteId).then((fullNote) => {
                          window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId, note: fullNote } }));
                        });
                      });
                    }}
                    onDelete={(noteId) => onDeleteNote?.(noteId, notebook.id)}
                    onRename={(noteId, newTitle) => onRenameNote?.(noteId, notebook.id, newTitle)}
                    onToggleFavorite={(noteId) => onToggleFavorite?.(noteId, notebook.id)}
                    onTogglePin={(noteId) => onTogglePin?.(noteId, notebook.id)}
                  />
                ))}
              </div>
            )}
            {/* Create note button */}
            {onCreateNote && (
              <button
                className="w-full flex items-center gap-1.5 py-1 text-[11px] text-tx-tertiary hover:text-accent-primary transition-colors"
                style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}
                onClick={(e) => { e.stopPropagation(); onCreateNote(notebook.id); }}
              >
                <Plus size={12} />
                <span>{"\u65b0\u5efa\u7b14\u8bb0"}</span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Inline note item - rendered inside expanded notebook tree */
function NoteNoteItem({
  note, depth, isActive, onSelect, onDelete, onRename, onToggleFavorite, onTogglePin,
}: {
  note: NoteListItem; depth: number; isActive: boolean;
  onSelect: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onRename: (noteId: string, newTitle: string) => void;
  onToggleFavorite: (noteId: string) => void;
  onTogglePin: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(note.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [isEditing]);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const timeAgo = useMemo(() => {
    const d = new Date(note.updatedAt);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return "\u521a\u521a";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}\u5206\u949f\u524d`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}\u5c0f\u65f6\u524d`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}\u5929\u524d`;
    return d.toLocaleDateString();
  }, [note.updatedAt]);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1.5 py-1 pr-1 rounded-md cursor-pointer text-xs group transition-colors min-w-0",
          isActive ? "bg-app-active text-tx-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        )}
        style={{ paddingLeft: `${depth * 16 + 28}px` }}
        onClick={() => onSelect(note.id)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuPos({ x: e.clientX, y: e.clientY }); setShowMenu(true); }}
      >
        <FileText size={13} className={cn("shrink-0", isActive ? "text-accent-primary" : "text-tx-tertiary")} />
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename(note.id, editValue); setIsEditing(false); }
              if (e.key === "Escape") { setIsEditing(false); setEditValue(note.title); }
            }}
            onBlur={() => { onRename(note.id, editValue); setIsEditing(false); }}
            className="flex-1 text-xs bg-transparent border border-accent-primary/50 rounded px-1 py-0 outline-none min-w-0"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="flex-1 min-w-0 flex flex-col">
            <span className="truncate leading-tight">{note.title}</span>
            <span className="text-[10px] text-tx-tertiary truncate leading-tight">{timeAgo}</span>
          </div>
        )}
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {note.isPinned === 1 && <span className="text-[10px]">{String.fromCodePoint(0x1F4CC)}</span>}
          {note.isFavorite === 1 && <span className="text-[10px]">{String.fromCodePoint(0x2B50)}</span>}
        </div>
      </div>
      {showMenu && (
        <div
          ref={menuRef}
          className="fixed z-[60] bg-app-elevated border border-app-border rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-app-hover flex items-center gap-2"
            onClick={() => { setShowMenu(false); onTogglePin(note.id); }}>
            {note.isPinned ? "\u53d6\u6d88\u7f6e\u9876" : String.fromCodePoint(0x1F4CC) + " \u7f6e\u9876"}
          </button>
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-app-hover flex items-center gap-2"
            onClick={() => { setShowMenu(false); onToggleFavorite(note.id); }}>
            {note.isFavorite ? "\u53d6\u6d88\u6536\u85cf" : String.fromCodePoint(0x2B50) + " \u6536\u85cf"}
          </button>
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-app-hover flex items-center gap-2"
            onClick={() => { setShowMenu(false); setIsEditing(true); setEditValue(note.title); }}>
            <Edit2 size={12} /> {"\u91cd\u547d\u540d"}
          </button>
          <div className="my-1 border-t border-app-border/50" />
          <button className="w-full px-3 py-1.5 text-xs text-left hover:bg-app-hover flex items-center gap-2 text-accent-danger"
            onClick={() => { setShowMenu(false); onDelete(note.id); }}>
            <Trash2 size={12} /> {"\u5220\u9664"}
          </button>
        </div>
      )}
    </>
  );
}

// 笔记本右键菜单项 - 在组件内使用 t() 动态生成

/**
 * Sidebar
 *
 * variant:
 *   - "mobile"（默认）：抽屉式主区——WorkspaceSwitcher + 搜索 + 笔记本 + 标签。
 *                      v16 P3 后续：移动端也已对齐桌面双层导航——导航 8 项 / 设置 /
 *                      登出 / 关闭按钮全部迁移到 NavRail variant="mobile"，主区不再渲染。
 *   - "desktop"：精简侧栏——仅 WorkspaceSwitcher + 搜索 + 笔记本 + 标签。
 *                导航、设置、登出、折叠按钮都迁移到 NavRail variant="desktop"。
 *
 * 桌面端：App.tsx 渲染 <NavRail variant="desktop"/> + <Sidebar variant="desktop"/>。
 * 移动端：App.tsx 渲染抽屉，内部为 <NavRail variant="mobile"/> + <Sidebar variant="mobile"/>。
 * 桌面折叠态（sidebarCollapsed=true）下 App.tsx 隐藏整个 Sidebar 但保留 NavRail。
 */
export default function Sidebar({ variant = "mobile" }: { variant?: "desktop" | "mobile" } = {}) {
  const { state } = useApp();
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  const isDesktop = variant === "desktop";
  const { t } = useTranslation();
  // v16 P3 后续：Rail 三档视觉模式（icon / label / hidden），仅桌面变体使用。
  // 入口约定：Sidebar Header 那个按钮 = 循环切换到下一档，tooltip 提示下一档是什么。
  // 约束（在 App.tsx 实施）：sidebarCollapsed=true 时即便 mode=hidden 也强制显示 Rail，
  // 避免用户陷入"完全无侧栏入口"的死局——本组件不需要关心这个边界。
  const [railMode, setRailMode] = useRailMode();
  const [searchInput, setSearchInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  // Y4: 当前工作区的功能开关。null = 个人空间（不受限），对象 = 工作区 normalized 配置。
  //     由 workspace-changed / workspace-features-changed 两个事件驱动刷新。
  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  // 是否系统管理员 + 当前用户的 per-user 导出开关（v6 下沉后从 /api/me 读）。
  //   - 管理员：导出菜单项始终可见（保证数据救援能力）
  //   - 普通用户：受 me.personalExportEnabled 控制；老后端未返回字段时按 true 兜底
  // 与 DataManager/SettingsModal 保持同一取值方式，避免引入全局 CurrentUser hook。
  const [isAdmin, setIsAdmin] = useState(false);
  const [personalExportAllowed, setPersonalExportAllowed] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => {
        if (cancelled) return;
        setIsAdmin((u as any)?.role === "admin");
        const exp = (u as any)?.personalExportEnabled;
        setPersonalExportAllowed(exp === undefined ? true : !!exp);
      })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);
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

  // v15 信息架构改造前：导航区是一个可折叠的扁平 8 项列表（与笔记本/标签的折叠策略一致），
  // 用 navExpanded + nowen-nav-expanded localStorage 控制。改造后导航被拆为
  // 工作台 / 内容模块 / 工具 三组并始终展开，折叠交互被去掉——主入口不应被隐藏。
  // localStorage key 保留写权也不再读取，旧值会被自然遗忘；如果未来需要恢复，
  // 可以重新引入这套 state。

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

  // ===== Inline notes: lazy-load when notebook expands =====

  const [notebookNotes, setNotebookNotes] = useState<Map<string, NoteListItem[]>>(new Map());

  const [noteLoading, setNoteLoading] = useState<Set<string>>(new Set());



  const loadNotesForNotebook = useCallback(async (notebookId: string) => {

    if (notebookNotes.has(notebookId) || noteLoading.has(notebookId)) return;

    setNoteLoading((prev) => new Set(prev).add(notebookId));

    try {

      const notes = await api.getNotes({ notebookId }) as NoteListItem[];

      setNotebookNotes((prev) => new Map(prev).set(notebookId, notes));

    } catch (err) {

      console.error("Failed to load notes:", notebookId, err);

    } finally {

      setNoteLoading((prev) => { const n = new Set(prev); n.delete(notebookId); return n; });

    }

  }, [notebookNotes, noteLoading]);



  const handleCreateNote = useCallback(async (notebookId: string) => {

    try {

      const note = await api.createNote({ notebookId, title: t("common.untitledNote") });

      actions.setActiveNote(note);

      setNotebookNotes((prev) => {

        const next = new Map(prev);

        const existing = next.get(notebookId) || [];

        next.set(notebookId, [...existing, { id: note.id, userId: note.userId, title: note.title, contentText: note.contentText || "", notebookId: note.notebookId, isPinned: note.isPinned || 0, isFavorite: note.isFavorite || 0, isLocked: note.isLocked || 0, isArchived: note.isArchived || 0, isTrashed: note.isTrashed || 0, version: note.version || 1, sortOrder: note.sortOrder || 0, updatedAt: note.updatedAt, createdAt: note.createdAt, workspaceId: note.workspaceId ?? null } as NoteListItem]);

        return next;

      });

      actions.refreshNotebooks();

    } catch (err) { console.error("Failed to create note:", err); }

  }, [actions, t]);



  const handleDeleteNote = useCallback(async (noteId: string, notebookId: string) => {

    try {

      await api.deleteNote(noteId);

      setNotebookNotes((prev) => { const next = new Map(prev); next.set(notebookId, (next.get(notebookId) || []).filter((n) => n.id !== noteId)); return next; });

      actions.refreshNotebooks();

    } catch (err) { console.error("Failed to delete note:", err); }

  }, [actions]);



  const handleRenameNote = useCallback(async (noteId: string, notebookId: string, newTitle: string) => {

    if (!newTitle.trim()) return;

    try {

      await api.updateNote(noteId, { title: newTitle.trim() });

      setNotebookNotes((prev) => { const next = new Map(prev); next.set(notebookId, (next.get(notebookId) || []).map((n) => n.id === noteId ? { ...n, title: newTitle.trim() } : n)); return next; });

      if (state.activeNote?.id === noteId) actions.setActiveNote({ ...state.activeNote!, title: newTitle.trim() });

    } catch (err) { console.error("Failed to rename note:", err); }

  }, [state.activeNote, actions]);



  const handleToggleFavorite = useCallback(async (noteId: string, notebookId: string) => {

    try {

      const notes = notebookNotes.get(notebookId) || [];

      const note = notes.find((n) => n.id === noteId);

      if (!note) return;

      const newVal = note.isFavorite ? 0 : 1;

      await api.updateNote(noteId, { isFavorite: newVal } as any);

      setNotebookNotes((prev) => { const next = new Map(prev); next.set(notebookId, (next.get(notebookId) || []).map((n) => n.id === noteId ? { ...n, isFavorite: newVal } : n)); return next; });

    } catch (err) { console.error("Failed to toggle favorite:", err); }

  }, [notebookNotes]);



  const handleTogglePin = useCallback(async (noteId: string, notebookId: string) => {

    try {

      const notes = notebookNotes.get(notebookId) || [];

      const note = notes.find((n) => n.id === noteId);

      if (!note) return;

      const newVal = note.isPinned ? 0 : 1;

      await api.updateNote(noteId, { isPinned: newVal } as any);

      setNotebookNotes((prev) => { const next = new Map(prev); next.set(notebookId, (next.get(notebookId) || []).map((n) => n.id === noteId ? { ...n, isPinned: newVal } : n)); return next; });

    } catch (err) { console.error("Failed to toggle pin:", err); }

  }, [notebookNotes]);



  useEffect(() => {

    state.notebooks.forEach((nb) => { if (nb.isExpanded === 1) loadNotesForNotebook(nb.id); });

  }, [state.notebooks, loadNotesForNotebook]);



  // Listen for nowen:open-note to open note in editor

  useEffect(() => {

    const handler = (e: Event) => {

      const detail = (e as CustomEvent).detail;

      if (detail?.note) {

        actions.setActiveNote(detail.note);

        actions.setMobileView("editor");

      }

    };

    window.addEventListener("nowen:open-note", handler);

    return () => window.removeEventListener("nowen:open-note", handler);

  }, [actions]);



  // 笔记本右键菜单项。
  //
  // "导出为 Markdown" 的可见性：
  //   - 工作区下：保持原行为（始终可见）。工作区导出权限由后端的工作区成员资格控制。
  //   - 个人空间下：受 per-user 开关 personalExportAllowed（来自当前登录用户的
  //     users.personalExportEnabled，v6 起从 /api/me 下发）控制；管理员
  //     （isAdmin）始终可见，确保管理员保留数据救援能力。
  const notebookMenuItems: ContextMenuItem[] = useMemo(() => {
    const ws = getCurrentWorkspace();
    const isPersonal = !ws || ws === "personal";
    const showExport = !isPersonal || isAdmin || personalExportAllowed;
    const items: ContextMenuItem[] = [
      { id: "new_note", label: t('sidebar.newNote'), icon: <FilePlus size={14} /> },
      { id: "new_word_note", label: t('sidebar.importWordNote') || "导入 Word 文档", icon: <FileType2 size={14} /> },
      { id: "new_url_note", label: t('sidebar.importUrlNote') || "导入公众号文章", icon: <Link2 size={14} /> },
      { id: "new_sub", label: t('sidebar.newSubNotebook'), icon: <FolderPlus size={14} /> },
      { id: "sep1", label: "", separator: true },
      { id: "change_icon", label: t('sidebar.changeIcon'), icon: <Smile size={14} /> },
      { id: "rename", label: t('common.rename'), icon: <Edit2 size={14} /> },
      { id: "move", label: t('sidebar.moveNotebook'), icon: <FolderInput size={14} /> },
    ];
    if (showExport) {
      items.push({ id: "sep_export", label: "", separator: true });
      items.push({ id: "export_md", label: t('sidebar.exportNotebookAsMarkdown'), icon: <Download size={14} /> });
    }
    items.push({ id: "sep2", label: "", separator: true });
    items.push({ id: "delete", label: t('sidebar.deleteNotebook'), icon: <Trash2 size={14} />, danger: true });
    return items;
  }, [t, isAdmin, personalExportAllowed]);

  // 右键菜单（桌面）/ 长按菜单（移动端共用同一份 state）
  const { menu, menuRef, openMenu, openMenuAt, closeMenu } = useContextMenu();

  // 重命名状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // 更换图标状态
  const [iconPickerId, setIconPickerId] = useState<string | null>(null);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  // 标签删除确认（自定义弹窗，替代 window.confirm）
  const [deleteTagTarget, setDeleteTagTarget] = useState<{ id: string; name: string; color: string } | null>(null);

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

  // 标签颜色选择浮层状态（通过右键 / 长按触发）
  const [tagColorPopover, setTagColorPopover] = useState<{
    tagId: string;
    tagName: string;
    color: string;
    x: number;
    y: number;
  } | null>(null);
  // 长按计时器
  const tagLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagLongPressFired = useRef(false);

  const tree = useMemo(() => buildTree(state.notebooks), [state.notebooks]);

  useEffect(() => {
    const loadScopedData = () => {
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      api.getTags().then(actions.setTags).catch(console.error);
    };
    // Y4: 加载当前工作区的功能开关——个人空间固定置 null（全开）
    const loadFeatures = () => {
      const ws = getCurrentWorkspace();
      if (!ws || ws === "personal") {
        setFeatures(null);
        return;
      }
      api.getWorkspaceFeatures(ws)
        .then(setFeatures)
        .catch(() => setFeatures(null));
    };
    loadScopedData();
    loadFeatures();

    // Phase 1: 工作区切换时重载数据
    const onWorkspaceChange = () => {
      // 清空选中状态避免跨空间残留
      actions.setSelectedNotebook(null);
      actions.setViewMode("all");
      loadScopedData();
      loadFeatures();
      // 触发 NoteList 重新拉取
      actions.refreshNotes();
    };
    // Y4: MembersPanel 中 owner 改功能开关后会广播此事件，让 Sidebar 立即更新可见项
    const onFeaturesChanged = () => loadFeatures();
    window.addEventListener("nowen:workspace-changed", onWorkspaceChange);
    window.addEventListener("nowen:workspace-features-changed", onFeaturesChanged);
    return () => {
      window.removeEventListener("nowen:workspace-changed", onWorkspaceChange);
      window.removeEventListener("nowen:workspace-features-changed", onFeaturesChanged);
    };
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
      case "new_word_note": {
        // 导入 Word 文档：选择 .docx → mammoth 解析 → 生成可编辑的富文本笔记。
        // 走 dynamic import 避免把 mammoth (~800KB) 加到首屏 bundle。
        try {
          const { pickDocxFile, importDocxAsNote } = await import("@/lib/wordNoteService");
          const { toast } = await import("@/lib/toast");
          const file = await pickDocxFile();
          if (!file) break; // 用户取消
          toast.info("正在导入 Word 文档…");
          const { note } = await importDocxAsNote({ notebookId: targetId, file });
          actions.setActiveNote(note as any);
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
          toast.success("导入成功");
        } catch (err: any) {
          const { toast } = await import("@/lib/toast");
          toast.error(err?.message || "导入 Word 文档失败");
        }
        break;
      }
      case "new_url_note": {
        // 导入公众号文章：用项目统一的 prompt 弹窗输入 URL（替代原生 window.prompt）
        // - validate 内联做格式校验：错误信息直接展示在弹窗里，避免关闭后再 toast 报错
        // - 后端会抓取 HTML、下载图片到附件库、并把笔记落到 targetId 笔记本
        const raw = await appPrompt({
          title: t('sidebar.importUrlNote') || "导入公众号文章",
          description: t('sidebar.importUrlPrompt') || "请输入微信公众号文章链接（https://mp.weixin.qq.com/s/...）",
          placeholder: "https://mp.weixin.qq.com/s/...",
          confirmText: t('common.confirm') || "导入",
          cancelText: t('common.cancel') || "取消",
          validate: (v) => {
            const s = (v || "").trim();
            if (!s) return t('urlImport.emptyUrl') || "请输入文章链接";
            if (!/^https:\/\/mp\.weixin\.qq\.com\/s[\/?]/.test(s)) {
              return t('urlImport.unsupportedUrl') || "暂只支持微信公众号文章链接";
            }
            return null;
          },
        });
        if (raw == null) break; // 用户取消
        const url = raw.trim();
        const toastId = toast.info(t('urlImport.importing') || "正在导入文章…", 0);
        try {
          const result = await api.urlImport(url, targetId);
          // urlImport 只返回 noteId+title，需要再取完整 note 推到 store
          const note = await api.getNote(result.noteId);
          actions.setActiveNote(note as any);
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
          toast.dismiss(toastId);
          const failedTip = result.images.failed > 0
            ? `（${result.images.failed} 张图片下载失败）`
            : "";
          toast.success(
            (t('urlImport.importSuccess', { title: result.title }) || `已导入：${result.title}`) + failedTip
          );
        } catch (err: any) {
          toast.dismiss(toastId);
          toast.error(err?.message || t('urlImport.importFailed') || "导入失败");
        }
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
      case "export_md": {
        if (!targetNb) break;
        // 收集根笔记本 + 所有子孙笔记本 id / name（递归）
        // - ids：新后端正常路径使用（精确过滤）
        // - names：旧后端降级路径使用（/export/notes 若无 notebookId 字段）
        const ids = new Set<string>();
        const names = new Set<string>();
        const collect = (id: string) => {
          if (ids.has(id)) return;
          ids.add(id);
          const cur = state.notebooks.find((nb) => nb.id === id);
          if (cur?.name) names.add(cur.name);
          for (const nb of state.notebooks) {
            if (nb.parentId === id) collect(nb.id);
          }
        };
        collect(targetNb.id);
        // duration=0 让"导出中"提示常驻，完成后手动 dismiss；
        // 流式进度提示（converting 每条都 emit）太频繁不放到 toast，只在出错时弹。
        const toastId = toast.info(t('export.exportingNotebook', { name: targetNb.name }), 0);
        try {
          const ok = await exportNotebook(
            {
              notebookId: targetNb.id,
              notebookName: targetNb.name,
              descendantNotebookIds: ids,
              descendantNotebookNames: names,
            },
            (p) => {
              if (p.phase === "error") toast.error(p.message);
            }
          );
          toast.dismiss(toastId);
          if (ok) toast.success(t('export.exportComplete'));
        } catch (err: any) {
          toast.dismiss(toastId);
          toast.error(err?.message || t('export.exportFailed', { error: String(err) }));
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
      toast.error(t('sidebar.moveCannotSelf'));
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
      toast.error(t('sidebar.moveFailed'));
      actions.refreshNotebooks();
    }
    setMoveNbTarget(null);
  };

  // 删除笔记本（v14 起：软删除 — 笔记本及其子孙隐藏，下属笔记进回收站）
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteNotebook(deleteTarget.id);
    } catch (err) {
      console.error("[Sidebar] deleteNotebook failed:", err);
    }
    // 递归收集被软删除笔记本及其所有子孙笔记本的 ID（前端乐观更新，不等下次拉取）
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
    // v14：触发笔记列表刷新——正在浏览回收站视图的用户能立刻看到刚被软删的
    // 笔记；其他视图刷新后也能正确反映"消失的笔记"。同时通知文件管理 / 数据
    // 管理刷新空间统计。
    try { actions.refreshNotes(); } catch { /* ignore */ }
    try {
      window.dispatchEvent(
        new CustomEvent("nowen:storage-changed", { detail: { reason: "notebook-deleted" } }),
      );
    } catch { /* ignore */ }
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

  // 允许其他视图（NoteList 回收站标题栏的"一键清空"按钮）通过自定义事件
  // 直接复用 Sidebar 已实现的清空逻辑（含 lock 检测 / 体量统计 / VACUUM 提示），
  // 避免在 NoteList 重复实现一份 80 行复杂逻辑。
  useEffect(() => {
    const onOpenEmptyTrash = () => { void openEmptyTrashConfirm(); };
    window.addEventListener("nowen:open-empty-trash", onOpenEmptyTrash);
    return () => window.removeEventListener("nowen:open-empty-trash", onOpenEmptyTrash);
  }, []);

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
      // 后端已自动 WAL checkpoint + 超阈值 VACUUM；如果没 VACUUM 但体量较大，
      // 友好提示用户可以手动压缩一次。阈值按"估算释放量 >= 10MB"判定。
      if (!res.vacuumed && (res.freedBytesEstimate || 0) >= 10 * 1024 * 1024) {
        toast.info(
          "占用较大但数据库未自动压缩。可在「数据管理」里点击「压缩数据库」进一步回收磁盘空间。",
        );
      }
      // 通知其他视图（FileManager / DataManager）刷新空间占用统计
      try {
        window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "trash-emptied" } }));
      } catch { /* ignore */ }
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

  // Y4: navItems 按工作区功能开关过滤。
  //   - features === null（个人空间或未加载到）→ 全开，行为与之前一致；
  //   - 工作区启用 JSON：显式 false 的模块被隐藏；未列出 / true 默认开启。
  //   - "all"（所有笔记）、"favorites"、"trash" 永远显示——它们是笔记模块本身，
  //     关掉 notes 相当于关掉整个工作区，产品上由 owner 在开关面板体现。
  //
  // v15 信息架构（方案 A）：扁平 8 项 → 3 个语义清晰的分组：
  //   - workspace（工作台）：所有笔记 + 它的过滤视图（收藏 / 回收站）+ 横切资源（文件管理）。
  //                        高频主入口，紧贴顶部，无分组标题，视觉权重最强。
  //   - modules（内容模块）：说说 / 待办 / 思维导图——独立的内容类型。
  //   - tools（工具）：AI 问答——功能性，与"内容"区分开。
  // 顺序在数组里就是渲染顺序；分组渲染时按 group 字段切片。
  const navItemsRaw: {
    icon: React.ReactNode;
    label: string;
    mode: ViewMode;
    active: boolean;
    feature?: keyof WorkspaceFeatures;
    group: "workspace" | "modules" | "tools";
  }[] = [
    // ─── 工作台 ───
    { icon: <BookOpen size={16} />, label: t('sidebar.allNotes'), mode: "all", active: state.viewMode === "all", feature: "notes", group: "workspace" },
    { icon: <Star size={16} />, label: t('sidebar.favorites'), mode: "favorites", active: state.viewMode === "favorites", feature: "favorites", group: "workspace" },
    { icon: <FolderOpen size={16} />, label: t('sidebar.fileManager'), mode: "files", active: state.viewMode === "files", feature: "files", group: "workspace" },
    { icon: <Trash2 size={16} />, label: t('sidebar.trash'), mode: "trash", active: state.viewMode === "trash", group: "workspace" },

    // ─── 内容模块 ───
    { icon: <NotebookPen size={16} />, label: t('sidebar.diary'), mode: "diary", active: state.viewMode === "diary", feature: "diaries", group: "modules" },
    { icon: <ListTodo size={16} />, label: t('sidebar.tasks'), mode: "tasks", active: state.viewMode === "tasks", feature: "tasks", group: "modules" },
    { icon: <BrainCircuit size={16} />, label: t('sidebar.mindMaps'), mode: "mindmaps", active: state.viewMode === "mindmaps", feature: "mindmaps", group: "modules" },

    // ─── 工具 ───
    { icon: <Sparkles size={16} />, label: t('sidebar.aiChat'), mode: "ai-chat", active: state.viewMode === "ai-chat", group: "tools" },
  ];
  const navItems = features
    ? navItemsRaw.filter((it) => !it.feature || features[it.feature] !== false)
    : navItemsRaw;

  // v16：桌面端折叠态由 App.tsx 控制（隐藏整个 Sidebar 但保留 NavRail）。
  // 移动端没有折叠概念（抽屉显隐由 mobileSidebarOpen 控制），所以这里无需任何分支。



  return (
    <div
      className="w-full h-full vibrancy-sidebar bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-colors"
      style={{ width: undefined }}
    >
      {/* Header（v15 紧凑化：py-3 → py-2，给下方笔记本/标签腾出 ~8px）
          v16：桌面变体下折叠按钮已迁移到 NavRail，Header 仅保留 Title +（移动）关闭按钮
          v16 P3 后续：桌面变体右侧加 Rail 模式切换按钮——单按钮循环切换三档
          icon → label → hidden → icon …，tooltip 提示下一档名称。
          单按钮循环的好处：无需新增菜单组件、无需占用 Header 多余空间；
          代价：用户首次发现需要点 2 次才到目标态——属于可接受的学习成本。
          v16 P3 后续 (mobile 双层化)：移动变体的关闭按钮也迁到 NavRail 顶部，
          Header 这里只剩纯标题。 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-app-border" style={{ paddingTop: 'calc(var(--safe-area-top) + 4px)' }}>
        <h1 className="text-sm font-semibold text-tx-primary tracking-wide">{siteConfig.title}</h1>
        <div className="flex items-center gap-1">
          {isDesktop && (() => {
            const next = nextRailMode(railMode);
            // 当前态对应的图标（提示"现在是几栏"），点击后切到 next：
            //   icon   → Columns3（3 列：Rail+Sidebar+Editor，纯图标 Rail）
            //   label  → 在 Columns3 基础上加底部小条暗示"带文字"——lucide 没有正好的图标，
            //           复用 Columns3 但 tooltip 不一样，足够区分（实测优于硬塞个不准的图标）
            //   hidden → Columns2（2 列：仅 Sidebar+Editor）
            const CurrentIcon = railMode === "hidden" ? Columns2 : Columns3;
            return (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setRailMode(next)}
                title={t(`sidebar.railMode.switchTo.${next}`)}
                aria-label={t(`sidebar.railMode.switchTo.${next}`)}
              >
                <CurrentIcon size={16} />
              </Button>
            );
          })()}
        </div>
      </div>

      {/* Workspace Switcher + Search（v15：合并垂直 padding，
          原来 pt-2 + py-2 共占 ~16px 间隙，现在压到 ~8px） */}
      <div className="px-3 pt-1.5 pb-1">
        <WorkspaceSwitcher />
      </div>

      {/* Search */}
      <div className="px-3 pb-1.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" size={14} />
          <Input
            placeholder={t('sidebar.searchPlaceholder')}
            className="pl-8 h-8 text-xs bg-app-bg border-app-border"
            value={searchInput}
            /* data-sidebar-search：Electron 原生"搜索"菜单 / Dock Quick Action 的
             * 聚焦目标。见 App.tsx 的 onOpenSearch。本应用没有全局搜索弹窗，
             * "搜索"语义就是聚焦此输入框。 */
            data-sidebar-search=""
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

      {/* ===== Navigation =====
          v16 P3 后续：移动端也已下沉到 NavRail variant="mobile"，主区不再渲染。
          桌面端早在 v16 主版本就迁出。本组件仅保留 navItemsRaw/navItems 定义
          以便后续清理（短期内这段死代码无运行时副作用——React 不会渲染未引用的项）。 */}

      {/* Separator——已移除：移动端导航迁出后无需在主区上方加分隔；
          WorkspaceSwitcher + 搜索 与笔记本的视觉间距已经足够。 */}

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
              onLongPress={(x, y, id) => openMenuAt(x, y, id, "notebook")}
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
              notebookNotes={notebookNotes}
              activeNoteId={state.activeNote?.id}
              onCreateNote={handleCreateNote}
              onDeleteNote={handleDeleteNote}
              onRenameNote={handleRenameNote}
              onToggleFavorite={handleToggleFavorite}
              onTogglePin={handleTogglePin}
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
                          "flex items-center gap-1.5 sm:gap-2 w-full px-1.5 sm:px-2 py-1 sm:py-1.5 rounded sm:rounded-md text-[11px] sm:text-xs transition-colors group/tag cursor-pointer",
                          isActive
                            ? "bg-app-active text-tx-primary"
                            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                        )}
                        onClick={() => {
                          // 长按已触发颜色选择时，跳过本次点击导航
                          if (tagLongPressFired.current) {
                            tagLongPressFired.current = false;
                            return;
                          }
                          actions.setSelectedTag(tag.id);
                          actions.setSelectedNotebook(null);
                          actions.setViewMode("tag");
                          actions.setMobileSidebar(false);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setTagColorPopover({
                            tagId: tag.id,
                            tagName: tag.name,
                            color: tag.color,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onTouchStart={(e) => {
                          const touch = e.touches[0];
                          if (!touch) return;
                          const startX = touch.clientX;
                          const startY = touch.clientY;
                          tagLongPressFired.current = false;
                          if (tagLongPressTimer.current) clearTimeout(tagLongPressTimer.current);
                          tagLongPressTimer.current = setTimeout(() => {
                            tagLongPressFired.current = true;
                            setTagColorPopover({
                              tagId: tag.id,
                              tagName: tag.name,
                              color: tag.color,
                              x: startX,
                              y: startY,
                            });
                          }, 500);
                        }}
                        onTouchMove={(e) => {
                          // 移动超过阈值则取消长按
                          if (tagLongPressTimer.current) {
                            const touch = e.touches[0];
                            if (!touch) return;
                            // 简单判断：直接清除（用户已开始滚动）
                            clearTimeout(tagLongPressTimer.current);
                            tagLongPressTimer.current = null;
                          }
                        }}
                        onTouchEnd={() => {
                          if (tagLongPressTimer.current) {
                            clearTimeout(tagLongPressTimer.current);
                            tagLongPressTimer.current = null;
                          }
                        }}
                        onTouchCancel={() => {
                          if (tagLongPressTimer.current) {
                            clearTimeout(tagLongPressTimer.current);
                            tagLongPressTimer.current = null;
                          }
                        }}
                      >
                        <span
                          className="shrink-0 inline-block rounded-full"
                          style={{
                            width: 6,
                            height: 6,
                            backgroundColor: tag.color,
                          }}
                        />
                        <span className="flex-1 truncate text-left">{tag.name}</span>
                        {/* 右侧尾部：固定宽度容器，内部用绝对定位叠放数字与删除按钮，避免 hover 时宽度变化引发抖动 */}
                        <span className="relative shrink-0 w-4 h-4 flex items-center justify-center">
                          {tag.noteCount !== undefined && tag.noteCount > 0 && (
                            <span className="absolute inset-0 flex items-center justify-center text-[10px] text-tx-tertiary tabular-nums [@media(hover:hover)]:group-hover/tag:opacity-0 transition-opacity">
                              {tag.noteCount}
                            </span>
                          )}
                          {/* 仅支持真 hover 的设备（鼠标）显示删除按钮，避免触屏 sticky hover */}
                          <button
                            className="absolute inset-0 hidden [@media(hover:hover)]:group-hover/tag:flex items-center justify-center text-tx-tertiary hover:text-red-500 transition-colors"
                            title={t('common.delete')}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTagTarget({ id: tag.id, name: tag.name, color: tag.color });
                            }}
                          >
                            <X size={12} strokeWidth={2.5} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer：v16 桌面端 / v16 P3 后续移动端，设置 + 登出 都迁到 NavRail。
          本组件不再渲染任何 Footer。 */}

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

      {/* Delete Tag Confirmation */}
      <AnimatePresence>
        {deleteTagTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setDeleteTagTarget(null)}
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
                  {t('sidebar.deleteTagTitle')}
                </h4>
              </div>
              <p className="text-sm text-tx-secondary mb-5 pl-[52px] flex items-center gap-1.5 flex-wrap">
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: deleteTagTarget.color }}
                />
                <span>{t('sidebar.confirmDeleteTag', { name: deleteTagTarget.name })}</span>
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteTagTarget(null)}
                  className="px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover rounded-lg transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={async () => {
                    const target = deleteTagTarget;
                    setDeleteTagTarget(null);
                    try {
                      await api.deleteTag(target.id);
                      const allTags = await api.getTags();
                      actions.setTags(allTags);
                      if (state.selectedTagId === target.id) {
                        actions.setSelectedTag(null);
                        actions.setViewMode("all");
                      }
                    } catch (err) {
                      console.error("Failed to delete tag:", err);
                    }
                  }}
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

      {/* 标签颜色选择浮层：右键 / 长按触发 */}
      {tagColorPopover && (
        <TagColorPopover
          x={tagColorPopover.x}
          y={tagColorPopover.y}
          currentColor={tagColorPopover.color}
          title={tagColorPopover.tagName}
          onPick={async (color) => {
            try {
              await api.updateTag(tagColorPopover.tagId, { color });
              const allTags = await api.getTags();
              actions.setTags(allTags);
            } catch (err) {
              console.error("Failed to update tag color:", err);
            }
          }}
          onClose={() => setTagColorPopover(null)}
        />
      )}
    </div>
  );
}
