import React, { useEffect, useCallback, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Pin, PinOff, Star, StarOff, Clock, FileText, Trash2, ArchiveRestore, Menu, FolderInput, ChevronRight, ChevronDown, ChevronLeft, Folder, X, Check, Lock, Unlock, CalendarDays, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { NoteListItem, Notebook } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { haptic } from "@/hooks/useCapacitor";

function formatTime(dateStr: string, t: (key: string, opts?: any) => string) {
  const d = new Date(dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('common.justNow');
  if (diffMin < 60) return t('common.minutesAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('common.hoursAgo', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t('common.daysAgo', { count: diffDay });
  return d.toLocaleDateString();
}

/* ===== 笔记本树形选择 ===== */
function buildNotebookTree(notebooks: Notebook[]): Notebook[] {
  const map = new Map<string, Notebook>();
  const roots: Notebook[] = [];
  for (const nb of notebooks) {
    map.set(nb.id, { ...nb, children: [] });
  }
  for (const nb of notebooks) {
    const node = map.get(nb.id)!;
    if (nb.parentId && map.has(nb.parentId)) {
      map.get(nb.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function NotebookTreeItem({
  notebook, depth, selectedId, currentNotebookId, onSelect,
}: {
  notebook: Notebook; depth: number; selectedId: string | null;
  currentNotebookId: string; onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const hasChildren = notebook.children && notebook.children.length > 0;
  const isCurrent = notebook.id === currentNotebookId;
  const isSelected = notebook.id === selectedId;

  return (
    <div>
      <button
        onClick={() => !isCurrent && onSelect(notebook.id)}
        disabled={isCurrent}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
          isCurrent
            ? "opacity-40 cursor-not-allowed"
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
        <Folder size={14} className="shrink-0" />
        <span className="truncate flex-1 text-left">{notebook.name}</span>
        {isCurrent && <span className="text-[10px] text-tx-tertiary shrink-0">{t('common.current')}</span>}
        {isSelected && <Check size={14} className="text-accent-primary shrink-0" />}
      </button>
      {hasChildren && expanded && notebook.children!.map((child) => (
        <NotebookTreeItem
          key={child.id}
          notebook={child}
          depth={depth + 1}
          selectedId={selectedId}
          currentNotebookId={currentNotebookId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MoveNoteModal({
  isOpen, noteTitle, currentNotebookId, notebooks, onMove, onClose,
}: {
  isOpen: boolean; noteTitle: string; currentNotebookId: string;
  notebooks: Notebook[]; onMove: (notebookId: string) => void; onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useTranslation();
  const tree = buildNotebookTree(notebooks);

  useEffect(() => {
    if (isOpen) setSelectedId(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[360px] mx-4 max-h-[480px] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2 min-w-0">
            <FolderInput size={16} className="text-accent-primary shrink-0" />
            <span className="text-sm font-medium text-tx-primary truncate">{t('noteList.moveNote')}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-tx-tertiary truncate border-b border-app-border">
          {noteTitle || t('common.untitledNote')}
        </div>
        <ScrollArea className="flex-1 max-h-[300px]">
          <div className="p-2">
            {tree.map((nb) => (
              <NotebookTreeItem
                key={nb.id}
                notebook={nb}
                depth={0}
                selectedId={selectedId}
                currentNotebookId={currentNotebookId}
                onSelect={setSelectedId}
              />
            ))}
            {tree.length === 0 && (
              <p className="text-xs text-tx-tertiary text-center py-4">{t('noteList.noNotebooks')}</p>
            )}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="sm"
            disabled={!selectedId || selectedId === currentNotebookId}
            onClick={() => selectedId && onMove(selectedId)}
            className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
          >
            {t('noteList.moveButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ===== 迷你日历筛选器 ===== */
function MiniCalendarFilter({
  selectedDate,
  onSelect,
  onClear,
}: {
  selectedDate: string | null; // YYYY-MM-DD
  onSelect: (date: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-based

  const weekDays = [
    t("noteList.weekSun"),
    t("noteList.weekMon"),
    t("noteList.weekTue"),
    t("noteList.weekWed"),
    t("noteList.weekThu"),
    t("noteList.weekFri"),
    t("noteList.weekSat"),
  ];

  // 构建日历格子
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

  const cells: { day: number; current: boolean; dateStr: string }[] = [];

  // 上月补齐
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const m = viewMonth === 0 ? 12 : viewMonth;
    const y = viewMonth === 0 ? viewYear - 1 : viewYear;
    cells.push({ day: d, current: false, dateStr: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  // 当月
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      day: d,
      current: true,
      dateStr: `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    });
  }
  // 下月补齐到 42 或至少填满最后一行
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 1 : viewMonth + 2;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ day: d, current: false, dateStr: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
    }
  }

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else setViewMonth(viewMonth - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else setViewMonth(viewMonth + 1);
  };
  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
  };

  return (
    <div className="px-3 py-2 select-none">
      {/* 月份导航 */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={prevMonth} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
          <ChevronLeft size={14} />
        </button>
        <button onClick={goToday} className="text-xs font-medium text-tx-secondary hover:text-tx-primary transition-colors">
          {viewYear}{t("noteList.calendarYear")}{viewMonth + 1}{t("noteList.calendarMonth")}
        </button>
        <button onClick={nextMonth} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
          <ChevronRight size={14} />
        </button>
      </div>

      {/* 星期头 */}
      <div className="grid grid-cols-7 mb-1">
        {weekDays.map((wd) => (
          <div key={wd} className="text-center text-[10px] text-tx-tertiary py-0.5">{wd}</div>
        ))}
      </div>

      {/* 日期格子 */}
      <div className="grid grid-cols-7">
        {cells.map(({ day, current, dateStr }, idx) => {
          const isToday = dateStr === todayStr;
          const isSelected = dateStr === selectedDate;
          return (
            <button
              key={idx}
              onClick={() => {
                if (isSelected) onClear();
                else onSelect(dateStr);
              }}
              className={cn(
                "h-7 text-[11px] rounded-md transition-all flex items-center justify-center",
                !current && "text-tx-tertiary/40",
                current && !isSelected && !isToday && "text-tx-secondary hover:bg-app-hover",
                isToday && !isSelected && "text-accent-primary font-bold",
                isSelected && "bg-accent-primary text-white font-medium shadow-sm"
              )}
            >
              {day}
            </button>
          );
        })}
      </div>

      {/* 已选日期提示 + 清除 */}
      {selectedDate && (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-app-border/50">
          <span className="text-[10px] text-tx-tertiary">
            {t("noteList.filterDate")}: {selectedDate}
          </span>
          <button
            onClick={onClear}
            className="text-[10px] text-accent-primary hover:text-accent-primary/80 transition-colors"
          >
            {t("noteList.clearFilter")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ===== P6: 下拉刷新组件 ===== */
function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const isAtTop = useRef(false);
  const { t } = useTranslation();

  const THRESHOLD = 70; // 触发刷新的下拉距离
  const MAX_PULL = 120; // 最大下拉距离

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (refreshing) return;
    const scrollContainer = containerRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    isAtTop.current = !scrollContainer || scrollContainer.scrollTop <= 0;
    if (isAtTop.current) {
      touchStartY.current = e.touches[0].clientY;
    }
  }, [refreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isAtTop.current || refreshing) return;
    const deltaY = e.touches[0].clientY - touchStartY.current;
    if (deltaY > 0) {
      // 应用阻尼效果：越往下拉越难拉
      const dampedDistance = Math.min(MAX_PULL, deltaY * 0.45);
      setPullDistance(dampedDistance);
      setPulling(true);

      // 达到阈值时触发触觉反馈
      if (dampedDistance >= THRESHOLD && pullDistance < THRESHOLD) {
        haptic.light();
      }
    } else {
      setPulling(false);
      setPullDistance(0);
    }
  }, [refreshing, pullDistance]);

  const handleTouchEnd = useCallback(async () => {
    if (!pulling) return;

    if (pullDistance >= THRESHOLD) {
      setRefreshing(true);
      setPullDistance(THRESHOLD * 0.6); // 刷新时保持一定偏移显示 loading
      haptic.medium();
      try {
        await onRefresh();
        haptic.success();
      } catch {
        haptic.error();
      }
      setRefreshing(false);
    }

    setPulling(false);
    setPullDistance(0);
  }, [pulling, pullDistance, onRefresh]);

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="relative flex-1 flex flex-col overflow-hidden"
    >
      {/* 下拉刷新指示器 */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-center z-10 pointer-events-none transition-opacity"
        style={{
          height: `${Math.max(pullDistance, 0)}px`,
          opacity: pullDistance > 10 ? 1 : 0,
        }}
      >
        <div className="flex items-center gap-2 text-tx-tertiary">
          <RefreshCw
            size={16}
            className={cn(
              "transition-transform",
              refreshing && "animate-spin",
              pullDistance >= THRESHOLD && !refreshing && "text-accent-primary"
            )}
            style={{
              transform: refreshing
                ? undefined
                : `rotate(${Math.min(pullDistance / THRESHOLD, 1) * 360}deg)`,
            }}
          />
          <span className="text-xs">
            {refreshing
              ? t("noteList.refreshing") || "刷新中..."
              : pullDistance >= THRESHOLD
              ? t("noteList.releaseToRefresh") || "释放刷新"
              : t("noteList.pullToRefresh") || "下拉刷新"}
          </span>
        </div>
      </div>

      {/* 内容区域 */}
      <div
        className="flex-1 flex flex-col transition-transform"
        style={{
          transform: pullDistance > 0 ? `translateY(${pullDistance}px)` : undefined,
          transition: pulling ? "none" : "transform 0.3s ease-out",
        }}
      >
        {children}
      </div>
    </div>
  );
}

const NoteCard = React.forwardRef<HTMLDivElement, {
  note: NoteListItem; isActive: boolean; onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isContextTarget: boolean;
}>(function NoteCard({ note, isActive, onClick, onContextMenu, isContextTarget }, ref) {
  const preview = note.contentText?.slice(0, 100) || "";
  const { t } = useTranslation();
  const wordCount = note.contentText?.length || 0;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "relative rounded-lg cursor-pointer border transition-all group overflow-hidden",
        isActive
          ? "bg-app-active border-accent-primary/30 shadow-sm"
          : isContextTarget
          ? "bg-app-hover border-accent-primary/20"
          : "bg-transparent border-transparent hover:bg-app-hover"
      )}
    >
      {/* 左侧彩色指示条 */}
      <div className={cn(
        "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg transition-colors",
        isActive
          ? "bg-accent-primary"
          : note.isFavorite === 1
          ? "bg-amber-400"
          : note.isPinned === 1
          ? "bg-accent-primary/50"
          : "bg-transparent group-hover:bg-app-border"
      )} />

      <div className="pl-3.5 pr-3 py-2.5">
        {/* 标题行 + 状态图标 */}
        <div className="flex items-center justify-between gap-2">
          <h3 className={cn(
            "text-sm font-medium truncate flex-1",
            isActive ? "text-tx-primary" : "text-tx-secondary group-hover:text-tx-primary"
          )}>
            {note.title || t('common.untitledNote')}
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            {note.isLocked === 1 && <Lock size={11} className="text-orange-500" />}
            {note.isPinned === 1 && <Pin size={11} className="text-accent-primary" />}
            {note.isFavorite === 1 && <Star size={11} className="text-amber-400 fill-amber-400" />}
          </div>
        </div>

        {/* 内容预览 */}
        {preview && (
          <p className="text-xs text-tx-tertiary mt-1.5 line-clamp-2 leading-relaxed">{preview}</p>
        )}

        {/* 底部元信息行 */}
        <div className="flex items-center justify-between mt-2 text-tx-tertiary">
          <div className="flex items-center gap-1.5">
            <Clock size={10} />
            <span className="text-[10px]">{formatTime(note.updatedAt, t)}</span>
          </div>
          {wordCount > 0 && (
            <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
              {wordCount > 999 ? `${(wordCount / 1000).toFixed(1)}k` : wordCount} {t('common.chars') || '字'}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
});

export default function NoteList() {
  const { state } = useApp();
  const actions = useAppActions();
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();
  const [moveModal, setMoveModal] = useState<{ noteId: string; noteTitle: string; notebookId: string } | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null); // YYYY-MM-DD
  const [showCalendar, setShowCalendar] = useState(false);
  const { t } = useTranslation();

  const fetchNotes = useCallback(async () => {
    actions.setLoading(true);
    let notes: NoteListItem[] = [];
    if (state.viewMode === "notebook" && state.selectedNotebookId) {
      const params: Record<string, string> = { notebookId: state.selectedNotebookId };
      if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
      notes = await api.getNotes(params);
    } else if (state.viewMode === "favorites") {
      const params: Record<string, string> = { isFavorite: "1" };
      if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
      notes = await api.getNotes(params);
    } else if (state.viewMode === "trash") {
      notes = await api.getNotes({ isTrashed: "1" });
    } else if (state.viewMode === "search" && state.searchQuery) {
      const results = await api.search(state.searchQuery);
      notes = results.map((r) => ({
        id: r.id,
        userId: "",
        notebookId: r.notebookId,
        title: r.title,
        contentText: r.snippet,
        isPinned: r.isPinned,
        isFavorite: r.isFavorite,
        isArchived: 0,
        isTrashed: 0,
        isLocked: 0,
        version: 0,
        createdAt: r.updatedAt,
        updatedAt: r.updatedAt,
      }));
    } else if (state.viewMode === "tag" && state.selectedTagId) {
      notes = await api.getNotesWithTag(state.selectedTagId);
    } else {
      const params: Record<string, string> = {};
      if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
      notes = await api.getNotes(Object.keys(params).length > 0 ? params : undefined);
    }
    actions.setNotes(notes);
    actions.setLoading(false);
  }, [state.viewMode, state.selectedNotebookId, state.searchQuery, state.selectedTagId, dateFilter]);

  useEffect(() => {
    fetchNotes().catch(console.error);
  }, [fetchNotes]);

  // viewMode 切换时自动收起日历并清除筛选
  useEffect(() => {
    setDateFilter(null);
    setShowCalendar(false);
  }, [state.viewMode]);

  const handleSelectNote = async (noteId: string) => {
    haptic.selection();
    const note = await api.getNote(noteId);
    actions.setActiveNote(note);
    actions.setMobileView("editor");
  };

  const handleCreateNote = async () => {
    haptic.light();
    const notebookId = state.selectedNotebookId || state.notebooks[0]?.id;
    if (!notebookId) return;
    const note = await api.createNote({ notebookId, title: t('common.untitledNote') });
    actions.setActiveNote(note);
    await fetchNotes();
    actions.refreshNotebooks();
  };

  // 根据当前视图和目标笔记动态构建菜单项
  const getMenuItems = (): ContextMenuItem[] => {
    const targetNote = state.notes.find((n) => n.id === menu.targetId);
    if (!targetNote) return [];

    const isTrashView = state.viewMode === "trash";

    if (isTrashView) {
      return [
        { id: "restore", label: t('noteList.restoreNote'), icon: <ArchiveRestore size={14} /> },
        { id: "sep1", label: "", separator: true },
        { id: "delete_permanent", label: t('noteList.permanentDelete'), icon: <Trash2 size={14} />, danger: true },
      ];
    }

    return [
      {
        id: "toggle_pin",
        label: targetNote.isPinned === 1 ? t('noteList.unpin') : t('noteList.pin'),
        icon: targetNote.isPinned === 1 ? <PinOff size={14} /> : <Pin size={14} />,
      },
      {
        id: "toggle_fav",
        label: targetNote.isFavorite === 1 ? t('noteList.unfavorite') : t('noteList.favorite'),
        icon: targetNote.isFavorite === 1 ? <StarOff size={14} /> : <Star size={14} />,
      },
      {
        id: "toggle_lock",
        label: targetNote.isLocked === 1 ? t('noteList.unlock') : t('noteList.lock'),
        icon: targetNote.isLocked === 1 ? <Unlock size={14} /> : <Lock size={14} />,
      },
      { id: "sep1", label: "", separator: true },
      {
        id: "move",
        label: t('noteList.moveTo'),
        icon: <FolderInput size={14} />,
        disabled: !!targetNote.isLocked,
      },
      { id: "sep2", label: "", separator: true },
      { id: "trash", label: t('noteList.moveToTrash'), icon: <Trash2 size={14} />, danger: true, disabled: !!targetNote.isLocked },
    ];
  };

  const handleMenuAction = async (actionId: string) => {
    const targetId = menu.targetId;
    closeMenu();
    if (!targetId) return;

    const targetNote = state.notes.find((n) => n.id === targetId);
    if (!targetNote) return;

    switch (actionId) {
      case "toggle_pin": {
        haptic.light();
        const newVal = targetNote.isPinned === 1 ? 0 : 1;
        await api.updateNote(targetId, { isPinned: newVal } as any);
        actions.updateNoteInList({ id: targetId, isPinned: newVal });
        break;
      }
      case "toggle_fav": {
        haptic.light();
        const newVal = targetNote.isFavorite === 1 ? 0 : 1;
        await api.updateNote(targetId, { isFavorite: newVal } as any);
        actions.updateNoteInList({ id: targetId, isFavorite: newVal });
        break;
      }
      case "toggle_lock": {
        haptic.medium();
        const newVal = targetNote.isLocked === 1 ? 0 : 1;
        await api.updateNote(targetId, { isLocked: newVal } as any);
        actions.updateNoteInList({ id: targetId, isLocked: newVal });
        if (state.activeNote?.id === targetId) {
          actions.setActiveNote({ ...state.activeNote, isLocked: newVal });
        }
        break;
      }
      case "trash": {
        haptic.heavy();
        await api.updateNote(targetId, { isTrashed: 1 } as any);
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        await fetchNotes();
        actions.refreshNotebooks();
        break;
      }
      case "move": {
        setMoveModal({
          noteId: targetId,
          noteTitle: targetNote.title,
          notebookId: targetNote.notebookId,
        });
        break;
      }
      case "restore": {
        haptic.success();
        await api.updateNote(targetId, { isTrashed: 0 } as any);
        await fetchNotes();
        actions.refreshNotebooks();
        break;
      }
      case "delete_permanent": {
        haptic.heavy();
        await api.deleteNote(targetId);
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        await fetchNotes();
        actions.refreshNotebooks();
        break;
      }
    }
  };

  const handleMoveNote = async (targetNotebookId: string) => {
    if (!moveModal) return;
    await api.updateNote(moveModal.noteId, { notebookId: targetNotebookId } as any);
    if (state.activeNote?.id === moveModal.noteId) {
      actions.setActiveNote({ ...state.activeNote, notebookId: targetNotebookId });
    }
    setMoveModal(null);
    await fetchNotes();
    actions.refreshNotebooks();
  };

  const viewTitles: Record<string, string> = {
    all: t('noteList.allNotes'),
    notebook: state.notebooks.find((n) => n.id === state.selectedNotebookId)?.name || t('noteList.notebook'),
    favorites: t('noteList.favorite'),
    trash: t('sidebar.trash'),
    search: t('noteList.search', { query: state.searchQuery }),
    tag: `# ${state.tags.find((tg) => tg.id === state.selectedTagId)?.name || t('noteList.tag')}`,
  };

  return (
    <div className="w-full h-full bg-app-surface border-r border-app-border flex flex-col transition-colors relative">
      {/* Mobile Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-app-border md:hidden" style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}>
        <button
          onClick={() => actions.setMobileSidebar(true)}
          className="p-2 -ml-2 rounded-lg text-tx-secondary hover:bg-app-hover active:bg-app-active"
        >
          <Menu size={24} />
        </button>
        <h2 className="text-sm font-semibold text-tx-primary">{viewTitles[state.viewMode]}</h2>
        <div className="flex items-center gap-1">
          {/* 移动端日历筛选按钮 */}
          {state.viewMode !== "trash" && state.viewMode !== "search" && (
            <button
              onClick={() => setShowCalendar(!showCalendar)}
              className={cn(
                "p-1.5 rounded-md transition-colors relative",
                showCalendar || dateFilter
                  ? "text-accent-primary bg-accent-primary/10"
                  : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
              )}
            >
              <CalendarDays size={18} />
              {dateFilter && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-primary" />
              )}
            </button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleCreateNote}>
            <Plus size={18} />
          </Button>
        </div>
      </header>

      {/* Desktop Header */}
      <div className="hidden md:flex items-center justify-between px-4 py-3 border-b border-app-border">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-accent-primary" />
          <h2 className="text-sm font-medium text-tx-primary">{viewTitles[state.viewMode]}</h2>
        </div>
        <div className="flex items-center gap-1">
          {/* 日历筛选按钮 */}
          {state.viewMode !== "trash" && state.viewMode !== "search" && (
            <button
              onClick={() => setShowCalendar(!showCalendar)}
              className={cn(
                "p-1.5 rounded-md transition-colors relative",
                showCalendar || dateFilter
                  ? "text-accent-primary bg-accent-primary/10"
                  : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
              )}
              title={t("noteList.dateFilter")}
            >
              <CalendarDays size={15} />
              {dateFilter && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-primary" />
              )}
            </button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCreateNote}>
            <Plus size={15} />
          </Button>
        </div>
      </div>

      {/* 日历筛选面板 */}
      {showCalendar && state.viewMode !== "trash" && state.viewMode !== "search" && (
        <div className="border-b border-app-border bg-app-surface max-md:animate-in max-md:slide-in-from-top max-md:duration-200">
          <MiniCalendarFilter
            selectedDate={dateFilter}
            onSelect={(d) => setDateFilter(d)}
            onClear={() => setDateFilter(null)}
          />
        </div>
      )}

      {/* Count */}
      <div className="px-4 py-1.5">
        <span className="text-[10px] text-tx-tertiary">{t('common.noteCount', { count: state.notes.length })}</span>
      </div>

      {/* List - 包裹下拉刷新（仅移动端生效，桌面端不影响） */}
      <PullToRefresh onRefresh={fetchNotes}>
        <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-1">
          <AnimatePresence mode="popLayout">
            {state.notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                isActive={state.activeNote?.id === note.id}
                isContextTarget={menu.isOpen && menu.targetId === note.id}
                onClick={() => handleSelectNote(note.id)}
                onContextMenu={(e) => openMenu(e, note.id, "note")}
              />
            ))}
          </AnimatePresence>
          {state.notes.length === 0 && !state.isLoading && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-accent-primary/10 flex items-center justify-center mb-4">
                <FileText size={28} className="text-accent-primary/40" />
              </div>
              <p className="text-sm font-medium text-tx-secondary mb-1">{t('common.noNotes')}</p>
              <p className="text-xs text-tx-tertiary mb-5 max-w-[200px] leading-relaxed">
                {t('common.noNotesHint')}
              </p>
              <button
                onClick={handleCreateNote}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary/90 active:scale-95 transition-all shadow-sm"
              >
                <Plus size={14} />
                {t('common.newNote')}
              </button>
            </div>
          )}
          {/* 骨架屏 Loading */}
          {state.isLoading && state.notes.length === 0 && (
            <div className="space-y-2 px-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="rounded-lg border border-transparent p-3 animate-pulse">
                  <div className="flex items-center gap-2">
                    <div className="h-4 bg-app-hover rounded w-3/5" />
                    <div className="h-3 bg-app-hover rounded w-4 ml-auto" />
                  </div>
                  <div className="h-3 bg-app-hover/70 rounded w-full mt-2.5" />
                  <div className="h-3 bg-app-hover/50 rounded w-4/5 mt-1.5" />
                  <div className="flex items-center gap-1.5 mt-2.5">
                    <div className="h-2.5 w-2.5 bg-app-hover/60 rounded-full" />
                    <div className="h-2.5 bg-app-hover/40 rounded w-16" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      </PullToRefresh>

      {/* Mobile FAB - 新建笔记 */}
      <button
        onClick={handleCreateNote}
        className="md:hidden absolute bottom-6 right-6 w-14 h-14 bg-accent-primary rounded-2xl shadow-lg shadow-accent-primary/30 flex items-center justify-center text-white active:scale-95 transition-transform z-10"
      >
        <Plus size={24} />
      </button>

      {/* Note Context Menu */}
      <ContextMenu
        isOpen={menu.isOpen && menu.targetType === "note"}
        x={menu.x}
        y={menu.y}
        menuRef={menuRef}
        items={getMenuItems()}
        onAction={handleMenuAction}
        header={state.notes.find((n) => n.id === menu.targetId)?.title || t('noteList.note')}
      />

      {/* Move Note Modal */}
      <MoveNoteModal
        isOpen={!!moveModal}
        noteTitle={moveModal?.noteTitle || ""}
        currentNotebookId={moveModal?.notebookId || ""}
        notebooks={state.notebooks}
        onMove={handleMoveNote}
        onClose={() => setMoveModal(null)}
      />
    </div>
  );
}
