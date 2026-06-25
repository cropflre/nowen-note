import React, { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Pin, PinOff, Star, StarOff, Clock, FileText, FileCode, FileType2, Trash2, ArchiveRestore, Menu, FolderInput, ChevronRight, ChevronDown, ChevronLeft, Folder, X, Check, Lock, Unlock, CalendarDays, RefreshCw, Share2, GripVertical, Download, ArrowUpDown, ArrowUp, ArrowDown, Image as ImageIcon, Printer, User as UserIcon, Sparkles, Tag as TagIcon, Loader2, FileUp, PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, getCurrentWorkspace } from "@/lib/api";
import { NoteListItem, Notebook } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { haptic } from "@/hooks/useCapacitor";
import { toast } from "@/lib/toast";
import { exportSingleNote, exportSingleNoteAsPDF, exportSingleNoteAsImage, exportNoteAsImage } from "@/lib/exportService";
import { realtime } from "@/lib/realtime"
import { syncNow } from "@/lib/syncEngine"
import { deleteNote as deleteLocalNote, getNote as getLocalNote, putNote as putLocalNote } from "@/lib/localStore"
import { confirm } from "@/components/ui/confirm";
import { highlightTextNode, sanitizeSearchHtml, stripSearchMarks } from "@/lib/searchHighlight";
// "导入 Word 文档" 走 dynamic import（见 createNoteInNotebook），减少首屏 bundle 体积。

/* ===== 排序模式 ===== */
type SortBy = "manual" | "updatedAt" | "createdAt" | "title";
type SortDir = "asc" | "desc";
const SORT_STORAGE_KEY = "nowen.noteList.sort";

function loadSortPref(): { by: SortBy; dir: SortDir } {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return { by: "manual", dir: "desc" };
    const parsed = JSON.parse(raw);
    const by: SortBy =
      parsed.by === "updatedAt" || parsed.by === "createdAt" || parsed.by === "title" || parsed.by === "manual"
        ? parsed.by
        : "manual";
    const dir: SortDir = parsed.dir === "asc" ? "asc" : "desc";
    return { by, dir };
  } catch {
    return { by: "manual", dir: "desc" };
  }
}

function saveSortPref(pref: { by: SortBy; dir: SortDir }) {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(pref)); } catch {}
}

const TIME_VISIBILITY_STORAGE_KEY = "nowen.noteList.showTime";

function loadShowTimePref(): boolean {
  try {
    const raw = localStorage.getItem(TIME_VISIBILITY_STORAGE_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

function saveShowTimePref(value: boolean) {
  try { localStorage.setItem(TIME_VISIBILITY_STORAGE_KEY, String(value)); } catch {}
}

/* ===== 排序下拉菜单 =====
 * 设计要点（针对历史踩坑）：
 *   1) 用 createPortal 挂到 document.body，绕过任何祖先的 stacking context / overflow 限制；
 *   2) 用一个全屏透明 backdrop 承载 click-outside 关闭（点 backdrop 时 onMouseDown 关闭），
 *      不再依赖 document 级 mousedown 监听，避免与菜单内部的 click 事件竞态；
 *   3) 菜单项的 onClick 用 e.stopPropagation 防止冒泡到 backdrop；
 *   4) 菜单项使用真正的 <button>，不附加 onMouseDown 干扰 click；
 *   5) 位置在每次 anchor 变化或 window resize/scroll 时重新计算。
 */
function SortMenu({
  value,
  onChange,
  onClose,
  anchorRef,
  showNoteTime,
  onToggleShowTime,
}: {
  value: { by: SortBy; dir: SortDir };
  onChange: (next: { by: SortBy; dir: SortDir }) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  showNoteTime: boolean;
  onToggleShowTime: () => void;
}) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 根据 anchor 按钮位置计算菜单坐标；监听 resize/scroll 保持跟随
  useEffect(() => {
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // 菜单宽度 176px（w-44），右对齐于按钮
      const left = Math.max(4, Math.min(window.innerWidth - 180, rect.right - 176));
      const top = Math.min(window.innerHeight - 8, rect.bottom + 4);
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);

  // ESC 键关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const options: { id: SortBy; label: string }[] = [
    { id: "manual", label: t("noteList.sortManual") },
    { id: "updatedAt", label: t("noteList.sortUpdatedAt") },
    { id: "createdAt", label: t("noteList.sortCreatedAt") },
    { id: "title", label: t("noteList.sortTitle") },
  ];

  const handleOptionClick = (
    e: React.MouseEvent,
    opt: { id: SortBy; label: string },
    active: boolean
  ) => {
    e.preventDefault();
    e.stopPropagation();
    let next: { by: SortBy; dir: SortDir };
    if (active && opt.id !== "manual") {
      next = { by: opt.id, dir: value.dir === "asc" ? "desc" : "asc" };
    } else {
      const defaultDir: SortDir = opt.id === "title" ? "asc" : "desc";
      next = { by: opt.id, dir: opt.id === "manual" ? "desc" : defaultDir };
    }
    onChange(next);
    onClose();
  };

  // pos 还没计算完就先不渲染，避免闪现在 (0,0)
  if (!pos) return null;

  return createPortal(
    <>
      {/* 全屏 backdrop：捕获外部点击关闭，不要遮盖菜单本身 */}
      <div
        onMouseDown={(e) => {
          // 仅当点击的是 backdrop 自身（不是菜单子元素）才关闭
          if (e.target === e.currentTarget) {
            e.preventDefault();
            onClose();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9998,
          background: "transparent",
        }}
      >
        {/* 菜单本体 */}
        <div
          role="menu"
          className="rounded-lg border border-app-border bg-app-elevated shadow-xl py-1"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: 176,
            zIndex: 9999,
            animation: "contextMenuIn 0.12s ease-out",
          }}
          // 阻止菜单上的 mousedown 冒泡到 backdrop（双保险，因为已用 e.target===currentTarget 判断）
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-tx-tertiary select-none">
            {t("noteList.sortBy")}
          </div>
          {options.map((opt) => {
            const active = value.by === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                onClick={(e) => handleOptionClick(e, opt, active)}
                className={cn(
                  "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors text-left",
                  active
                    ? "text-accent-primary bg-accent-primary/10"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                )}
              >
                <span className="flex items-center gap-2">
                  {active ? <Check size={12} className="shrink-0" /> : <span className="w-3 shrink-0" />}
                  <span>{opt.label}</span>
                </span>
                {active && opt.id !== "manual" && (
                  <span className="flex items-center gap-1 text-[10px] text-tx-tertiary">
                    {value.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                    {value.dir === "asc" ? t("noteList.sortAsc") : t("noteList.sortDesc")}
                  </span>
                )}
              </button>
            );
          })}
        </div>

          {/* 分割线 */}
          <div className="my-1 border-t border-app-border" />

          {/* 显示更新时间开关 */}
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleShowTime(); }}
            className={cn(
              "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors text-left",
              showNoteTime
                ? "text-accent-primary bg-accent-primary/10"
                : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
            )}
          >
            <span className="flex items-center gap-2">
              {showNoteTime ? <Check size={12} className="shrink-0" /> : <span className="w-3 shrink-0" />}
              <span>{t("noteList.showUpdatedTime")}</span>
            </span>
          </button>
      </div>
    </>,
    document.body
  );
}

/* ===== 新建按钮的下拉菜单 =====
 * 用法：split-button 旁的小箭头 ▾ 点开后弹出，让用户在
 *   - 新建普通笔记
 *   - 新建 Word 文档
 * 之间选择。+ 主按钮的单击行为不变（继续走 normal），保留肌肉记忆。
 *
 * 复用 SortMenu 的 portal + backdrop 模式（同一份"踩坑笔记"已写在 SortMenu 注释里）。
 */
function CreateMenu({
  onPick,
  onClose,
  anchorRef,
}: {
  onPick: (type: "normal" | "markdown" | "word") => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const left = Math.max(4, Math.min(window.innerWidth - 220, rect.right - 200));
      const top = Math.min(window.innerHeight - 8, rect.bottom + 4);
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!pos) return null;

  // 文案直接硬编码：项目当前 i18n 资源是空的（src/i18n 目录里没条目），
  // 走 t() 会拿到 key 本身（如 "noteList.createNormalNote"），
  // 由于 key 本身是 truthy 字符串，`||` 兜底永远不生效，UI 就会显示原始 key。
  const items = [
    {
      id: "normal" as const,
      label: "新建笔记",
      desc: "富文本 / Markdown",
      icon: <FileText size={14} />,
    },
    {
      id: "markdown" as const,
      label: "新建 Markdown 笔记",
      desc: "原生 Markdown 编辑器",
      icon: <FileCode size={14} />,
    },
    {
      id: "word" as const,
      label: "导入 Word 文档",
      desc: "选择 .docx 转为可编辑笔记",
      icon: <FileType2 size={14} />,
    },
  ];

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
    >
      <div
        role="menu"
        className="rounded-lg border border-app-border bg-app-elevated shadow-xl py-1"
        style={{
          position: "fixed", top: pos.top, left: pos.left, width: 200, zIndex: 9999,
          animation: "contextMenuIn 0.12s ease-out",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onPick(it.id);
              onClose();
            }}
            className="w-full flex items-start gap-2 px-3 py-2 text-left text-tx-secondary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <span className="mt-0.5 shrink-0 text-tx-tertiary">{it.icon}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-medium truncate">{it.label}</span>
              <span className="block text-[10px] text-tx-tertiary truncate">{it.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

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
  isOpen, noteTitle, count, currentNotebookId, notebooks, sourceWorkspaceId, onMove, onClose,
}: {
  isOpen: boolean; noteTitle: string; count?: number; currentNotebookId: string;
  notebooks: Notebook[];
  /**
   * 源笔记所在的工作区（null = 个人空间）。候选目标会被严格限制到同一个
   * workspace，以匹配后端 PUT /notes/:id 的 "CROSS_WORKSPACE_MOVE_FORBIDDEN"
   * 校验——避免用户在"混合列表"状态下选到另一空间的笔记本后收到 400。
   *
   * 不传（undefined） → 不做过滤，回落到旧行为（给所有 notebooks）。
   */
  sourceWorkspaceId?: string | null;
  onMove: (notebookId: string) => void; onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useTranslation();
  // 归一化：workspaceId 为 undefined/"" 都视作 null（= 个人空间）
  const normalizedSrc = sourceWorkspaceId === undefined ? undefined : (sourceWorkspaceId || null);
  const filteredNotebooks =
    normalizedSrc === undefined
      ? notebooks
      : notebooks.filter((nb) => (nb.workspaceId || null) === normalizedSrc);
  const tree = buildNotebookTree(filteredNotebooks);
  const isBulk = (count || 1) > 1;

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
      <div className="relative w-full max-w-[360px] mx-4 max-h-[80vh] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2 min-w-0">
            <FolderInput size={16} className="text-accent-primary shrink-0" />
            <span className="text-sm font-medium text-tx-primary truncate">
              {isBulk ? t('noteList.moveNotesTitle', { count }) : t('noteList.moveNote')}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-tx-tertiary truncate border-b border-app-border">
          {isBulk
            ? t('noteList.selectedCount', { count })
            : (noteTitle || t('common.untitledNote'))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
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
        </div>
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

/* ===== AI 批量归类确认面板 =====
 * 用途：批量 "AI 归类" 按钮扫描出建议后，弹此面板让用户人工确认是否执行移动。
 * 设计要点：
 *   - 只读展示「笔记标题 → 目标笔记本（置信度）」；原笔记本也标出，方便对照；
 *   - 每行一个 checkbox，默认全部勾选；支持一键全选/取消；
 *   - 点"确认移动"才真的调接口，点"取消"丢弃整个计划；
 *   - plan=null 时不渲染，避免空弹窗。
 */
function AiClassifyConfirmModal({
  plan,
  onCancel,
  onToggle,
  onToggleAll,
  onConfirm,
}: {
  plan: Array<{
    noteId: string;
    noteTitle: string;
    fromNotebookName: string;
    toNotebookName: string;
    toPath?: string;
    confidence: number;
    checked: boolean;
  }> | null;
  onCancel: () => void;
  onToggle: (noteId: string) => void;
  onToggleAll: (checked: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!plan) return null;
  const checkedCount = plan.filter((p) => p.checked).length;
  const allChecked = checkedCount === plan.length;
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.15 }}
        className="w-full max-w-lg max-h-[80vh] flex flex-col bg-app-surface rounded-xl shadow-2xl border border-app-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-4 py-3 border-b border-app-border flex items-center gap-2">
          <Sparkles size={16} className="text-violet-500" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-tx-primary">
              {t('noteList.bulkAiClassifyConfirmTitle') || "AI 归类建议确认"}
            </div>
            <div className="text-[11px] text-tx-tertiary mt-0.5">
              {t('noteList.bulkAiClassifyConfirmSubtitle', { count: plan.length })
                || `共 ${plan.length} 条建议，取消勾选即可跳过，点击确认后才会移动`}
            </div>
          </div>
          <button
            className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary"
            onClick={onCancel}
            aria-label="close"
          >
            <X size={16} />
          </button>
        </div>

        {/* 全选行 */}
        <div className="px-4 py-2 border-b border-app-border flex items-center gap-2 bg-app-subtle/50">
          <input
            type="checkbox"
            checked={allChecked}
            // indeterminate 只能通过 ref 设置；这里简化不做三态视觉，功能上 toggleAll 够用
            onChange={(e) => onToggleAll(e.target.checked)}
            className="cursor-pointer"
          />
          <span className="text-xs text-tx-secondary">
            {allChecked
              ? (t('noteList.bulkAiClassifyUnselectAll') || "取消全选")
              : (t('noteList.bulkAiClassifySelectAll') || "全选")}
          </span>
          <span className="ml-auto text-[11px] text-tx-tertiary tabular-nums">
            {checkedCount}/{plan.length}
          </span>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-auto">
          {plan.map((item) => (
            <label
              key={item.noteId}
              className="flex items-start gap-2 px-4 py-2.5 border-b border-app-border/50 hover:bg-app-hover cursor-pointer"
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => onToggle(item.noteId)}
                className="mt-0.5 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-tx-primary truncate">
                  {item.noteTitle}
                </div>
                <div className="text-[11px] text-tx-tertiary mt-0.5 flex items-center gap-1 flex-wrap">
                  <span className="truncate max-w-[40%]">{item.fromNotebookName}</span>
                  <ChevronRight size={10} className="shrink-0 text-tx-tertiary/70" />
                  <span className="text-violet-600 dark:text-violet-400 truncate max-w-[45%]" title={item.toPath || item.toNotebookName}>
                    {item.toPath || item.toNotebookName}
                  </span>
                  <span className="ml-auto tabular-nums text-tx-tertiary">
                    {(item.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* 底部操作栏 */}
        <div className="px-4 py-3 border-t border-app-border flex items-center gap-2 justify-end">
          <button
            className="px-3 py-1.5 text-xs rounded-md text-tx-secondary hover:bg-app-hover"
            onClick={onCancel}
          >
            {t('common.cancel') || "取消"}
          </button>
          <button
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            onClick={onConfirm}
            disabled={checkedCount === 0}
          >
            {t('noteList.bulkAiClassifyConfirmMove', { count: checkedCount })
              || `确认移动 (${checkedCount})`}
          </button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

/* ===== 新建笔记时选择笔记本 ===== */
function NotebookPickerModal({
  isOpen, notebooks, onPick, onClose,
}: {
  isOpen: boolean; notebooks: Notebook[];
  onPick: (notebookId: string) => void; onClose: () => void;
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
      <div className="relative w-full max-w-[360px] mx-4 max-h-[80vh] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2 min-w-0">
            <Folder size={16} className="text-accent-primary shrink-0" />
            <span className="text-sm font-medium text-tx-primary truncate">{t('common.selectNotebook')}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-tx-tertiary border-b border-app-border">
          {t('common.selectNotebookHint')}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="p-2">
            {tree.map((nb) => (
              <NotebookTreeItem
                key={nb.id}
                notebook={nb}
                depth={0}
                selectedId={selectedId}
                currentNotebookId=""
                onSelect={setSelectedId}
              />
            ))}
            {tree.length === 0 && (
              <p className="text-xs text-tx-tertiary text-center py-4">{t('noteList.noNotebooks')}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="sm"
            disabled={!selectedId}
            onClick={() => selectedId && onPick(selectedId)}
            className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
          >
            {t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ===== 迷你日历筛选器 =====
 * dateCounts：每个日期（YYYY-MM-DD）对应当天的笔记数量。
 *   - 由父组件根据**不含 dateFilter** 的笔记列表聚合传入，这样切日期筛选
 *     不会把日历徽章也过滤到只剩当天；
 *   - 未传或某日期无命中则不显示徽章，避免 0 挤占格子。
 */
function MiniCalendarFilter({
  selectedDate,
  onSelect,
  onClear,
  dateCounts,
}: {
  selectedDate: string | null; // YYYY-MM-DD
  onSelect: (date: string) => void;
  onClear: () => void;
  dateCounts?: Record<string, number>;
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
          // 当日笔记数量（仅在 current 月内显示徽章；非当月格子保持简洁）
          const count = current ? (dateCounts?.[dateStr] || 0) : 0;
          return (
            <button
              key={idx}
              onClick={() => {
                if (isSelected) onClear();
                else onSelect(dateStr);
              }}
              className={cn(
                // 高度从 h-7 增到 h-9，给底部数量徽章留位置
                "h-9 text-[11px] rounded-md transition-all flex flex-col items-center justify-center gap-0.5",
                !current && "text-tx-tertiary/40",
                current && !isSelected && !isToday && "text-tx-secondary hover:bg-app-hover",
                isToday && !isSelected && "text-accent-primary font-bold",
                isSelected && "bg-accent-primary text-white font-medium shadow-sm"
              )}
            >
              <span className="leading-none">{day}</span>
              {/* 数量徽章：
                  - 仅当当月、count>0 时显示；
                  - 未选中：用 accent 主色（半透明）小圆点风格数字；
                  - 选中：白底蓝字反转，避免在蓝色高亮上看不清。 */}
              {count > 0 && (
                <span
                  className={cn(
                    "text-[8px] leading-none px-1 min-w-[12px] h-3 rounded-full inline-flex items-center justify-center tabular-nums font-medium",
                    isSelected
                      ? "bg-white/90 text-accent-primary"
                      : "bg-accent-primary/15 text-accent-primary"
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
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
        className="flex-1 flex flex-col min-h-0 transition-transform"
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


// 这里刻意不用 React.forwardRef：framer-motion v12 的 <AnimatePresence> 内部
// PopChild 会通过 `child.ref` 读取子元素 ref 转交给自己的 wrapper，而 React 18.3
// 起把 `ref` 视为非普通 prop，访问会触发
//   `Warning: ref is not a prop. Trying to access it will result in undefined`。
// 解决方案：把 ref 改成普通 prop（cardRef），由组件内部直接挂到 motion.div 上，
// PopChild 检测到 child 没有 ref 属性时就跳过转发路径，警告也就消失了。
const NoteCard = React.memo(function NoteCard({
  note, isActive, onClick, onContextMenu, isContextTarget, isShared, isSelected,
  draggable, onDragStart, onDragOver, onDragEnd, onDrop, isDragOver,
  onTouchStart, onTouchMove, onTouchEnd, cardRef, searchQuery,
  showNoteTime,
}: {
  note: NoteListItem; isActive: boolean; onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isContextTarget: boolean;
  isShared?: boolean;
  isSelected?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragOver?: boolean;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: () => void;
  cardRef?: (el: HTMLDivElement | null) => void;
  searchQuery?: string;
  showNoteTime?: boolean;
}) {
  // 预览文本：普通列表取正文前 100 字；搜索结果使用后端 snippet，不能再截断。
  // 压成单个空格。否则 markdown 多段落正文里的换行会被 <p> 当作空白渲染，
  // 配合 line-clamp-2 + break-words 出现"每句被切到独立一行"的错觉
  // （短标题时不明显，因为预览整体行数少；长标题挤占空间后尤为严重）。
  const isSearchResult = !!searchQuery;
  const preview = (
    isSearchResult
      ? (note.snippetHtml || note.contentText || "")
      : (note.contentText?.slice(0, 100) || "")
  ).replace(/\s+/g, " ").trim();
  const { t } = useTranslation();
  const wordCount = note.contentText?.length || 0;
  // 工作区视图下笔记可能由不同成员创建，需要在卡片底部展示创建者；
  // 个人空间下创建者一定是当前用户，留白即可。creatorName 由后端 list 接口
  // LEFT JOIN users 注入，老后端无该字段时退化为不展示。
  const showCreator =
    !!note.creatorName && getCurrentWorkspace() !== "personal";

  return (
    <motion.div
      ref={cardRef}
      // 仅做轻量淡入。早期版本用了 y:4 → y:0 的位移，会造成切换笔记本时
      // 整列卡片"先在面板底部出现再上移"的错觉（尤其当 list 项很少、
      // 列表内容贴近底部时尤为明显）。这里去掉 y 位移，让卡片就地淡入。
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      // framer-motion 的 motion.div 把 onDragStart/onDragEnd 覆写成 (event, PanInfo) => void，
      // 与 HTML 原生 DragEvent 签名冲突。我们在这里确实需要 HTML 的 DragEvent（下游会读
      // dataTransfer），所以用 any 断言绕过类型检查，运行时 React 仍按 HTML 事件派发。
      onDragStart={onDragStart as any}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd as any}
      onDrop={onDrop}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className={cn(
        "relative rounded-lg cursor-pointer border transition-all group overflow-hidden",
        isSelected
          ? "bg-accent-primary/10 border-accent-primary/40 shadow-sm"
          : isActive
          ? "bg-app-active border-accent-primary/30 shadow-sm"
          : isContextTarget
          ? "bg-app-hover border-accent-primary/20"
          : "bg-transparent border-transparent hover:bg-app-hover",
        isDragOver && "border-accent-primary/50 bg-accent-primary/5"
      )}
    >
      {/* 左侧彩色指示条 */}
      <div className={cn(
        "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg transition-colors",
        isSelected
          ? "bg-accent-primary"
          : isActive
          ? "bg-accent-primary"
          : note.isFavorite === 1
          ? "bg-amber-400"
          : note.isPinned === 1
          ? "bg-accent-primary/50"
          : "bg-transparent group-hover:bg-app-border"
      )} />

      <div className="pl-3.5 pr-3 py-2.5 min-w-0">
        {/* 标题行 + 状态图标 */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          {draggable && (
            <GripVertical size={14} className="text-tx-tertiary opacity-0 group-hover:opacity-60 transition-opacity shrink-0 cursor-grab active:cursor-grabbing" />
          )}
          <h3 className={cn(
            // 标题强制单行：这里**故意**不用 `truncate`（white-space: nowrap）。
            // 历史踩坑：`truncate` 在 flex item 里偶发被外层富文本/prose 全局样式覆盖
            // （某些主题会把 h3 的 white-space 重置为 normal），导致超长英文+空格的标题
            // 仍然在空格处折行变成 2 行，把后面的 line-clamp-2 预览挤成只剩 1 行。
            // 改用 line-clamp-1：基于 -webkit-box 实现，不依赖 nowrap，对 flex 容器
            // 和 CJK/英文/空格混排都稳定，并自带省略号。
            // break-all：兜底——遇到极长不可断词（连续超长英文/无空格 URL）也强制裁断，
            // 不让一行的"内容宽度"超过容器，导致 flex 容器再被撑变形。
            "note-card-title text-sm font-medium line-clamp-1 break-all flex-1 min-w-0",
            isActive ? "text-tx-primary" : "text-tx-secondary group-hover:text-tx-primary"
          )}>
            {searchQuery && note.titleHtml ? (
              <span dangerouslySetInnerHTML={{ __html: sanitizeSearchHtml(note.titleHtml) }} />
            ) : searchQuery ? (
              <span>{highlightTextNode(note.title || t('common.untitledNote'), searchQuery)}</span>
            ) : (
              note.title || t('common.untitledNote')
            )}
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            {note.contentFormat === "markdown" ? (
              <span className="text-[10px] px-1 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 leading-none" title={t('note.format.markdown')}>
                {t('note.format.markdownShort')}
              </span>
            ) : (
              <span className="text-[10px] px-1 py-0.5 rounded border border-app-border bg-app-hover text-tx-tertiary leading-none" title={t('note.format.richText')}>
                {t('note.format.richTextShort')}
              </span>
            )}
            {isShared && <Share2 size={11} className="text-emerald-500" />}
            {note.isLocked === 1 && <Lock size={11} className="text-orange-500" />}
            {note.isPinned === 1 && <Pin size={11} className="text-accent-primary" />}
            {note.isFavorite === 1 && <Star size={11} className="text-amber-400 fill-amber-400" />}
          </div>
        </div>

        {/* 内容预览
            折行策略：
            - 用 break-words 而非 break-all：CJK 默认就能在任意字符间折行，
              break-all 会让英文也按字符硬切，反而更难读；break-words 只在
              "整行装不下的长不可断词"时才强制打破，对中英混排最友好。
            - overflow-wrap-anywhere 避免极长 URL 撑破容器。 */}
        {preview && (
          searchQuery ? (
            <div className="mt-1.5">
              {/* 命中字段提示 */}
              {note.matchedField && note.matchedField !== "title+content" && (
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-primary/10 text-accent-primary">
                    {note.matchedField === "title" ? t('noteList.matchedTitle') : t('noteList.matchedContent')}
                  </span>
                </div>
              )}
              <p className="note-card-preview text-xs text-tx-tertiary line-clamp-2 leading-relaxed break-words [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: sanitizeSearchHtml(preview) }} />
            </div>
          ) : (
            <p className="text-xs text-tx-tertiary mt-1.5 line-clamp-2 leading-relaxed break-words [overflow-wrap:anywhere]">{preview}</p>
          )
        )}

        {/* 底部元信息行
            - 左侧：更新时间（始终显示）
            - 右侧：工作区下显示创建者（最高优先级），否则 hover 时显示字数
            两者互斥渲染——卡片宽度有限，避免徽标挤压标题/预览。 */}
        <div className="flex items-center justify-between mt-2 text-tx-tertiary gap-2">
          {showNoteTime && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Clock size={10} />
              <span className="text-[10px]">{formatTime(note.updatedAt, t)}</span>
            </div>
          )}
          {showCreator ? (
            <span
              className="flex items-center gap-1 text-[10px] text-tx-secondary/80 truncate max-w-[40%]"
              title={t('common.createdBy', { name: note.creatorName })}
            >
              <UserIcon size={10} className="shrink-0" />
              <span className="truncate">{note.creatorName}</span>
            </span>
          ) : wordCount > 0 ? (
            <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
              {wordCount > 999 ? `${(wordCount / 1000).toFixed(1)}k` : wordCount} {t('common.chars') || '字'}
            </span>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
});
NoteCard.displayName = "NoteCard";

/* ===== 虚拟滚动笔记列表 ===== */
const ITEM_HEIGHT = 90; // 每个笔记卡片的估算高度（px）
const OVERSCAN = 8; // 上下额外渲染的条目数

function VirtualNoteList({
  notes,
  activeNoteId,
  menuState,
  sharedNoteIds,
  selectedIds,
  onSelectNote,
  onContextMenu,
  canDragSort,
  dragOverNoteId,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  noteCardRefs,
  searchQuery,
  showNoteTime,
}: {
  notes: NoteListItem[];
  activeNoteId: string | undefined;
  menuState: { isOpen: boolean; targetId: string | null };
  sharedNoteIds: Set<string>;
  selectedIds: Set<string>;
  onSelectNote: (noteId: string, e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, noteId: string) => void;
  canDragSort?: boolean;
  dragOverNoteId?: string | null;
  onDragStart?: (e: React.DragEvent, noteId: string) => void;
  onDragOver?: (e: React.DragEvent, noteId: string) => void;
  onDragEnd?: () => void;
  onDrop?: (e: React.DragEvent, noteId: string) => void;
  onTouchStart?: (noteId: string, e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: () => void;
  noteCardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>;
  searchQuery?: string;
  showNoteTime?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // 切换笔记本/搜索条件/筛选/排序时，notes 引用会整体替换。此时若不复位
  // scrollTop，浏览器会把"上一组列表"的滚动位置原样保留下来，新列表只显示
  // 中下部分，配合 framer-motion 的进入动画，肉眼看上去就像"列表先从面板
  // 底部冒出来再爬到顶部"。这里强制把视口拉回顶部，并清零内部 scrollTop
  // 状态，保证新列表立即从首条开始呈现。
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    setScrollTop(0);
  }, [notes]);

  // 监听容器尺寸变化
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(container);
    setContainerHeight(container.clientHeight);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const totalHeight = notes.length * ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(notes.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN);
  const visibleNotes = notes.slice(startIndex, endIndex);
  const offsetY = startIndex * ITEM_HEIGHT;

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-auto"
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div className="px-2 space-y-1" style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}>
          {visibleNotes.map((note) => (
            <NoteCard
              key={note.id}
              cardRef={(el) => {
                if (el) noteCardRefs?.current.set(note.id, el);
                else noteCardRefs?.current.delete(note.id);
              }}
              note={note}
              isActive={activeNoteId === note.id}
              isContextTarget={menuState.isOpen && menuState.targetId === note.id}
              isShared={sharedNoteIds.has(note.id)}
              isSelected={selectedIds.has(note.id)}
              onClick={(e) => onSelectNote(note.id, e)}
              onContextMenu={(e) => onContextMenu(e, note.id)}
              draggable={canDragSort}
              onDragStart={(e) => onDragStart?.(e, note.id)}
              onDragOver={(e) => onDragOver?.(e, note.id)}
              onDragEnd={() => onDragEnd?.()}
              onDrop={(e) => onDrop?.(e, note.id)}
              isDragOver={dragOverNoteId === note.id}
              onTouchStart={(e) => onTouchStart?.(note.id, e)}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              searchQuery={searchQuery}
              showNoteTime={showNoteTime}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function NoteList() {
  const { state } = useApp();
  const actions = useAppActions();
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();
  // moveModal 新增 sourceWorkspaceId：源笔记所在工作区（null = 个人空间）。
  // 后端已强制"源/目标同 workspace"，这里把 UI 候选也按同一规则过滤，避免让用户
  // 选到必然会被 400 拒绝的跨空间笔记本。
  const [moveModal, setMoveModal] = useState<{
    noteIds: string[];
    noteTitle: string;
    notebookId: string;
    sourceWorkspaceId: string | null;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 新建按钮的下拉菜单（普通笔记 / Word 文档）。
  // 默认行为是单击 + 按钮直接走 normal；下拉箭头点开后才能选 word。
  // 三个 + 按钮各自一个 ref（桌面顶部 / 移动顶部 / 移动 FAB）；
  // openSource 记录是哪一个触发了下拉，避免共用一个 ref 导致的菜单错位。
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createMenuSource, setCreateMenuSource] = useState<"desktop" | "mobile" | "fab" | null>(null);
  const createMenuAnchorDesktopRef = useRef<HTMLButtonElement>(null);
  const createMenuAnchorMobileRef = useRef<HTMLButtonElement>(null);
  const createMenuAnchorFabRef = useRef<HTMLButtonElement>(null);
  // picker 模式下记住即将创建的笔记类型；用户选 notebook 后据此分支。
  const [pendingNoteType, setPendingNoteType] = useState<"normal" | "markdown" | "word">("normal");
  const [dateFilter, setDateFilter] = useState<string | null>(null); // YYYY-MM-DD
  const [showCalendar, setShowCalendar] = useState(false);
  const notesFetchSeqRef = useRef(0);
  const notesQueryKeyRef = useRef("");
  // 排序偏好（持久化到 localStorage，不入 store；用户在不同设备/浏览器下可独立设置）
  const [sortPref, setSortPref] = useState<{ by: SortBy; dir: SortDir }>(() => loadSortPref());
  const userPrefs = useUserPreferences();
  const showNoteTime = userPrefs.prefs.showNoteListUpdatedTime;
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const [sharedNoteIds, setSharedNoteIds] = useState<Set<string>>(new Set());
  const [dragNoteId, setDragNoteId] = useState<string | null>(null);
  const [dragOverNoteId, setDragOverNoteId] = useState<string | null>(null);
  // 外部文件拖拽状态：用于渲染列表上的拖拽接收 overlay。
  // 与内部排序拖拽（dragNoteId / dragOverNoteId）互斥，允许同时存在但不同时激活。
  const [isFileDragging, setIsFileDragging] = useState(false);
  // dragenter / dragleave 在子元素边界会重复触发。计数器（1 入 / -1 出）才能准确
  // 给出“是否还在区域内”。不走 React state 是为了避免拖拽期间频繁重渲染。
  const fileDragDepthRef = useRef(0);
  // 多选：Ctrl/Cmd+Click 切换、Shift+Click 范围；为空即未进入多选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  // P4：批量 AI 操作运行时状态
  //   kind     当前正在跑的批量动作；非 null 时禁用按钮防止并发启动
  //   progress 已完成数 / 总数，用于底部工具栏显示 "AI 处理中 3/10"
  const [bulkAiRunning, setBulkAiRunning] = useState<{
    kind: "tags" | "classify";
    done: number;
    total: number;
  } | null>(null);
  // 移动端触摸拖拽状态
  const touchDragRef = useRef<{
    noteId: string;
    startY: number;
    startX: number;
    currentY: number;
    isDragging: boolean;
    ghostEl: HTMLDivElement | null;
  } | null>(null);
  const noteCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // 非虚拟列表分支用 Radix ScrollArea 包裹，需要在切换筛选条件时把内部 viewport
  // 滚动复位。Radix 的 ScrollArea forwardRef 暴露的是 Root 节点，真正的滚动容器
  // 是它内部带 data-radix-scroll-area-viewport 的子节点。
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  // 给 WebSocket 列表更新监听使用，避免每次 state.notes 变化都重订阅事件。
  const notesRef = useRef<NoteListItem[]>([]);
  useEffect(() => { notesRef.current = state.notes; }, [state.notes]);
  const { t } = useTranslation();

  // Phase 2: 加载分享状态
  useEffect(() => {
    api.getSharedNoteIds().then((ids) => setSharedNoteIds(new Set(ids))).catch(() => {});
  }, [state.notes]);

  const notesQueryKey = useMemo(() => JSON.stringify({
    viewMode: state.viewMode,
    selectedNotebookId: state.selectedNotebookId,
    selectedTagId: state.selectedTagId,
    searchQuery: state.searchQuery,
    dateFilter,
    sortBy: sortPref.by,
    sortDir: sortPref.dir,
  }), [
    state.viewMode,
    state.selectedNotebookId,
    state.selectedTagId,
    state.searchQuery,
    dateFilter,
    sortPref.by,
    sortPref.dir,
  ]);

  const fetchNotes = useCallback(async () => {
    const requestSeq = ++notesFetchSeqRef.current;
    const queryChanged = notesQueryKeyRef.current !== notesQueryKey;
    notesQueryKeyRef.current = notesQueryKey;
    actions.setLoading(true);
    if (queryChanged) actions.setNotes([]);
    let notes: NoteListItem[] = [];
    try {
      // 通用排序参数：除"搜索"外的视图都附加。
      // - 搜索：后端走 FTS rowid IN(...)，排序由命中相关性决定，强行覆盖会破坏体验。
      const sortParams: Record<string, string> = {
        sortBy: sortPref.by,
        sortOrder: sortPref.dir,
      };
      if (state.viewMode === "notebook" && state.selectedNotebookId) {
        const params: Record<string, string> = { notebookId: state.selectedNotebookId, ...sortParams };
        if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
        notes = await api.getNotes(params);
      } else if (state.viewMode === "favorites") {
        const params: Record<string, string> = { isFavorite: "1", ...sortParams };
        if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
        notes = await api.getNotes(params);
      } else if (state.viewMode === "trash") {
        const params: Record<string, string> = { isTrashed: "1", ...sortParams };
        if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
        notes = await api.getNotes(params);
      } else if (state.viewMode === "search" && state.searchQuery) {
        const results = await api.search(state.searchQuery);
        notes = results.map((r) => ({
          id: r.id,
          userId: r.userId || "",
          notebookId: r.notebookId,
          workspaceId: r.workspaceId ?? null,
          title: r.title,
          contentText: stripSearchMarks(r.snippetHtml || r.snippet),
          titleHtml: r.titleHtml,
          snippetHtml: r.snippetHtml || r.snippet,
          isPinned: r.isPinned,
          isFavorite: r.isFavorite,
          isArchived: 0,
          isTrashed: 0,
          isLocked: 0,
          version: 0,
          createdAt: r.updatedAt,
          updatedAt: r.updatedAt,
          matchedField: r.matchedField,
        }));
      } else if (state.viewMode === "tag" && state.selectedTagId) {
        const params: Record<string, string> = { ...sortParams };
        if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
        notes = await api.getNotesWithTag(state.selectedTagId, params);
      } else {
        const params: Record<string, string> = { ...sortParams };
        if (dateFilter) { params.dateFrom = dateFilter; params.dateTo = dateFilter; }
        notes = await api.getNotes(params);
      }
      if (requestSeq !== notesFetchSeqRef.current) return;
      actions.setNotes(notes);
    } finally {
      if (requestSeq === notesFetchSeqRef.current) {
        actions.setLoading(false);
      }
    }
  }, [actions, notesQueryKey, state.viewMode, state.selectedNotebookId, state.searchQuery, state.selectedTagId, dateFilter, sortPref.by, sortPref.dir]);

  useEffect(() => {
    fetchNotes().catch(console.error);
    // 追加依赖：notesRefreshToken 递增时强制刷新当前视图
  }, [fetchNotes, state.notesRefreshToken]);

  // ─── 日历徽章数据源 ──────────────────────────────────────────────
  // 单独维护一份**不带 dateFilter** 的笔记列表用于日历每日数量徽章。
  // 不复用 state.notes 的原因：当用户已经选了某一天，state.notes 只剩当天，
  // 日历就只会在那一天显示数字，其他日期看起来全是 0 —— 体验崩坏。
  //
  // 拉取策略：
  //   - 仅在日历面板**首次打开**或视图维度（viewMode/notebook/tag/sortPref/
  //     refreshToken）变化时拉取；
  //   - dateFilter 切换不触发，避免与 fetchNotes 同步重复请求；
  //   - trash/search 视图不显示日历，无需拉取。
  const [calendarNotes, setCalendarNotes] = useState<NoteListItem[]>([]);
  useEffect(() => {
    if (!showCalendar) return;
    if (state.viewMode === "trash" || state.viewMode === "search") return;
    let cancelled = false;
    const sortParams: Record<string, string> = { sortBy: sortPref.by, sortOrder: sortPref.dir };
    const fetcher = async (): Promise<NoteListItem[]> => {
      if (state.viewMode === "notebook" && state.selectedNotebookId) {
        return api.getNotes({ notebookId: state.selectedNotebookId, ...sortParams });
      }
      if (state.viewMode === "favorites") {
        return api.getNotes({ isFavorite: "1", ...sortParams });
      }
      if (state.viewMode === "tag" && state.selectedTagId) {
        return api.getNotesWithTag(state.selectedTagId, sortParams);
      }
      // 默认 / "所有笔记"
      return api.getNotes(sortParams);
    };
    fetcher()
      .then((notes) => { if (!cancelled) setCalendarNotes(notes); })
      .catch((err) => { console.error("[calendar] fetch failed:", err); });
    return () => { cancelled = true; };
  }, [
    showCalendar,
    state.viewMode,
    state.selectedNotebookId,
    state.selectedTagId,
    sortPref.by,
    sortPref.dir,
    state.notesRefreshToken,
  ]);

  // 按本地日期聚合每日笔记数：YYYY-MM-DD → count。
  // 取 updatedAt 与后端日期筛选保持一致（后端用 notes.updatedAt 比较 dateFrom/dateTo）。
  const dateCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const n of calendarNotes) {
      // updatedAt 形如 "2026-05-12 14:30:00" 或 ISO；统一按本地时区切到 YYYY-MM-DD
      const raw = n.updatedAt;
      if (!raw) continue;
      // 直接取前 10 字符（YYYY-MM-DD）即可：后端存的就是本地时间字符串，
      // 与 todayStr 的 getFullYear/getMonth/getDate 同基准。
      const key = String(raw).slice(0, 10);
      if (key.length !== 10) continue;
      map[key] = (map[key] || 0) + 1;
    }
    return map;
  }, [calendarNotes]);


  // ─── 本地排序：确保 updateNoteInList 后列表立即按选定顺序排列 ───────
  // 后端返回的列表已排序，但保存后 EditorPane 只做了 updateNoteInList（原地更新
  // 字段）不重新拉列表，导致被编辑笔记的 updatedAt 更新了却没挪位置——看起来排序没生效。
  // 这里用 useMemo 派生一份 sortedNotes，每次 state.notes 变化都重算顺序。
  const sortedNotes = useMemo(() => {
    // 搜索视图由 FTS 相关性排序、manual 模式由后端 sortOrder 字段决定——前端无法重排
    if (state.viewMode === "search" || sortPref.by === "manual") {
      return state.notes;
    }
    const dir = sortPref.dir === "asc" ? 1 : -1;
    return [...state.notes].sort((a, b) => {
      // 置顶永远最前
      if (a.isPinned !== b.isPinned) return b.isPinned - a.isPinned;
      if (sortPref.by === "title") {
        const cmp = (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
        return cmp * dir || a.id.localeCompare(b.id);
      }
      // updatedAt / createdAt
      const field = sortPref.by as "updatedAt" | "createdAt";
      const ta = a[field] || "";
      const tb = b[field] || "";
      const cmp = ta < tb ? -1 : ta > tb ? 1 : 0;
      return cmp * dir || a.id.localeCompare(b.id);
    });
  }, [state.notes, sortPref.by, sortPref.dir, state.viewMode]);

  // 监听 WebSocket：外部导入 / 同账号其它设备保存后自动刷新列表
  useEffect(() => {
    realtime.connect();
    const offImported = realtime.on("notes:imported", () => {
      actions.refreshNotes();
      actions.refreshNotebooks();
    });
    const offListUpdated = realtime.on("note:list-updated", (msg: any) => {
      const note = msg?.note;
      if (!note?.id) return;
      const exists = notesRef.current.some((n) => n.id === note.id);
      if (exists) {
        actions.updateNoteInList({
          id: note.id,
          title: note.title,
          contentText: note.contentText,
          updatedAt: note.updatedAt,
          version: note.version,
          isPinned: note.isPinned,
          isTrashed: note.isTrashed,
          notebookId: note.notebookId,
          workspaceId: note.workspaceId,
        } as any);
      } else {
        // 当前筛选下原本没有这条笔记；可能是移动/恢复/新建，低频场景全量刷新更稳。
        actions.refreshNotes();
      }
    });
    // 全局监听笔记删除/回收站事件（SYNC-DELETE-01-B）
    // 服务端通过 broadcastToUser 推送，列表页也能收到
    const offNoteDeleted = realtime.on("note:deleted", (msg: any) => {
      const noteId = msg?.noteId || msg?.id;
      if (!noteId) return;
      // 排除自己触发的回声
      const myConnectionId = realtime.getConnectionId();
      if (myConnectionId && msg.actorConnectionId === myConnectionId) return;
      console.log("[NoteList] note:deleted received", { noteId, trashed: msg.trashed, myConnectionId });
      // 立即从列表移除
      actions.removeNoteFromList(noteId);
      if (msg.trashed === true) {
        // 移入回收站：同步更新 IndexedDB 中的 isTrashed 字段，
        // 防止关闭/重启后旧缓存把笔记"复活"到普通列表
        void getLocalNote(noteId).then((existing) => {
          if (existing) {
            void putLocalNote({ ...existing, isTrashed: 1, trashedAt: new Date().toISOString() }).catch(() => {});
          }
        }).catch(() => {});
      } else {
        // 永久删除：直接从 IndexedDB 移除
        void deleteLocalNote(noteId).catch(() => {});
      }
      // 异步 syncNow 兜底：确保 IndexedDB 中的 isTrashed / 删除状态与服务端一致
      void syncNow().catch(() => {});
    });

    return () => {
      offImported();
      offListUpdated();
      offNoteDeleted();
    };
  }, [actions]);

  // viewMode 切换时自动收起日历并清除筛选
  useEffect(() => {
    setDateFilter(null);
    setShowCalendar(false);
  }, [state.viewMode]);

  // 切 viewMode / notebook / 搜索 / 日期 时清空多选
  useEffect(() => {
    setSelectedIds(new Set());
    setLastClickedId(null);
  }, [state.viewMode, state.selectedNotebookId, state.searchQuery, state.selectedTagId, dateFilter]);

  // 切换笔记本/视图/搜索/标签/日期/排序 时把非虚拟列表的 ScrollArea 滚动复位到顶。
  // 否则 Radix ScrollArea 会保留前一组列表的 scrollTop，新列表立刻渲染时整组卡片
  // 视觉上"贴在面板下方再爬上来"，配合卡片自身的淡入动画体感很差。
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (viewport) viewport.scrollTop = 0;
  }, [
    state.viewMode,
    state.selectedNotebookId,
    state.searchQuery,
    state.selectedTagId,
    dateFilter,
    sortPref.by,
    sortPref.dir,
  ]);

  // 全局 ESC 清空多选（多选状态下）
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedIds(new Set());
        setLastClickedId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIds.size]);

  // 防止快速点击导致多个并发 getNote 请求
  const selectNoteAbortRef = useRef<AbortController | null>(null);

  const handleSelectNote = async (noteId: string, e?: React.MouseEvent) => {
    const isCtrl = !!e && (e.ctrlKey || e.metaKey);
    const isShift = !!e && e.shiftKey;

    // Ctrl/Cmd 点击：切换此项在多选集合中的状态，不打开笔记
    if (isCtrl) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(noteId)) next.delete(noteId);
        else next.add(noteId);
        return next;
      });
      setLastClickedId(noteId);
      return;
    }

    // Shift 点击：以 lastClickedId → noteId 的可见范围全部选中
    if (isShift && lastClickedId && lastClickedId !== noteId) {
      const ids = sortedNotes.map((n) => n.id);
      const a = ids.indexOf(lastClickedId);
      const b = ids.indexOf(noteId);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
          return next;
        });
        setLastClickedId(noteId);
        return;
      }
    }

    // 普通点击：如果当前在多选状态，仅清空多选而不打开笔记（避免误触打开被选的 50 条之一）
    if (selectedIds.size > 0) {
      setSelectedIds(new Set());
      setLastClickedId(noteId);
      // 若用户点击的是已选中的唯一一项以外的项目，继续打开
      // 这里选择"先退出多选、再正常打开"：更直观
    }

    // 如果点击的是当前已激活的笔记，跳过重复加载
    if (state.activeNote?.id === noteId) {
      actions.setMobileView("editor");
      return;
    }

    haptic.selection();
    setLastClickedId(noteId);
    try { window.dispatchEvent(new CustomEvent("nowen:before-note-switch")); } catch { /* ignore */ }

    // 取消之前正在进行的 getNote 请求（快速连续点击时只加载最后一个）
    if (selectNoteAbortRef.current) {
      selectNoteAbortRef.current.abort();
    }
    const abortCtrl = new AbortController();
    selectNoteAbortRef.current = abortCtrl;

    // 立即设置 loading 状态，给 EditorPane 显示骨架屏
    actions.setNoteLoading(true);
    // 关键修复（移动端"点笔记没反应"）：
    //   把 setMobileView("editor") 提前到 fetch 之前，确保用户点击瞬间就切到
    //   编辑器视图，由 EditorPane 的 noteLoading overlay 显示加载中。
    //   原实现把它放在 setActiveNote 之后，导致：
    //     1) 弱网 / 后端慢响应时，用户点了 1~2 秒"还在列表页"，以为没点到；
    //     2) 若 fetch 抛错或被 abort，setMobileView 永远不执行，
    //        用户体感就是"切到笔记本列表后点击不进去编辑器"。
    //   提前切换视图后即便 fetch 失败，用户也能立刻看到反馈并按返回键回到列表，
    //   不会被卡在"点了没反应"的死路上。
    actions.setMobileView("editor");

    try {
      const note = await api.getNote(noteId);
      // 如果该请求已被新的点击 abort，则忽略结果
      if (abortCtrl.signal.aborted) return;
      actions.setActiveNote(note);
    } catch (err: any) {
      // 被 abort 的请求不需要处理错误
      if (abortCtrl.signal.aborted || err?.name === "AbortError") return;
      console.error("Failed to load note:", err);
      // 加载失败：清掉空 activeNote 占位（如有），并提示用户。
      // 移动端不强制回退到 list —— 让用户自己点返回，避免视图反复跳动。
      try {
        const { toast } = await import("@/lib/toast");
        toast.error(err?.message || t('noteList.createFailed'));
      } catch { /* toast 加载失败时忽略 */ }
    } finally {
      if (!abortCtrl.signal.aborted) {
        actions.setNoteLoading(false);
      }
    }
  };

  // 一键清空回收站：查询可删除数量 → confirm 确认 → 调用 api.emptyTrash → 刷新列表。
  // 移动端 Sidebar 未挂载，自定义事件无人监听，因此 NoteList 直接实现完整逻辑。
  const handleEmptyTrash = async () => {
    haptic.medium();
    try {
      const notes = await api.getNotes({ isTrashed: "1" });
      const removable = (notes as any[]).filter((n: any) => !n.isLocked).length;
      if (removable === 0) {
        toast.info(t('sidebar.emptyTrashEmpty'));
        return;
      }
      const ok = await confirm({
        title: t('sidebar.emptyTrashConfirmTitle'),
        description: t('sidebar.emptyTrashConfirm', { count: removable }),
        confirmText: t('sidebar.emptyTrash'),
        danger: true,
      });
      if (!ok) return;
      haptic.heavy();
      const res = await api.emptyTrash();
      if (res.skipped && res.skipped > 0) {
        toast.warning(t('sidebar.emptyTrashSkipped', { count: res.count, skipped: res.skipped }));
      } else {
        toast.success(t('sidebar.emptyTrashSuccess', { count: res.count }));
      }
      if (!res.vacuumed && (res.freedBytesEstimate || 0) >= 10 * 1024 * 1024) {
        toast.info(
          "占用较大但数据库未自动压缩。可在「数据管理」里点击「压缩数据库」进一步回收磁盘空间。",
        );
      }
      try {
        window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "trash-emptied" } }));
      } catch { /* ignore */ }
      actions.setNotes([]);
      if (state.activeNote?.isTrashed) {
        actions.setActiveNote(null);
      }
      actions.refreshNotebooks();
    } catch (err: any) {
      console.error("清空回收站失败", err);
      toast.error(err?.message || t('sidebar.emptyTrashFailed'));
    }
  };

  const handleCreateNote = async (noteType: "normal" | "markdown" | "word" = "normal") => {
    haptic.light();
    // 回收站视图禁止新建笔记
    if (state.viewMode === "trash") {
      toast.info(t('noteList.cannotCreateInTrash'));
      return;
    }
    // 无笔记本时给出提示，无法创建
    if (state.notebooks.length === 0) {
      toast.warning(t('common.needNotebookFirst'));
      return;
    }

    // 决策归属笔记本：
    // 1. 当前已选中某个笔记本 -> 直接归属
    // 2. 标签/收藏视图下，仅一个笔记本 -> 默认归属第一个并提示
    // 3. 所有笔记视图下有多个笔记本 -> 弹出选择器
    let notebookId = state.selectedNotebookId;

    if (!notebookId) {
      if (state.notebooks.length === 1) {
        notebookId = state.notebooks[0].id;
      } else {
        // 多个笔记本，弹选择器让用户决定
        setPendingNoteType(noteType);
        setPickerOpen(true);
        return;
      }
    }

    await createNoteInNotebook(notebookId, noteType);
  };

  // 实际执行创建笔记的逻辑，抽出供选择器回调复用
  // noteType="word" 时：弹文件选择器，走 importDocxAsNote（解析 .docx 为富文本笔记）。
  const createNoteInNotebook = async (
    notebookId: string,
    noteType: "normal" | "markdown" | "word" = "normal",
  ) => {
    try {
      let note: any;
      if (noteType === "word") {
        const { pickDocxFile, importDocxAsNote } = await import("@/lib/wordNoteService");
        const file = await pickDocxFile();
        if (!file) return; // 用户取消
        toast.info("正在导入 Word 文档…");
        const result = await importDocxAsNote({ notebookId, file });
        note = result.note;
        toast.success("导入成功");
      } else if (noteType === "markdown") {
        // 新建原生 Markdown 笔记
        note = await api.createNote({
          notebookId,
          title: "无标题 Markdown",
          contentFormat: "markdown",
          content: "# 无标题 Markdown\n\n",
          contentText: "无标题 Markdown",
        } as any);
      } else {
        note = await api.createNote({ notebookId, title: t('common.untitledNote') });
      }

      // BUG-FAVORITE-CREATE-01: 收藏视图中新建笔记默认设为收藏
      let isFavorite = note.isFavorite || 0;
      if (state.viewMode === "favorites" && !isFavorite) {
        try {
          const updated = await api.updateNote(note.id, { isFavorite: 1 } as any);
          note = updated;
          isFavorite = 1;
        } catch {
          // 收藏设置失败不阻断创建流程
        }
      }

      actions.setActiveNote(note);
      actions.addNoteToList({
        id: note.id,
        userId: note.userId,
        title: note.title,
        contentText: note.contentText || "",
        notebookId: note.notebookId,
        workspaceId: note.workspaceId ?? null,
        isPinned: note.isPinned || 0,
        isFavorite,
        isLocked: note.isLocked || 0,
        isArchived: note.isArchived || 0,
        isTrashed: note.isTrashed || 0,
        version: note.version || 1,
        sortOrder: note.sortOrder || 0,
        updatedAt: note.updatedAt,
        createdAt: note.createdAt,
      } as NoteListItem);
      actions.setMobileView("editor");
      actions.refreshNotebooks();

      // 若新建发生在「所有笔记/收藏/标签」视图且系统自动选择了归属，提示用户
      if (!state.selectedNotebookId && state.viewMode !== "notebook") {
        const nb = state.notebooks.find((n) => n.id === notebookId);
        if (nb) {
          toast.info(t('noteList.noteCreatedInNotebook', { name: nb.name }));
        }
      }
    } catch (err: any) {
      console.error("创建笔记失败:", err);
      toast.error(err?.message || t('noteList.createFailed'));
    }
  };

  // =========================================================================
  // P4：批量 AI 操作
  // -------------------------------------------------------------------------
  // 两个动作：
  //   1) 批量 AI 标签 —— 对选中的每条笔记生成标签并关联；已有标签会被复用，不会
  //      重复创建；失败条目独立计入错误数不阻断其他。
  //   2) 批量 AI 归类 —— 调 /ai/classify 拿 top-1 建议；仅当 confidence >= 0.6
  //      且建议的 notebookId 与当前不同，才自动移动。阈值保守，避免把用户笔记
  //      错误移走；低于阈值视作"跳过"并单独计数。
  //
  // 并发控制：LLM API 容易撞 rate-limit，硬编码并发上限 3；总量超过 20 直接 toast
  //   提示用户分批操作（避免一次发 100 个请求）。
  //
  // 容错：每条独立 try/catch；最终只用一个汇总 toast，不刷屏。
  // =========================================================================

  /** 将数组切成每批 concurrency 大小，串行推进，每项独立容错 */
  const runInBatches = async <T,>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ) => {
    let done = 0;
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      await Promise.all(batch.map((it, k) => fn(it, i + k).catch(() => { /* swallow */ })));
      done += batch.length;
      onProgress?.(done, items.length);
    }
  };

  const BULK_AI_HARD_LIMIT = 20;
  const BULK_AI_CONCURRENCY = 3;
  const BULK_CLASSIFY_THRESHOLD = 0.6;

  const bulkAiGenerateTags = useCallback(async () => {
    if (bulkAiRunning) return;
    const ids = Array.from(selectedIds).filter((id) => {
      const n = state.notes.find((x) => x.id === id);
      return n && !n.isLocked && n.contentText;
    });
    if (ids.length === 0) {
      toast.warning(t('noteList.bulkAiNoEligible') || "没有可处理的笔记（空白或已锁定的不参与）");
      return;
    }
    if (ids.length > BULK_AI_HARD_LIMIT) {
      toast.warning(t('noteList.bulkAiTooMany', { limit: BULK_AI_HARD_LIMIT }) || `单次最多处理 ${BULK_AI_HARD_LIMIT} 条，请分批操作`);
      return;
    }

    setBulkAiRunning({ kind: "tags", done: 0, total: ids.length });
    let okCount = 0;
    let failCount = 0;

    await runInBatches(ids, BULK_AI_CONCURRENCY, async (id) => {
      const note = state.notes.find((x) => x.id === id);
      if (!note || !note.contentText) { failCount++; return; }
      try {
        // 复用单笔记 aiChat("tags") 流程：一次 LLM 调用 + 解析 + 批量加标签
        const result = await api.aiChat("tags", note.contentText.slice(0, 2000));
        const tagNames = result.split(/[,，、\s]+/).map((s) => s.replace(/^#/, "").trim()).filter(Boolean);
        // 逐个确保 tag 存在并关联；此处串行是为避免并发对同一 tag 名重复 INSERT
        for (const name of tagNames) {
          const existing = state.tags.find((t) => t.name === name);
          let tagId: string;
          if (existing) {
            tagId = existing.id;
          } else {
            const newTag = await api.createTag({ name });
            tagId = newTag.id;
          }
          // 轻量防重：后端对已存在关联会返回 409/200，都视作成功
          try {
            await api.addTagToNote(id, tagId);
          } catch { /* ignore already-linked */ }
        }
        okCount++;
      } catch {
        failCount++;
      }
    }, (done, total) => {
      setBulkAiRunning({ kind: "tags", done, total });
    });

    setBulkAiRunning(null);
    // 刷新 tags & notes 以让左侧标签栏和笔记卡片上的 tag 胶囊立刻更新
    api.getTags().then(actions.setTags).catch(() => { /* ignore */ });
    actions.refreshNotes();
    if (failCount === 0) {
      toast.success(t('noteList.bulkAiTagsDone', { count: okCount }) || `已为 ${okCount} 条笔记生成标签`);
    } else {
      toast.warning(t('noteList.bulkAiTagsPartial', { ok: okCount, fail: failCount }) || `完成 ${okCount} 条，失败 ${failCount} 条`);
    }
  }, [bulkAiRunning, selectedIds, state.notes, state.tags, actions, t]);

  // ── 批量 AI 归类：改为"扫描 → 用户确认 → 执行"两段式 ─────────────────
  // 原本是「扫描后直接移动」，用户看到结果时笔记已经被搬走，找不回来也无法反悔。
  // 现在先把 AI 建议收集到 pendingClassify，弹一个确认面板让用户审核/勾选，
  // 确认后才真正调 updateNote。单条归类入口（编辑器内）本来就是列表式交互，
  // 无需改动；此改动仅影响多选底部工具栏的 "AI 归类" 按钮。
  //
  // 数据结构：每一项代表一条"AI 建议移动"的候选，包含置信度与目标笔记本信息。
  // checked=false 可让用户逐条反选；<阈值 / 建议就是当前笔记本 的条目不会进入列表。
  type ClassifyPlanItem = {
    noteId: string;
    noteTitle: string;
    fromNotebookId: string | null;
    fromNotebookName: string;
    toNotebookId: string;
    toNotebookName: string;
    toPath?: string;           // 目标笔记本完整路径（"父/子"），有就展示
    confidence: number;        // 0~1
    checked: boolean;
  };
  const [pendingClassify, setPendingClassify] = useState<ClassifyPlanItem[] | null>(null);
  // 扫描阶段进度：done/total，用于弹窗 loading 态
  const [classifyScanning, setClassifyScanning] = useState<{ done: number; total: number } | null>(null);

  const bulkAiClassify = useCallback(async () => {
    if (bulkAiRunning || classifyScanning) return;
    const ids = Array.from(selectedIds).filter((id) => {
      const n = state.notes.find((x) => x.id === id);
      return n && !n.isLocked;
    });
    if (ids.length === 0) {
      toast.warning(t('noteList.bulkAiNoEligible') || "没有可处理的笔记（已锁定的不参与）");
      return;
    }
    if (ids.length > BULK_AI_HARD_LIMIT) {
      toast.warning(t('noteList.bulkAiTooMany', { limit: BULK_AI_HARD_LIMIT }) || `单次最多处理 ${BULK_AI_HARD_LIMIT} 条，请分批操作`);
      return;
    }
    // 跨工作区的笔记不允许批量归类——候选集是单 scope 的，
    // 混着的话后半段 notebook 会被 cross-workspace move 拒绝。
    const wsSet = new Set<string | null>(
      ids.map((id) => {
        const n = state.notes.find((x) => x.id === id);
        return (n?.workspaceId || null) as string | null;
      }),
    );
    if (wsSet.size > 1) {
      toast.warning(t('noteList.bulkAiCrossWs') || "所选笔记跨多个工作区，请分别操作");
      return;
    }

    // 阶段 1：扫描 —— 并发调 /ai/classify 收集 top-1 建议，不做任何移动
    setClassifyScanning({ done: 0, total: ids.length });
    const plan: ClassifyPlanItem[] = [];
    let skippedCount = 0; // 建议相同 / 置信度不足 / 无建议
    let failCount = 0;

    await runInBatches(ids, BULK_AI_CONCURRENCY, async (id) => {
      const note = state.notes.find((x) => x.id === id);
      if (!note) { failCount++; return; }
      try {
        const res = await api.aiClassify({ noteId: id });
        const top = res.suggestions.find((s) => s.notebookId !== note.notebookId);
        if (!top || top.confidence < BULK_CLASSIFY_THRESHOLD) {
          skippedCount++;
          return;
        }
        const fromNb = state.notebooks.find((n) => n.id === note.notebookId);
        plan.push({
          noteId: id,
          noteTitle: note.title || (t('noteList.untitled') as string) || "未命名",
          fromNotebookId: note.notebookId,
          fromNotebookName: fromNb?.name || "—",
          toNotebookId: top.notebookId,
          toNotebookName: top.notebookName,
          toPath: (top as any).path,
          confidence: top.confidence,
          checked: true, // 默认勾选，用户只需反选不想移的
        });
      } catch {
        failCount++;
      }
    }, (done, total) => {
      setClassifyScanning({ done, total });
    });

    setClassifyScanning(null);

    if (plan.length === 0) {
      // 全部没建议 / 相同 / 失败——不弹窗，直接汇总
      toast.info(
        t('noteList.bulkAiClassifyNoPlan', { skipped: skippedCount, failed: failCount })
          || `AI 未给出可移动的建议（跳过 ${skippedCount} 条，失败 ${failCount} 条）`,
      );
      return;
    }

    // 阶段 2：展示确认面板，等待用户决策；真正的移动在 confirmClassifyPlan 里
    setPendingClassify(plan);
    if (skippedCount > 0 || failCount > 0) {
      // 侧附提示：有部分条目跳过/失败，避免用户疑惑
      toast.info(
        t('noteList.bulkAiClassifyPartial', { matched: plan.length, skipped: skippedCount, failed: failCount })
          || `AI 给出 ${plan.length} 条建议，另有 ${skippedCount} 条跳过、${failCount} 条失败`,
      );
    }
  }, [bulkAiRunning, classifyScanning, selectedIds, state.notes, state.notebooks, t]);

  /** 用户确认后执行真正的移动。由 pendingClassify 面板的"确认"按钮触发。 */
  const confirmClassifyPlan = useCallback(async () => {
    if (!pendingClassify || bulkAiRunning) return;
    const toMove = pendingClassify.filter((p) => p.checked);
    if (toMove.length === 0) {
      setPendingClassify(null);
      return;
    }
    setPendingClassify(null);
    setBulkAiRunning({ kind: "classify", done: 0, total: toMove.length });
    let movedCount = 0;
    let failCount = 0;

    await runInBatches(toMove, BULK_AI_CONCURRENCY, async (item) => {
      try {
        await api.updateNote(item.noteId, { notebookId: item.toNotebookId } as any);
        movedCount++;
        actions.updateNoteInList({ id: item.noteId, notebookId: item.toNotebookId });
      } catch {
        failCount++;
      }
    }, (done, total) => {
      setBulkAiRunning({ kind: "classify", done, total });
    });

    setBulkAiRunning(null);
    actions.refreshNotebooks();
    actions.refreshNotes();
    toast.success(
      t('noteList.bulkAiClassifyDone2', { moved: movedCount, failed: failCount })
        || `批量归类完成：已移动 ${movedCount} 条，失败 ${failCount} 条`,
    );
  }, [pendingClassify, bulkAiRunning, actions, t]);

  // 根据当前视图和目标笔记动态构建菜单项
  const getMenuItems = (): ContextMenuItem[] => {
    const targetNote = state.notes.find((n) => n.id === menu.targetId);
    if (!targetNote) return [];

    const isTrashView = state.viewMode === "trash";
    // 若右键点击的是多选中的一员，批量操作；否则针对该条
    const bulkMode = menu.targetId && selectedIds.has(menu.targetId) && selectedIds.size > 1;
    const bulkCount = bulkMode ? selectedIds.size : 0;

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
        label: bulkMode ? t('noteList.moveNotesTitle', { count: bulkCount }) : t('noteList.moveTo'),
        icon: <FolderInput size={14} />,
        disabled: !bulkMode && !!targetNote.isLocked,
      },
      // 单笔记导出：批量模式暂不提供子菜单，避免一次触发 N 个下载弹窗。
      ...(bulkMode
        ? []
        : [
            {
              id: "export_submenu",
              label: t("noteList.export") || "导出...",
              icon: <Download size={14} />,
              children: [
                { id: "export_md", label: t("noteList.exportAsMarkdown") || "Markdown", icon: <Download size={14} /> },
                { id: "export_pdf", label: t("noteList.exportAsPDF") || "PDF", icon: <Printer size={14} /> },
                { id: "export_png", label: t("note.exportAsPng") || "图片 PNG", icon: <ImageIcon size={14} /> },
                { id: "export_jpg", label: t("note.exportAsJpg") || "图片 JPG", icon: <ImageIcon size={14} /> },
                { id: "export_word", label: t("noteList.exportAsWord") || "Word", icon: <FileType2 size={14} /> },
              ],
            } as ContextMenuItem,
          ]),
      { id: "sep2", label: "", separator: true },
      {
        id: "trash",
        label: bulkMode
          ? `${t('noteList.moveToTrash')} (${bulkCount})`
          : t('noteList.moveToTrash'),
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: !bulkMode && !!targetNote.isLocked,
      },
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
      case "export_md": {
        // 单笔记导出：锁定态允许（只读操作，不涉及修改）。
        // exportSingleNote 内部会按是否含图决定下 .md 还是 .zip。
        haptic.light();
        const toastId = toast.info(t('export.exportingNote', { name: targetNote.title }), 0);
        try {
          const ok = await exportSingleNote(targetId);
          toast.dismiss(toastId);
          if (ok) {
            toast.success(t('export.exportComplete'));
          } else {
            toast.error(t('export.exportFailed', { error: '' }));
          }
        } catch (err: any) {
          toast.dismiss(toastId);
          toast.error(err?.message || t('export.exportFailed', { error: String(err) }));
        }
        break;
      }
      case "export_pdf": {
        // 单笔记导出 PDF：
        //   - Electron 桌面端：直接保存矢量 PDF（走主进程 printToPDF）；
        //   - 浏览器：html2canvas + jsPDF 直接生成并下载 PDF（光栅，中文正常）。
        haptic.light();
        const toastId = toast.info(t('export.exportingNote', { name: targetNote.title }), 0);
        try {
          const res = await exportSingleNoteAsPDF(targetId);
          toast.dismiss(toastId);
          if (res.ok && (res.mode === "desktop" || res.mode === "web")) {
            toast.success(t('export.exportComplete'));
          } else if (!res.ok && res.mode === "canceled") {
            // 用户主动取消保存对话框，不提示错误
          } else {
            toast.error(t('export.exportFailed', { error: (res as { error?: string }).error || '' }));
          }
        } catch (err: any) {
          toast.dismiss(toastId);
          toast.error(err?.message || t('export.exportFailed', { error: String(err) }));
        }
        break;
      }
      case "export_png":
      case "export_jpg": {
        // 单笔记导出 PNG / JPG：复用编辑器/侧边栏已有的 html2canvas 链路。
        haptic.light();
        const format = actionId === "export_png" ? "png" : "jpg";
        const toastId = toast.info(t('note.exportImageExporting') || '导出中...', 0);
        try {
          const fresh = await api.getNote(targetId);
          const ok = await exportNoteAsImage(
            {
              id: fresh.id,
              title: fresh.title,
              content: fresh.content,
              contentText: fresh.contentText,
              updatedAt: fresh.updatedAt,
            },
            { format }
          );
          toast.dismiss(toastId);
          ok
            ? toast.success(t('note.exportImageSuccess') || '导出成功')
            : toast.error(t('note.exportImageFailed') || '导出失败');
        } catch (err: any) {
          toast.dismiss(toastId);
          toast.error(err?.message || t('note.exportImageFailed') || '导出失败');
        }
        break;
      }
      case "export_word": {
        // 单笔记导出 .docx：
        //   - 复用 wordNoteService 已有的 exportNoteAsDocx + downloadDocxBlob（TiptapEditor 工具栏同款）
        //   - 走 dynamic import 避免把 office IR / docx 生成模块计入首屏 bundle
        //   - 老笔记 content 可能是 HTML / Markdown / 纯文本，exportNoteAsDocx 内部已做兜底
        haptic.light();
        const toastId = toast.info(t('export.exportingNote', { name: targetNote.title }), 0);
        try {
          // 右键菜单只持有 noteId，需要先拉一次完整笔记拿到 content
          const fresh = await api.getNote(targetId);
          const { exportNoteAsDocx, downloadDocxBlob } = await import("@/lib/wordNoteService");
          const blob = await exportNoteAsDocx(fresh.content || "", fresh.title || "未命名笔记");
          downloadDocxBlob(blob, fresh.title || "未命名笔记");
          toast.dismiss(toastId);
          toast.success(t('export.exportComplete'));
        } catch (err: any) {
          toast.dismiss(toastId);
          toast.error(err?.message || t('export.exportFailed', { error: String(err) }));
        }
        break;
      }
      case "trash": {
        haptic.heavy();
        // 若右键目标在多选中且多选 >1，批量移入回收站
        if (selectedIds.has(targetId) && selectedIds.size > 1) {
          const ids = Array.from(selectedIds);
          // 过滤掉已锁定的笔记（不允许操作）
          const movable = ids.filter((id) => {
            const n = state.notes.find((x) => x.id === id);
            return n && !n.isLocked;
          });
          if (movable.length === 0) {
            toast.warning(t('common.noteLockedCannotEdit') || t('editor.lockedBanner'));
            break;
          }
          if (state.activeNote && movable.includes(state.activeNote.id)) actions.setActiveNote(null);
          for (const id of movable) actions.removeNoteFromList(id);
          setSelectedIds(new Set());
          setLastClickedId(null);
          Promise.all(movable.map((id) => api.updateNote(id, { isTrashed: 1 } as any)))
            .then(() => {
              actions.refreshNotebooks();
              actions.refreshNotes();
              toast.success(t('noteList.bulkTrashSuccess', { count: movable.length }));
            })
            .catch((err) => {
              console.error(err);
              actions.refreshNotes();
            });
          break;
        }
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        actions.removeNoteFromList(targetId);
        api.updateNote(targetId, { isTrashed: 1 } as any)
          .then(() => {
            actions.refreshNotebooks();
            actions.refreshNotes();
          })
          .catch(console.error);
        break;
      }
      case "move": {
        // 多选批量移动
        if (selectedIds.has(targetId) && selectedIds.size > 1) {
          const ids = Array.from(selectedIds).filter((id) => {
            const n = state.notes.find((x) => x.id === id);
            return n && !n.isLocked;
          });
          if (ids.length === 0) {
            toast.warning(t('common.noteLockedCannotEdit') || t('editor.lockedBanner'));
            break;
          }
          // 批量移动要求源都在同一个 workspace，否则直接拒绝（后端反正也会拒）。
          // 用 Set 收集所有涉及到的 workspaceId（归一化 undefined/"" → null）。
          const wsSet = new Set<string | null>(
            ids.map((id) => {
              const n = state.notes.find((x) => x.id === id);
              return (n?.workspaceId || null) as string | null;
            }),
          );
          if (wsSet.size > 1) {
            toast.warning("所选笔记跨多个工作区，请分别移动");
            break;
          }
          const [sourceWs] = Array.from(wsSet);
          setMoveModal({
            noteIds: ids,
            noteTitle: targetNote.title,
            notebookId: targetNote.notebookId,
            sourceWorkspaceId: sourceWs ?? null,
          });
        } else {
          setMoveModal({
            noteIds: [targetId],
            noteTitle: targetNote.title,
            notebookId: targetNote.notebookId,
            sourceWorkspaceId: (targetNote.workspaceId || null) as string | null,
          });
        }
        break;
      }
      case "restore": {
        haptic.success();
        actions.removeNoteFromList(targetId);
        api.updateNote(targetId, { isTrashed: 0 } as any)
          .then(() => {
            actions.refreshNotebooks();
            actions.refreshNotes();
          })
          .catch((err: any) => {
            // v14：父笔记本已被软删 → 后端拒绝直接恢复，需要用户先选一个新笔记本。
            // 当前最小修复：toast 提示并刷新回收站列表（被乐观删掉的项会重新出现）。
            // 后续若做"还原到指定笔记本"UI，可在此打开笔记本选择器再走 PUT
            // 带 notebookId 重试。
            if (err?.code === "NOTEBOOK_TRASHED") {
              toast.warning(
                err?.message ||
                  t("noteList.restoreNotebookTrashed") ||
                  "原笔记本已删除，请先在「所有笔记」选择一个新的笔记本作为还原位置",
              );
              actions.refreshNotes();
              return;
            }
            console.error(err);
            actions.refreshNotes();
          });
        break;
      }
      case "delete_permanent": {
        haptic.heavy();
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        actions.removeNoteFromList(targetId);
        api.deleteNote(targetId)
          .then(() => {
            actions.refreshNotebooks();
            actions.refreshNotes();
          })
          .catch(console.error);
        break;
      }
    }
  };

  const handleMoveNote = async (targetNotebookId: string) => {
    if (!moveModal) return;
    const ids = moveModal.noteIds;
    const results = await Promise.allSettled(
      ids.map((id) => api.updateNote(id, { notebookId: targetNotebookId } as any))
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const success = ids.length - failed;

    // 识别"跨工作区被后端拒绝"的专属错误码，给出显式提示——否则会落到
    // bulkMoveFailed 的通用"移动失败"文案，让用户不知道问题是什么。
    // 后端返回形如 { error, code: "CROSS_WORKSPACE_MOVE_FORBIDDEN", ... }，
    // api.ts 的 request() 会把该 body 序列化后塞进 Error.message。
    const crossWsRejected = results.filter(
      (r) =>
        r.status === "rejected" &&
        /CROSS_WORKSPACE_MOVE_FORBIDDEN/.test(String((r as PromiseRejectedResult).reason?.message || "")),
    ).length;

    // 同步 activeNote（若它也在被移动的列表里）
    if (state.activeNote && ids.includes(state.activeNote.id)) {
      actions.setActiveNote({ ...state.activeNote, notebookId: targetNotebookId });
    }

    setMoveModal(null);
    setSelectedIds(new Set());
    setLastClickedId(null);
    await fetchNotes();
    actions.refreshNotebooks();

    if (ids.length === 1) {
      if (failed) {
        if (crossWsRejected > 0) {
          toast.error("不能跨工作区移动，目标笔记本与源笔记不在同一空间");
        } else {
          toast.error(t('noteList.bulkMoveFailed', { error: '' }));
        }
      }
    } else if (failed === 0) {
      toast.success(t('noteList.bulkMoveSuccess', { count: success }));
    } else if (success === 0) {
      if (crossWsRejected === failed) {
        toast.error("不能跨工作区移动，目标笔记本与源笔记不在同一空间");
      } else {
        toast.error(t('noteList.bulkMoveFailed', { error: '' }));
      }
    } else {
      toast.warning(t('noteList.bulkMovePartial', { success, failed }));
    }
  };

  // 是否允许拖拽排序：仅在 manual 排序模式 + 笔记本/全部/收藏/标签 视图下生效。
  // 非 manual 模式下，列表顺序由后端 ORDER BY 决定，拖拽完一刷新就被覆盖，没意义。
  const canDragSort = sortPref.by === "manual" && (
    state.viewMode === "notebook" || state.viewMode === "all" || state.viewMode === "favorites" || state.viewMode === "tag"
  );

  // 判别 DataTransfer 是否带"操作系统外部文件"——
  // 这是区分"内部笔记排序拖拽 vs 用户从桌面/资源管理器拖入文件"的唯一可靠依据。
  // 注意：dragover 阶段大多数浏览器只暴露 types，files 列表为空，必须用 types 判别。
  const hasExternalFiles = (e: React.DragEvent) => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    // types 是 DOMStringList 或 string[]，统一遍历
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  };

  // 把用户拖入的一组文件按扩展名分流到对应导入器；不支持的类型统一温和拒绝。
  // 仅识别 .md / .markdown / .txt / .docx——和方案 C 商定的范围保持一致。
  const handleExternalFilesDrop = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    // 先确定目标笔记本（复用 handleCreateNote 的归属规则，但拖拽场景不弹选择器：
    // 若没有明确归属就拒绝，避免拖错位置）。
    let notebookId = state.selectedNotebookId;
    if (!notebookId) {
      if (state.notebooks.length === 1) {
        notebookId = state.notebooks[0].id;
      } else {
        toast.warning("请先选择一个笔记本，再拖入文件");
        return;
      }
    }

    const supported: File[] = [];
    const unsupported: string[] = [];
    for (const f of list) {
      const lower = f.name.toLowerCase();
      if (
        lower.endsWith(".md") ||
        lower.endsWith(".markdown") ||
        lower.endsWith(".txt") ||
        lower.endsWith(".docx")
      ) {
        supported.push(f);
      } else {
        unsupported.push(f.name);
      }
    }

    if (unsupported.length > 0) {
      toast.warning(
        `已忽略 ${unsupported.length} 个不支持的文件（仅支持 .md / .markdown / .txt / .docx）`,
      );
    }
    if (supported.length === 0) return;

    // 多文件按顺序导入；任一条失败不阻断其它。
    const { importDocxAsNote } = await import("@/lib/wordNoteService");
    const { importMarkdownAsNote } = await import("@/lib/importService");

    let firstNote: any = null;
    let okCount = 0;
    let failCount = 0;

    if (supported.length > 1) {
      toast.info(`正在导入 ${supported.length} 个文件…`);
    } else {
      toast.info("正在导入文件…");
    }

    for (const f of supported) {
      try {
        const isDocx = /\.docx$/i.test(f.name);
        const result = isDocx
          ? await importDocxAsNote({ notebookId: notebookId!, file: f })
          : await importMarkdownAsNote({ notebookId: notebookId!, file: f });
        const note = result.note;
        if (!firstNote) firstNote = note;
        actions.addNoteToList({
          id: note.id,
          userId: note.userId,
          title: note.title,
          contentText: note.contentText || "",
          notebookId: note.notebookId,
          workspaceId: note.workspaceId ?? null,
          isPinned: note.isPinned || 0,
          isFavorite: note.isFavorite || 0,
          isLocked: note.isLocked || 0,
          isArchived: note.isArchived || 0,
          isTrashed: note.isTrashed || 0,
          version: note.version || 1,
          sortOrder: note.sortOrder || 0,
          updatedAt: note.updatedAt,
          createdAt: note.createdAt,
        } as NoteListItem);
        okCount++;
      } catch (err: any) {
        console.error("导入文件失败:", f.name, err);
        failCount++;
      }
    }

    // 单文件成功：直接打开；多文件成功：仅汇总 toast，不强行切换打开的笔记。
    if (firstNote && supported.length === 1) {
      actions.setActiveNote(firstNote);
      actions.setMobileView("editor");
    }
    actions.refreshNotebooks();

    if (okCount > 0 && failCount === 0) {
      toast.success(`导入成功 ${okCount} 个文件`);
    } else if (okCount > 0 && failCount > 0) {
      toast.warning(`导入完成：成功 ${okCount} 个，失败 ${failCount} 个`);
    } else {
      toast.error("导入失败");
    }
  }, [state.selectedNotebookId, state.notebooks, actions]);

  // 拖拽排序处理（桌面端 HTML5 Drag API）
  const handleDragStart = useCallback((e: React.DragEvent, noteId: string) => {
    setDragNoteId(noteId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-nowen-note", noteId);
    e.dataTransfer.setData("text/plain", noteId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, noteId: string) => {
    e.preventDefault();
    // 外部文件：显示 copy 光标 + 不高亮某条笔记（避免误导用户以为在替换该条）
    if (hasExternalFiles(e)) {
      e.dataTransfer.dropEffect = "copy";
      if (dragOverNoteId) setDragOverNoteId(null);
      return;
    }
    e.dataTransfer.dropEffect = "move";
    if (noteId !== dragNoteId) {
      setDragOverNoteId(noteId);
    }
  }, [dragNoteId, dragOverNoteId]);

  const handleDragEnd = useCallback(() => {
    setDragNoteId(null);
    setDragOverNoteId(null);
  }, []);

  // 列表空白区域兜底：用户拖文件到没有笔记的位置也能识别（方案 B：全列表都收）
  const handleListDragOver = useCallback((e: React.DragEvent) => {
    if (!hasExternalFiles(e)) return; // 内部排序拖拽走 NoteCard 的处理，不抢
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleListDrop = useCallback((e: React.DragEvent) => {
    if (!hasExternalFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleExternalFilesDrop(e.dataTransfer.files);
    }
  }, [handleExternalFilesDrop]);

  const handleDrop = useCallback(async (e: React.DragEvent, targetNoteId: string) => {
    e.preventDefault();
    // 外部文件优先：拖到任意笔记上也走"导入到当前笔记本"，不替换/合并那条笔记
    if (hasExternalFiles(e) && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setDragOverNoteId(null);
      handleExternalFilesDrop(e.dataTransfer.files);
      return;
    }
    const sourceId = dragNoteId;
    setDragNoteId(null);
    setDragOverNoteId(null);
    if (!sourceId || sourceId === targetNoteId) return;

    const currentNotes = [...state.notes];
    const sourceIdx = currentNotes.findIndex((n) => n.id === sourceId);
    const targetIdx = currentNotes.findIndex((n) => n.id === targetNoteId);
    if (sourceIdx === -1 || targetIdx === -1) return;

    // 移动元素
    const [moved] = currentNotes.splice(sourceIdx, 1);
    currentNotes.splice(targetIdx, 0, moved);

    // 更新本地状态
    actions.setNotes(currentNotes);

    // 持久化排序
    const items = currentNotes.map((n, i) => ({ id: n.id, sortOrder: i }));
    try {
      await api.reorderNotes(items);
    } catch (err) {
      console.error("Failed to reorder notes:", err);
      await fetchNotes(); // 回滚
    }
  }, [dragNoteId, state.notes, actions, fetchNotes]);

  // 移动端触摸拖拽处理
  const handleTouchStart = useCallback((noteId: string, e: React.TouchEvent) => {
    if (!canDragSort) return;
    const touch = e.touches[0];
    touchDragRef.current = {
      noteId,
      startY: touch.clientY,
      startX: touch.clientX,
      currentY: touch.clientY,
      isDragging: false,
      ghostEl: null,
    };
  }, [canDragSort]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const td = touchDragRef.current;
    if (!td) return;
    const touch = e.touches[0];
    const deltaY = Math.abs(touch.clientY - td.startY);
    const deltaX = Math.abs(touch.clientX - td.startX);

    // 判断是否开始拖拽（纵向移动超过 10px 且大于横向）
    if (!td.isDragging && deltaY > 10 && deltaY > deltaX) {
      td.isDragging = true;
      setDragNoteId(td.noteId);
      haptic.light();
    }

    if (!td.isDragging) return;
    td.currentY = touch.clientY;

    // 检测当前触摸位置下的笔记卡片
    let foundTarget: string | null = null;
    noteCardRefs.current.forEach((el, id) => {
      if (id === td.noteId) return;
      const rect = el.getBoundingClientRect();
      if (touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        foundTarget = id;
      }
    });
    setDragOverNoteId(foundTarget);
  }, []);

  const handleTouchEnd = useCallback(async () => {
    const td = touchDragRef.current;
    touchDragRef.current = null;

    if (!td || !td.isDragging) {
      setDragNoteId(null);
      setDragOverNoteId(null);
      return;
    }

    const sourceId = td.noteId;
    const targetId = dragOverNoteId;
    setDragNoteId(null);
    setDragOverNoteId(null);

    if (!targetId || sourceId === targetId) return;

    const currentNotes = [...state.notes];
    const sourceIdx = currentNotes.findIndex((n) => n.id === sourceId);
    const targetIdx = currentNotes.findIndex((n) => n.id === targetId);
    if (sourceIdx === -1 || targetIdx === -1) return;

    const [moved] = currentNotes.splice(sourceIdx, 1);
    currentNotes.splice(targetIdx, 0, moved);
    actions.setNotes(currentNotes);
    haptic.medium();

    const items = currentNotes.map((n, i) => ({ id: n.id, sortOrder: i }));
    try {
      await api.reorderNotes(items);
    } catch (err) {
      console.error("Failed to reorder notes:", err);
      await fetchNotes();
    }
  }, [dragOverNoteId, state.notes, actions, fetchNotes]);

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
      <header className="flex items-center justify-between px-4 py-3 border-b border-app-border md:hidden relative z-40" style={{ paddingTop: 'calc(var(--safe-area-top) + 4px)' }}>
        <button
          onClick={() => actions.setMobileSidebar(true)}
          className="p-2 -ml-2 rounded-lg text-tx-secondary hover:bg-app-hover active:bg-app-active"
        >
          <Menu size={24} />
        </button>
        <h2 className="text-sm font-semibold text-tx-primary">{viewTitles[state.viewMode]}</h2>
        <div className="flex items-center gap-1 relative">
          {/* 移动端排序按钮（搜索/回收站不显示） */}
          {state.viewMode !== "trash" && state.viewMode !== "search" && (
            <button
              ref={sortBtnRef}
              onClick={() => setShowSortMenu((v) => !v)}
              className={cn(
                "p-1.5 rounded-md transition-colors relative",
                sortPref.by !== "manual"
                  ? "text-accent-primary bg-accent-primary/10"
                  : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
              )}
              title={t("noteList.sortBy")}
            >
              <ArrowUpDown size={18} />
            </button>
          )}
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
          {state.viewMode === "trash" ? (
            // 回收站视图下用"一键清空"按钮替换"新建"——后者在回收站语义不通且会被禁止；
            // 移动端 Sidebar 未挂载时自定义事件无人监听，改为直接调用 confirm + api.emptyTrash。
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-accent-danger hover:bg-accent-danger/10"
              title={t('sidebar.emptyTrash')}
              aria-label={t('sidebar.emptyTrash')}
              onClick={handleEmptyTrash}
            >
              <Trash2 size={18} />
            </Button>
          ) : (
            // split-button：左侧 + 依然是"新建普通笔记"保留肉记忆；右侧箭头弹类型选择。
            <div className="flex items-center">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleCreateNote("normal")}>
                <Plus size={18} />
              </Button>
              <button
                ref={createMenuAnchorDesktopRef}
                type="button"
                aria-label="选择新建类型"
                onClick={() => {
                  setCreateMenuSource("desktop");
                  setCreateMenuOpen((v) => !v);
                }}
                className="h-8 w-5 flex items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          )}
          {/* 排序下拉（移动端） */}
          {showSortMenu && (
            <SortMenu
              value={sortPref}
              anchorRef={sortBtnRef}
              onChange={(next) => {
                setSortPref(next);
                saveSortPref(next);
              }}
              onClose={() => setShowSortMenu(false)}
              showNoteTime={showNoteTime}
              onToggleShowTime={() => userPrefs.setUserPref("showNoteListUpdatedTime", !userPrefs.prefs.showNoteListUpdatedTime)}
            />
          )}
        </div>
      </header>

      {/* Desktop Header */}
      <div className="hidden md:flex items-center justify-between px-4 py-3 border-b border-app-border relative z-40">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-accent-primary" />
          <h2 className="text-sm font-medium text-tx-primary">{viewTitles[state.viewMode]}</h2>
        </div>
        <div className="flex items-center gap-1 relative">
          {/* 折叠笔记列表面板（桌面专用；点击后中间整列隐藏，编辑器占满）。
              与Rail上的 toggleSidebar 互不干扰，均有独立状态。 */}
          <button
            type="button"
            onClick={() => actions.toggleNoteListCollapsed()}
            title={t("common.collapseList")}
            aria-label={t("common.collapseList")}
            className="p-1.5 rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary transition-colors"
          >
            <PanelLeftClose size={15} />
          </button>
          {/* 桌面端排序按钮 */}
          {state.viewMode !== "trash" && state.viewMode !== "search" && (
            <button
              ref={sortBtnRef}
              onClick={() => setShowSortMenu((v) => !v)}
              className={cn(
                "p-1.5 rounded-md transition-colors relative",
                sortPref.by !== "manual"
                  ? "text-accent-primary bg-accent-primary/10"
                  : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
              )}
              title={t("noteList.sortBy")}
            >
              <ArrowUpDown size={15} />
            </button>
          )}
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
          {state.viewMode === "trash" ? (
            // 回收站视图：将"+"换成"一键清空回收站"——破坏性操作做红色降级 + 标题提示，
            // 直接调用 confirm + api.emptyTrash，不依赖 Sidebar 自定义事件。
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-accent-danger hover:bg-accent-danger/10"
              title={t('sidebar.emptyTrash')}
              aria-label={t('sidebar.emptyTrash')}
              onClick={handleEmptyTrash}
            >
              <Trash2 size={15} />
            </Button>
          ) : (
            // split-button： + 依然走"新建普通笔记"；箭头点开后选择类型。
            <div className="flex items-center">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCreateNote("normal")}>
                <Plus size={15} />
              </Button>
              <button
                ref={createMenuAnchorMobileRef}
                type="button"
                aria-label="选择新建类型"
                onClick={() => {
                  setCreateMenuSource("mobile");
                  setCreateMenuOpen((v) => !v);
                }}
                className="h-7 w-4 flex items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary transition-colors"
              >
                <ChevronDown size={11} />
              </button>
            </div>
          )}
          {/* 排序下拉（桌面端） */}
          {showSortMenu && (
            <SortMenu
              value={sortPref}
              anchorRef={sortBtnRef}
              onChange={(next) => {
                setSortPref(next);
                saveSortPref(next);
              }}
              onClose={() => setShowSortMenu(false)}
              showNoteTime={showNoteTime}
              onToggleShowTime={() => userPrefs.setUserPref("showNoteListUpdatedTime", !userPrefs.prefs.showNoteListUpdatedTime)}
            />
          )}
        </div>
      </div>

      {/* 日历筛选面板 */}
      {showCalendar && state.viewMode !== "trash" && state.viewMode !== "search" && (
        <div className="border-b border-app-border bg-app-surface max-md:animate-in max-md:slide-in-from-top max-md:duration-200">
          <MiniCalendarFilter
            selectedDate={dateFilter}
            onSelect={(d) => setDateFilter(d)}
            onClear={() => setDateFilter(null)}
            dateCounts={dateCounts}
          />
        </div>
      )}

      {/* Count */}
      <div className="px-4 py-1.5">
        <span className="text-[10px] text-tx-tertiary">{t('common.noteCount', { count: sortedNotes.length })}</span>
      </div>

      {/* 多选操作栏 */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-accent-primary/10 border-y border-accent-primary/20">
          <span className="text-xs font-medium text-accent-primary truncate">
            {t('noteList.selectedCount', { count: selectedIds.size })}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {state.viewMode !== "trash" && (
              <>
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors"
                  onClick={() => {
                    const ids = Array.from(selectedIds).filter((id) => {
                      const n = state.notes.find((x) => x.id === id);
                      return n && !n.isLocked;
                    });
                    if (ids.length === 0) {
                      toast.warning(t('editor.lockedBanner'));
                      return;
                    }
                    const first = state.notes.find((n) => n.id === ids[0]);
                    // 与右键菜单同样做跨 workspace 防护
                    const wsSet = new Set<string | null>(
                      ids.map((id) => {
                        const n = state.notes.find((x) => x.id === id);
                        return (n?.workspaceId || null) as string | null;
                      }),
                    );
                    if (wsSet.size > 1) {
                      toast.warning("所选笔记跨多个工作区，请分别移动");
                      return;
                    }
                    const [sourceWs] = Array.from(wsSet);
                    setMoveModal({
                      noteIds: ids,
                      noteTitle: first?.title || "",
                      notebookId: first?.notebookId || "",
                      sourceWorkspaceId: sourceWs ?? null,
                    });
                  }}
                  title={t('noteList.moveSelected')}
                >
                  <FolderInput size={12} />
                  <span>{t('noteList.moveSelected')}</span>
                </button>
                {/* ── P4：批量 AI 操作 ──
                    两颗按钮复用当前 selectedIds；运行中按钮 disabled 并替换为进度文本，
                    避免用户误触发二次请求把额度烧掉。 */}
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 disabled:opacity-50 disabled:cursor-wait transition-colors"
                  onClick={bulkAiGenerateTags}
                  disabled={!!bulkAiRunning}
                  title={t('noteList.bulkAiTagsTip') || "为所选笔记批量生成标签"}
                >
                  {bulkAiRunning?.kind === "tags" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <TagIcon size={12} />
                  )}
                  <span>
                    {bulkAiRunning?.kind === "tags"
                      ? `${bulkAiRunning.done}/${bulkAiRunning.total}`
                      : (t('noteList.bulkAiTags') || "AI 标签")}
                  </span>
                </button>
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 disabled:opacity-50 disabled:cursor-wait transition-colors"
                  onClick={bulkAiClassify}
                  disabled={!!bulkAiRunning || !!classifyScanning}
                  title={t('noteList.bulkAiClassifyTip') || "AI 自动归类（先扫描，再人工确认是否移动）"}
                >
                  {(bulkAiRunning?.kind === "classify" || classifyScanning) ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>
                    {classifyScanning
                      ? `${t('noteList.bulkAiClassifyScanning') || 'AI 扫描中'} ${classifyScanning.done}/${classifyScanning.total}`
                      : bulkAiRunning?.kind === "classify"
                      ? `${bulkAiRunning.done}/${bulkAiRunning.total}`
                      : (t('noteList.bulkAiClassify') || "AI 归类")}
                  </span>
                </button>
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md text-red-500 hover:bg-red-500/10 transition-colors"
                  onClick={() => {
                    const ids = Array.from(selectedIds).filter((id) => {
                      const n = state.notes.find((x) => x.id === id);
                      return n && !n.isLocked;
                    });
                    if (ids.length === 0) {
                      toast.warning(t('editor.lockedBanner'));
                      return;
                    }
                    if (state.activeNote && ids.includes(state.activeNote.id)) actions.setActiveNote(null);
                    for (const id of ids) actions.removeNoteFromList(id);
                    setSelectedIds(new Set());
                    setLastClickedId(null);
                    haptic.heavy();
                    Promise.all(ids.map((id) => api.updateNote(id, { isTrashed: 1 } as any)))
                      .then(() => {
                        actions.refreshNotebooks();
                        actions.refreshNotes();
                        toast.success(t('noteList.bulkTrashSuccess', { count: ids.length }));
                      })
                      .catch((err) => {
                        console.error(err);
                        actions.refreshNotes();
                      });
                  }}
                  title={t('noteList.trashSelected')}
                >
                  <Trash2 size={12} />
                </button>
              </>
            )}
            <button
              className="inline-flex items-center p-1 rounded-md text-tx-secondary hover:bg-app-hover transition-colors"
              onClick={() => {
                setSelectedIds(new Set());
                setLastClickedId(null);
              }}
              title={t('noteList.clearSelection')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* List - 包裹下拉刷新（仅移动端生效，桌面端不影响） */}
      {/* 拖拽外部文件兜底层：让用户拖到列表的任意位置（含空白处、虚拟列表、骨架屏）
          都能触发文件导入（方案 B）。NoteCard 自身也在 handleDrop 里做了同源判断，
          这里只是兜底处理“没落到任何笔记上”的情况。dragover 必须 preventDefault
          才能让 drop 事件触发。

          视觉反馈：isFileDragging 为真时在列表上覆一层高亮边框 + 中央提示卡片，
          让用户明确“此区域可以接收文件”。overlay 用 pointer-events:none 以免吃事件。 */}
      <div
        className={cn(
          "flex-1 min-h-0 flex flex-col relative transition-colors duration-150",
          isFileDragging && "bg-accent-primary/5",
        )}
        onDragEnter={(e) => {
          if (!hasExternalFiles(e)) return;
          fileDragDepthRef.current += 1;
          if (!isFileDragging) setIsFileDragging(true);
        }}
        onDragOver={(e) => {
          handleListDragOver(e);
          // dragenter 有时丢失（拖拽从外部进入同时靶子元素）；在这里兑底一次。
          if (hasExternalFiles(e) && !isFileDragging) {
            fileDragDepthRef.current = Math.max(fileDragDepthRef.current, 1);
            setIsFileDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!hasExternalFiles(e)) return;
          fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
          if (fileDragDepthRef.current === 0) setIsFileDragging(false);
        }}
        onDrop={(e) => {
          fileDragDepthRef.current = 0;
          setIsFileDragging(false);
          handleListDrop(e);
        }}
      >
        {/* 拖拽接收提示 Overlay：仅在 isFileDragging=true 时渲染。
            pointer-events: none 让鼠标/拖拽事件穿透到下层，避免拖拽中途 hover
            到 overlay 上触发 leave、导致提示闪烁。 */}
        {isFileDragging && (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6"
            aria-hidden="true"
          >
            {/* 虚线边框：贴边画，明确“接收区域”边界 */}
            <div className="absolute inset-2 rounded-xl border-2 border-dashed border-accent-primary/60" />
            {/* 中央提示卡片 */}
            <div className="relative flex flex-col items-center gap-2 px-5 py-4 rounded-xl bg-app-elevated/95 backdrop-blur-sm shadow-lg border border-accent-primary/30 max-w-[260px] text-center">
              <div className="w-10 h-10 rounded-full bg-accent-primary/15 flex items-center justify-center">
                <FileUp size={20} className="text-accent-primary" />
              </div>
              <p className="text-sm font-medium text-tx-primary">
                {t('noteList.dropToImportTitle', { defaultValue: '释放以导入' })}
              </p>
              <p className="text-xs text-tx-tertiary leading-relaxed">
                {t('noteList.dropToImportHint', {
                  defaultValue: '导入到《{{name}}》・支持 .md / .docx / .txt',
                  name: state.notebooks.find((n) => n.id === state.selectedNotebookId)?.name
                    || t('noteList.notebook', { defaultValue: '当前笔记本' }),
                })}
              </p>
            </div>
          </div>
        )}      <PullToRefresh onRefresh={fetchNotes}>
        {/* 笔记数量较少时使用普通渲染，较多时使用虚拟滚动 */}
        {sortedNotes.length > 100 ? (
          <VirtualNoteList
            notes={sortedNotes}
            activeNoteId={state.activeNote?.id}
            menuState={{ isOpen: menu.isOpen, targetId: menu.targetId }}
            sharedNoteIds={sharedNoteIds}
            selectedIds={selectedIds}
            onSelectNote={handleSelectNote}
            onContextMenu={(e, noteId) => openMenu(e, noteId, "note")}
            canDragSort={canDragSort}
            dragOverNoteId={dragOverNoteId}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            noteCardRefs={noteCardRefs}
            searchQuery={state.searchQuery || undefined}
          />
        ) : (
        <ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0">
        <div className="px-2 pb-2 space-y-1">
          <AnimatePresence>
            {sortedNotes.map((note) => (
              <NoteCard
                key={note.id}
                cardRef={(el) => {
                  if (el) noteCardRefs.current.set(note.id, el);
                  else noteCardRefs.current.delete(note.id);
                }}
                note={note}
                isActive={state.activeNote?.id === note.id}
                isContextTarget={menu.isOpen && menu.targetId === note.id}
                isShared={sharedNoteIds.has(note.id)}
                isSelected={selectedIds.has(note.id)}
                onClick={(e) => handleSelectNote(note.id, e)}
                onContextMenu={(e) => openMenu(e, note.id, "note")}
                draggable={canDragSort}
                onDragStart={(e) => handleDragStart(e, note.id)}
                onDragOver={(e) => handleDragOver(e, note.id)}
                onDragEnd={handleDragEnd}
                onDrop={(e) => handleDrop(e, note.id)}
                isDragOver={dragOverNoteId === note.id}
                onTouchStart={(e) => handleTouchStart(note.id, e)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                searchQuery={state.searchQuery || undefined}
                showNoteTime={showNoteTime}
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
                onClick={() => handleCreateNote("normal")}
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
        )}
      </PullToRefresh>
      </div>

      {/* Mobile FAB - 新建笔记（点击默认普通笔记，长按弹类型选择） */}
      <button
        ref={createMenuAnchorFabRef}
        onClick={() => handleCreateNote("normal")}
        onContextMenu={(e) => {
          e.preventDefault();
          setCreateMenuSource("fab");
          setCreateMenuOpen(true);
        }}
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
        count={moveModal?.noteIds.length || 1}
        currentNotebookId={moveModal?.notebookId || ""}
        notebooks={state.notebooks}
        sourceWorkspaceId={moveModal?.sourceWorkspaceId ?? null}
        onMove={handleMoveNote}
        onClose={() => setMoveModal(null)}
      />

      {/* 新建笔记 - 笔记本选择器 */}
      <NotebookPickerModal
        isOpen={pickerOpen}
        notebooks={state.notebooks}
        onPick={async (nbId) => {
          setPickerOpen(false);
          await createNoteInNotebook(nbId, pendingNoteType);
          setPendingNoteType("normal"); // 用完归位，避免下次默认到 word
        }}
        onClose={() => {
          setPickerOpen(false);
          setPendingNoteType("normal");
        }}
      />

      {/* 新建按钮的下拉（普通笔记 / Word 文档），在 split-button 的 ▾ 旁边 portal 弹出 */}
      {createMenuOpen && createMenuSource && (
        <CreateMenu
          anchorRef={
            createMenuSource === "desktop"
              ? createMenuAnchorDesktopRef
              : createMenuSource === "mobile"
                ? createMenuAnchorMobileRef
                : createMenuAnchorFabRef
          }
          onPick={(type) => {
            void handleCreateNote(type);
          }}
          onClose={() => {
            setCreateMenuOpen(false);
            setCreateMenuSource(null);
          }}
        />
      )}

      {/* AI 批量归类确认面板：扫描完成后弹出，用户逐条审核再执行移动 */}
      <AiClassifyConfirmModal
        plan={pendingClassify}
        onCancel={() => setPendingClassify(null)}
        onToggle={(noteId) => {
          setPendingClassify((prev) =>
            prev ? prev.map((p) => p.noteId === noteId ? { ...p, checked: !p.checked } : p) : prev,
          );
        }}
        onToggleAll={(checked) => {
          setPendingClassify((prev) => prev ? prev.map((p) => ({ ...p, checked })) : prev);
        }}
        onConfirm={confirmClassifyPlan}
      />
    </div>
  );
}
