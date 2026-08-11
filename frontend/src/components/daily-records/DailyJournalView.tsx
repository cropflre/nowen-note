import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  FolderTree,
  Link2,
  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";

import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import DailyJournalContentPreview from "@/components/daily-records/DailyJournalContentPreview";
import {
  extractJournalPreview,
  formatJournalHeading,
  formatLocalDateKey,
  parseLocalDateKey,
  relativeLocalDateKey,
  shiftLocalDateKey,
  shiftLocalMonthKey,
} from "@/lib/dailyRecords";
import { localDateRangeToUtcSqlBounds, parseServerTime } from "@/lib/dateTime";
import {
  checkJournalForScope,
  getOrCreateJournalForScope,
  resolveJournalScope,
  type JournalScope,
} from "@/lib/journalScope";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";
import type { Diary, Note } from "@/types";

interface BacklinkItem {
  sourceNoteId: string;
  sourceBlockId: string | null;
  title: string;
  excerpt: string | null;
  linkText: string | null;
  updatedAt: string;
}

interface DailyJournalViewProps {
  selectedDate: string;
  onDateChange: (dateKey: string) => void;
  onWriteMoment: () => void;
  journalScope: JournalScope;
  onJournalScopeChange: (scope: JournalScope) => void;
  activeWorkspaceId: string | null;
}

function startOfCalendarGrid(dateKey: string): Date {
  const first = parseLocalDateKey(dateKey);
  first.setDate(1);
  const mondayOffset = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - mondayOffset);
  return first;
}

function buildCalendarDays(dateKey: string): Array<{ key: string; currentMonth: boolean }> {
  const selected = parseLocalDateKey(dateKey);
  const month = selected.getMonth();
  const cursor = startOfCalendarGrid(dateKey);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() + index);
    return { key: formatLocalDateKey(date), currentMonth: date.getMonth() === month };
  });
}

function formatMomentTime(value: string): string {
  const date = parseServerTime(value);
  if (!date) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function moodEmoji(value: string): string {
  return ({
    happy: "😊",
    excited: "🥳",
    peaceful: "😌",
    thinking: "🤔",
    tired: "😴",
    sad: "😢",
    angry: "😤",
    sick: "🤒",
    love: "🥰",
    cool: "😎",
    laugh: "🤣",
    shock: "😱",
  } as Record<string, string>)[value] || "💬";
}

function noteListItem(note: Note) {
  return {
    id: note.id,
    userId: note.userId,
    notebookId: note.notebookId,
    workspaceId: note.workspaceId,
    title: note.title,
    contentText: note.contentText || "",
    contentFormat: note.contentFormat,
    isPinned: note.isPinned || 0,
    isFavorite: note.isFavorite || 0,
    isLocked: note.isLocked || 0,
    isArchived: note.isArchived || 0,
    isTrashed: note.isTrashed || 0,
    version: note.version || 0,
    sortOrder: note.sortOrder || 0,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export default function DailyJournalView({
  selectedDate,
  onDateChange,
  onWriteMoment,
  journalScope,
  onJournalScopeChange,
  activeWorkspaceId,
}: DailyJournalViewProps) {
  const actions = useAppActions();
  const [journal, setJournal] = useState<Note | null>(null);
  const [moments, setMoments] = useState<Diary[]>([]);
  const [backlinks, setBacklinks] = useState<BacklinkItem[]>([]);
  const [children, setChildren] = useState<KnowledgeTreeNode[]>([]);
  const [journalNode, setJournalNode] = useState<KnowledgeTreeNode | null>(null);
  const [journalCanWrite, setJournalCanWrite] = useState(true);
  const [journalRole, setJournalRole] = useState<string>("owner");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const [organizingArchive, setOrganizingArchive] = useState(false);
  const [cleaningArchive, setCleaningArchive] = useState(false);
  const [restoringCleanup, setRestoringCleanup] = useState(false);
  const [lastCleanupId, setLastCleanupId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return localStorage.getItem("nowen.journalArchive.lastCleanupId"); } catch { return null; }
  });
  const [reloadToken, setReloadToken] = useState(0);

  const today = relativeLocalDateKey(0);
  const isToday = selectedDate === today;
  const selectedDateObject = useMemo(() => parseLocalDateKey(selectedDate), [selectedDate]);
  const calendarDays = useMemo(() => buildCalendarDays(selectedDate), [selectedDate]);
  const heading = useMemo(() => formatJournalHeading(selectedDate), [selectedDate]);
  const preview = useMemo(
    () => journal ? extractJournalPreview(journal.content || "", journal.contentText || "") : "",
    [journal],
  );

  const loadDay = useCallback(async () => {
    setLoading(true);
    try {
      const range = localDateRangeToUtcSqlBounds({ from: selectedDate, to: selectedDate });
      const treeWorkspaceId = journalScope.kind === "workspace"
        ? journalScope.workspaceId
        : "personal";
      const [check, momentResult, treeResult] = await Promise.all([
        checkJournalForScope(selectedDate, journalScope),
        api.getDiaryTimeline(undefined, 100, range || undefined),
        knowledgeTreeApi.listForWorkspace(treeWorkspaceId).catch(() => ({ nodes: [] as KnowledgeTreeNode[] })),
      ]);

      setMoments(momentResult.items || []);
      setJournalCanWrite(check.canWrite);
      setJournalRole(
        typeof check.role === "string"
          ? check.role
          : journalScope.kind === "workspace" ? "viewer" : "owner",
      );
      if (!check.exists || !check.noteId) {
        setJournal(null);
        setBacklinks([]);
        setChildren([]);
        setJournalNode(null);
        return;
      }

      const note = await api.getNote(check.noteId);
      setJournal(note);

      const node = treeResult.nodes.find(
        (item) => item.resourceType === "note" && item.resourceId === note.id,
      ) || null;
      setJournalNode(node);
      setChildren(node
        ? treeResult.nodes.filter((item) => item.parentId === node.id && item.isDeleted === 0)
        : []);

      try {
        const result = await api.getBacklinks(note.id, 100);
        setBacklinks((result.backlinks || []) as BacklinkItem[]);
      } catch {
        setBacklinks([]);
      }
    } catch (error: any) {
      console.error("[DailyJournalView] load failed:", error);
      toast.error(error?.message || "加载每日记录失败");
    } finally {
      setLoading(false);
    }
  }, [journalScope, selectedDate]);

  useEffect(() => {
    void loadDay();
  }, [loadDay, reloadToken]);

  const openNote = useCallback((note: Note) => {
    const targetWorkspace = note.workspaceId || "personal";
    if (getCurrentWorkspace() !== targetWorkspace) {
      setCurrentWorkspace(targetWorkspace);
      window.dispatchEvent(new CustomEvent("nowen:workspace-changed", {
        detail: { workspaceId: targetWorkspace },
      }));
    }
    actions.setActiveNote(note);
    actions.setSelectedNotebook(note.notebookId);
    actions.setViewMode("notebook");
    actions.setMobileView("editor");
    actions.addNoteToList(noteListItem(note));
  }, [actions]);

  const createOrOpenJournal = useCallback(async () => {
    setCreating(true);
    try {
      const result = await getOrCreateJournalForScope(selectedDate, journalScope);
      const note = await api.getNote(result.id);
      setJournal(note);
      setJournalCanWrite(result.canWrite);
      openNote(note);
      toast.success(result.existed
        ? journalScope.kind === "workspace" ? "已打开工作区日记" : "已打开该日日记"
        : journalScope.kind === "workspace" ? "工作区日记已创建" : "日记已创建");
    } catch (error: any) {
      toast.error(error?.message || "创建日记失败");
    } finally {
      setCreating(false);
    }
  }, [journalScope, openNote, selectedDate]);

  const organizeArchive = useCallback(async () => {
    setOrganizingArchive(true);
    try {
      const result = await api.journals.organizeArchive();
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "journal-archive-organized" },
      }));
      setReloadToken((value) => value + 1);
      const skipped = result.skippedInvalidDate + result.skippedWorkspaceJournal;
      const message = result.moved > 0
        ? `已整理 ${result.moved} 篇日记，新建 ${result.foldersCreated} 个目录`
        : result.organized > 0
          ? "全部日记已经位于正确目录"
          : "没有需要整理的日记";
      toast.success(skipped > 0 ? `${message}，跳过 ${skipped} 篇异常记录` : message);
    } catch (error: any) {
      toast.error(error?.message || "整理日记目录失败");
    } finally {
      setOrganizingArchive(false);
    }
  }, []);

  const cleanupLegacyArchive = useCallback(async () => {
    setCleaningArchive(true);
    try {
      const preview = await api.journals.previewArchiveCleanup();
      if (preview.candidateCount === 0) {
        toast.info(preview.blockedCount > 0
          ? `没有可自动清理的目录，${preview.blockedCount} 个目录因仍有内容或权限配置而保留`
          : "没有发现迁移后遗留的空目录");
        return;
      }

      const visibleNames = preview.candidates.slice(0, 6).map((item) => `• ${item.name}`).join("\n");
      const remaining = preview.candidateCount > 6 ? `\n• 以及另外 ${preview.candidateCount - 6} 个目录` : "";
      const blocked = preview.blockedCount > 0
        ? `\n\n另有 ${preview.blockedCount} 个目录因为仍有笔记、子目录、共享或安全配置而不会清理。`
        : "";
      const confirmed = await confirmDialog({
        title: `清理 ${preview.candidateCount} 个旧空目录？`,
        description: `${visibleNames}${remaining}${blocked}\n\n只会软删除经过迁移历史验证的空叶子目录，不会删除任何笔记。完成后可以撤销。`,
        confirmText: "安全清理",
        cancelText: "取消",
        danger: true,
      });
      if (!confirmed) return;

      const result = await api.journals.cleanupArchive({
        previewToken: preview.previewToken,
        candidateIds: preview.candidates.map((item) => item.id),
      });
      if (result.cleaned > 0) {
        setLastCleanupId(result.cleanupId);
        try { localStorage.setItem("nowen.journalArchive.lastCleanupId", result.cleanupId); } catch {}
      }
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "journal-archive-cleaned" },
      }));
      setReloadToken((value) => value + 1);
      toast.success(result.cleaned > 0
        ? `已安全清理 ${result.cleaned} 个旧空目录，可使用“撤销清理”恢复`
        : "目录已经清理，无需重复操作");
    } catch (error: any) {
      if (error?.status === 409 || /状态已经变化|STALE_PREVIEW/i.test(String(error?.message || ""))) {
        toast.info("目录状态已经变化，请重新点击清理并确认最新预览");
      } else {
        toast.error(error?.message || "清理旧日记目录失败");
      }
    } finally {
      setCleaningArchive(false);
    }
  }, []);

  const restoreLegacyArchiveCleanup = useCallback(async () => {
    if (!lastCleanupId) return;
    setRestoringCleanup(true);
    try {
      const result = await api.journals.restoreArchiveCleanup(lastCleanupId);
      if (result.restored > 0 || result.alreadyActive > 0) {
        setLastCleanupId(null);
        try { localStorage.removeItem("nowen.journalArchive.lastCleanupId"); } catch {}
      }
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "journal-archive-cleanup-restored" },
      }));
      setReloadToken((value) => value + 1);
      toast.success(result.restored > 0
        ? `已恢复 ${result.restored} 个旧目录`
        : "这些目录已经恢复");
    } catch (error: any) {
      toast.error(error?.message || "撤销目录清理失败");
    } finally {
      setRestoringCleanup(false);
    }
  }, [lastCleanupId]);

  const createChildPage = useCallback(async () => {
    if (!journalCanWrite) {
      toast.info("当前工作区角色只能查看，无法创建子页面");
      return;
    }
    if (!journalNode) {
      toast.info("请先创建日记，稍后再添加子页面");
      return;
    }
    setCreatingChild(true);
    try {
      const targetWorkspaceId = journalScope.kind === "workspace"
        ? journalScope.workspaceId
        : "personal";
      const node = await knowledgeTreeApi.createForWorkspace(targetWorkspaceId, {
        parentId: journalNode.id,
        nodeType: "note",
        title: "新建子页面",
      });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "daily-record-child-created" },
      }));
      const note = await api.getNote(node.resourceId);
      openNote(note);
      toast.success("子页面已创建");
    } catch (error: any) {
      toast.error(error?.message || "创建子页面失败");
    } finally {
      setCreatingChild(false);
    }
  }, [journalCanWrite, journalNode, journalScope, openNote]);

  const openLinkedNote = useCallback(async (noteId: string) => {
    try {
      const note = await api.getNote(noteId);
      openNote(note);
    } catch (error: any) {
      toast.error(error?.message || "打开关联页面失败");
    }
  }, [openNote]);

  const monthLabel = `${selectedDateObject.getFullYear()}年${selectedDateObject.getMonth() + 1}月`;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-app-bg">
        <Loader2 size={24} className="animate-spin text-accent-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-app-bg">
      <div className="mx-auto grid w-full max-w-[1320px] grid-cols-1 gap-5 px-4 py-5 xl:grid-cols-[minmax(0,1fr)_320px] xl:px-6">
        <main className="min-w-0 space-y-5">
          {activeWorkspaceId && (
            <div
              data-journal-scope-switch=""
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface px-3 py-2.5"
            >
              <div>
                <div className="text-xs font-semibold text-tx-primary">日记作用域</div>
                <div className="mt-0.5 text-[11px] text-tx-tertiary">个人沉淀与工作区协作互不覆盖</div>
              </div>
              <div className="flex rounded-lg bg-app-hover/70 p-1">
                <button
                  type="button"
                  onClick={() => onJournalScopeChange(resolveJournalScope("personal"))}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium",
                    journalScope.kind === "personal"
                      ? "bg-app-surface text-accent-primary shadow-sm"
                      : "text-tx-tertiary hover:text-tx-primary",
                  )}
                >
                  个人日记
                </button>
                <button
                  type="button"
                  onClick={() => onJournalScopeChange(resolveJournalScope(activeWorkspaceId))}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium",
                    journalScope.kind === "workspace"
                      ? "bg-app-surface text-accent-primary shadow-sm"
                      : "text-tx-tertiary hover:text-tx-primary",
                  )}
                >
                  工作区日记
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface p-1.5">
            <button
              type="button"
              onClick={() => onDateChange(shiftLocalDateKey(selectedDate, -1))}
              className="flex items-center gap-1 rounded-lg px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover"
            >
              <ArrowLeft size={13} /> 前一天
            </button>
            <button
              type="button"
              onClick={() => onDateChange(today)}
              className="mx-auto rounded-lg px-4 py-2 text-xs font-medium text-tx-primary hover:bg-app-hover"
            >
              今天
            </button>
            <button
              type="button"
              onClick={() => onDateChange(shiftLocalDateKey(selectedDate, 1))}
              className="flex items-center gap-1 rounded-lg px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover"
            >
              后一天 <ArrowRight size={13} />
            </button>
          </div>

          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-tx-primary">{heading}</h2>
              {isToday && (
                <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-xs font-medium text-accent-primary">今天</span>
              )}
              {journalScope.kind === "personal" && (
                <>
              <button
                type="button"
                onClick={() => void organizeArchive()}
                disabled={organizingArchive}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:opacity-60"
                title="将已有日记整理到个人日记 / 年 / 月目录"
              >
                {organizingArchive ? <Loader2 size={14} className="animate-spin" /> : <FolderTree size={14} />}
                <span className="hidden sm:inline">整理目录</span>
              </button>
                </>
              )}
              {journalScope.kind === "personal" && (
              <button
                type="button"
                onClick={() => void cleanupLegacyArchive()}
                disabled={cleaningArchive || organizingArchive}
                className="flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:opacity-60"
                title="预览并安全清理迁移后遗留的空旧目录"
              >
                {cleaningArchive ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                <span className="hidden lg:inline">清理空目录</span>
              </button>
              )}
              {journalScope.kind === "personal" && lastCleanupId && (
                <button
                  type="button"
                  onClick={() => void restoreLegacyArchiveCleanup()}
                  disabled={restoringCleanup}
                  className="flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1.5 text-xs font-medium text-accent-primary hover:bg-accent-primary/10 disabled:opacity-60"
                  title="撤销上一次旧目录清理"
                >
                  {restoringCleanup ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                  <span className="hidden lg:inline">撤销清理</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setReloadToken((value) => value + 1)}
                className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                title="刷新"
              >
                <RefreshCw size={15} />
              </button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
              <div className="flex items-center justify-between border-b border-app-border px-5 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
                    <BookOpen size={16} className="text-accent-primary" />
                    今日日记
                  </div>
                  <div className="mt-1 truncate text-[10px] text-tx-tertiary">
                    {journalScope.kind === "workspace" ? "工作区日记" : "个人日记"} / {selectedDateObject.getFullYear()}年 / {selectedDateObject.getFullYear()}年{String(selectedDateObject.getMonth() + 1).padStart(2, "0")}月 / {selectedDate}
                  </div>
                </div>
                {journal && (
                  <button
                    type="button"
                    onClick={() => void createOrOpenJournal()}
                    disabled={creating}
                    className="rounded-lg bg-accent-primary/10 px-3 py-1.5 text-xs font-medium text-accent-primary hover:bg-accent-primary/15 disabled:opacity-60"
                  >
                    打开编辑
                  </button>
                )}
              </div>
              {journal ? (
                <div className="min-h-[190px]">
                  {preview ? (
                    <DailyJournalContentPreview
                      note={journal}
                      onOpenEditor={() => void createOrOpenJournal()}
                      className={creating ? "pointer-events-none opacity-70" : undefined}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void createOrOpenJournal()}
                      disabled={creating}
                      className="flex min-h-[150px] w-full flex-col items-center justify-center px-5 py-5 text-center hover:bg-app-hover/20 disabled:opacity-70"
                    >
                      <Sparkles size={24} className="mb-2 text-accent-primary/60" />
                      <p className="text-sm text-tx-secondary">这一天还没有正文</p>
                      <p className="mt-1 text-xs text-tx-tertiary">点击开始记录或整理当天的瞬间</p>
                    </button>
                  )}
                  <div className="flex items-center gap-2 border-t border-app-border/70 px-5 py-3 text-[11px] text-tx-tertiary">
                    <Clock3 size={12} />
                    <span>{journal.updatedAt ? `更新于 ${new Date(journal.updatedAt).toLocaleString()}` : ""}</span>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[190px] flex-col items-center justify-center px-5 py-8 text-center">
                  <BookOpen size={30} className="mb-3 text-tx-tertiary/50" />
                  <p className="text-sm font-medium text-tx-primary">这一天还没有日记页面</p>
                  <p className="mt-1 text-xs text-tx-tertiary">创建后可写长文、建立双链并添加子页面</p>
                  <button
                    type="button"
                    onClick={() => void createOrOpenJournal()}
                    disabled={creating || !journalCanWrite}
                    className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-60"
                  >
                    {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                    {journalCanWrite ? "创建该日日记" : "当前角色只能查看"}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
                <MessageCircle size={16} className="text-violet-500" /> 当天瞬间
              </h3>
              <button type="button" onClick={onWriteMoment} className="text-xs font-medium text-accent-primary hover:underline">记录瞬间</button>
            </div>
            <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
              {moments.length === 0 ? (
                <button type="button" onClick={onWriteMoment} className="flex w-full flex-col items-center justify-center px-5 py-10 text-center hover:bg-app-hover/20">
                  <MessageCircle size={24} className="mb-2 text-tx-tertiary/50" />
                  <span className="text-sm text-tx-secondary">当天还没有瞬间记录</span>
                  <span className="mt-1 text-xs text-tx-tertiary">快速记下一句话、心情或图片</span>
                </button>
              ) : moments.map((item, index) => (
                <div key={item.id} className={cn("flex items-start gap-3 px-5 py-3.5", index > 0 && "border-t border-app-border")}>
                  <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-tx-tertiary">{formatMomentTime(item.createdAt)}</span>
                  <span className="text-base">{moodEmoji(item.mood)}</span>
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-6 text-tx-secondary">{item.contentText || "媒体记录"}</p>
                  {(item.media?.length || item.images?.length) ? (
                    <span className="rounded-full bg-app-hover px-2 py-0.5 text-[10px] text-tx-tertiary">含媒体</span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-tx-primary">
              <Link2 size={16} className="text-accent-primary" /> 关联页面 / 反向链接
            </h3>
            <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
              {!journal || backlinks.length === 0 ? (
                <div className="px-5 py-9 text-center text-xs text-tx-tertiary">
                  其他笔记链接到这一天后，会自动聚合在这里
                </div>
              ) : backlinks.slice(0, 8).map((item, index) => (
                <button
                  key={`${item.sourceNoteId}-${item.sourceBlockId || index}`}
                  type="button"
                  onClick={() => void openLinkedNote(item.sourceNoteId)}
                  className={cn("flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-app-hover", index > 0 && "border-t border-app-border")}
                >
                  <FileText size={15} className="shrink-0 text-accent-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-tx-primary">{item.title || "无标题笔记"}</div>
                    <div className="mt-0.5 truncate text-[11px] text-tx-tertiary">{item.excerpt || item.linkText || "引用了该日日记"}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </main>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-tx-primary"><CalendarDays size={16} className="text-accent-primary" /> 日历</h3>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => onDateChange(shiftLocalMonthKey(selectedDate, -1))} className="rounded p-1 text-tx-tertiary hover:bg-app-hover"><ChevronLeft size={14} /></button>
                <button type="button" onClick={() => onDateChange(shiftLocalMonthKey(selectedDate, 1))} className="rounded p-1 text-tx-tertiary hover:bg-app-hover"><ChevronRight size={14} /></button>
              </div>
            </div>
            <div className="mb-3 text-sm font-medium text-tx-primary">{monthLabel}</div>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-tx-tertiary">
              {['一','二','三','四','五','六','日'].map((day) => <span key={day} className="py-1">{day}</span>)}
              {calendarDays.map((day) => {
                const date = parseLocalDateKey(day.key);
                const active = day.key === selectedDate;
                return (
                  <button
                    key={day.key}
                    type="button"
                    onClick={() => onDateChange(day.key)}
                    className={cn(
                      "aspect-square rounded-lg text-[11px] transition-colors",
                      active ? "bg-accent-primary text-white" : day.currentMonth ? "text-tx-secondary hover:bg-app-hover" : "text-tx-tertiary/40 hover:bg-app-hover",
                    )}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <h3 className="mb-3 text-sm font-semibold text-tx-primary">当天概览</h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: <MessageCircle size={15} />, value: moments.length, label: "瞬间记录" },
                { icon: <BookOpen size={15} />, value: preview.length, label: "日记字数" },
                { icon: <Link2 size={15} />, value: backlinks.length, label: "关联页面" },
                { icon: <FileText size={15} />, value: children.length, label: "子页面" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl bg-app-hover/50 p-3">
                  <div className="text-accent-primary">{item.icon}</div>
                  <div className="mt-2 text-lg font-semibold tabular-nums text-tx-primary">{item.value}</div>
                  <div className="text-[10px] text-tx-tertiary">{item.label}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-app-border bg-app-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-tx-primary">子页面</h3>
              <button type="button" onClick={() => void createChildPage()} disabled={creatingChild} className="rounded-lg p-1.5 text-accent-primary hover:bg-accent-primary/10 disabled:opacity-50">
                {creatingChild ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              </button>
            </div>
            {children.length === 0 ? (
              <button
                type="button"
                onClick={() => void createChildPage()}
                disabled={!journalCanWrite}
                className="w-full rounded-xl border border-dashed border-app-border px-3 py-5 text-xs text-tx-tertiary hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {journalCanWrite ? "在该日日记下新建工作记录或专题页面" : "当前角色只能查看子页面"}
              </button>
            ) : (
              <div className="space-y-1">
                {children.slice(0, 8).map((child) => (
                  <button key={child.id} type="button" onClick={() => void openLinkedNote(child.resourceId)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary">
                    <FileText size={13} className="text-accent-primary" />
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
