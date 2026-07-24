import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Eye, Loader2, PanelLeftClose, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import FormatAwareEditorPane from "@/components/FormatAwareEditorPane";
import NoteTabsBar from "@/components/NoteTabsBar";
import NoteLoadingSkeleton from "@/components/NoteLoadingSkeleton";
import TiptapEditor from "@/components/TiptapEditor";
import MarkdownEditor from "@/components/MarkdownEditor";
import type { NoteEditorHandle, NoteEditorUpdatePayload } from "@/components/editors/types";
import { useApp, useAppActions, type NoteLoadingState } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { canWriteNote } from "@/lib/notePermissions";
import type { Note } from "@/types";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { NoteLoadCoordinator, type NoteLoadSink } from "@/lib/noteLoadCoordinator";
import { canApplyRevalidatedNote, loadNoteCacheFirst } from "@/lib/noteLoadSource";
import { loadDraft } from "@/lib/draftStorage";
import {
  clampEditorSplitRatio,
  loadEditorSplitRatio,
  saveEditorSplitRatio,
} from "@/lib/editorWorkspaceLayout";

export default function EditorSplitView() {
  const { state } = useApp();
  const actions = useAppActions();
  const { prefs } = useUserPreferences();
  const split = state.editorSplit;
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef(loadEditorSplitRatio(split?.direction || "right"));
  const [splitRatio, setSplitRatio] = useState(pendingRatioRef.current);
  const [secondaryReadOnly, setSecondaryReadOnly] = useState(false);

  useEffect(() => {
    if (!split) return;
    const savedRatio = loadEditorSplitRatio(split.direction);
    pendingRatioRef.current = savedRatio;
    setSplitRatio(savedRatio);
  }, [split?.direction]);

  useEffect(() => {
    setSecondaryReadOnly(false);
  }, [split?.noteId, split?.direction]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
      }
    };
  }, []);

  const applySplitRatio = useCallback((ratio: number) => {
    pendingRatioRef.current = clampEditorSplitRatio(ratio);
    if (dragRafRef.current !== null) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const primary = `${pendingRatioRef.current * 100}%`;
      const secondary = `${(1 - pendingRatioRef.current) * 100}%`;
      splitContainerRef.current?.style.setProperty("--split-primary", primary);
      splitContainerRef.current?.style.setProperty("--split-secondary", secondary);
    });
  }, []);

  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!split || event.button !== 0) return;
    event.preventDefault();

    const applyRatio = (clientX: number, clientY: number) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw = split.direction === "down"
        ? (clientY - rect.top) / rect.height
        : (clientX - rect.left) / rect.width;
      applySplitRatio(raw);
    };

    applyRatio(event.clientX, event.clientY);
    const cursor = split.direction === "down" ? "row-resize" : "col-resize";
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      applyRatio(moveEvent.clientX, moveEvent.clientY);
    };
    const cleanup = () => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      const finalRatio = saveEditorSplitRatio(split.direction, pendingRatioRef.current);
      splitContainerRef.current?.style.setProperty("--split-primary", `${finalRatio * 100}%`);
      splitContainerRef.current?.style.setProperty("--split-secondary", `${(1 - finalRatio) * 100}%`);
      setSplitRatio(finalRatio);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", cleanup);
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", cleanup);
  }, [applySplitRatio, split]);

  const promoteSecondary = useCallback((secondaryNote: Note) => {
    if (!split || !state.activeNote) return;
    const previousPrimary = state.activeNote;

    actions.setActiveNote(secondaryNote);
    actions.openNoteTab({
      id: secondaryNote.id,
      title: secondaryNote.title,
      notebookId: secondaryNote.notebookId,
      workspaceId: secondaryNote.workspaceId,
      contentFormat: secondaryNote.contentFormat,
      isLocked: secondaryNote.isLocked,
      isTrashed: secondaryNote.isTrashed,
      updatedAt: secondaryNote.updatedAt,
    });

    if (previousPrimary.id === secondaryNote.id) {
      actions.closeEditorSplit();
      return;
    }

    actions.openNoteTab({
      id: previousPrimary.id,
      title: previousPrimary.title,
      notebookId: previousPrimary.notebookId,
      workspaceId: previousPrimary.workspaceId,
      contentFormat: previousPrimary.contentFormat,
      isLocked: previousPrimary.isLocked,
      isTrashed: previousPrimary.isTrashed,
      updatedAt: previousPrimary.updatedAt,
    });
    actions.splitEditor({ noteId: previousPrimary.id, direction: split.direction });
  }, [actions, split, state.activeNote]);

  const hideNoteList = useCallback(() => {
    if (!state.noteListCollapsed) actions.toggleNoteListCollapsed();
  }, [actions, state.noteListCollapsed]);

  if (!split || !state.activeNote) return <FormatAwareEditorPane />;

  const duplicateDocument = split.noteId === state.activeNote.id;
  const effectiveReadOnly = duplicateDocument || secondaryReadOnly;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-app-bg">
      {prefs.enableNoteTabs && <NoteTabsBar />}
      <div
        ref={splitContainerRef}
        style={{
          "--split-primary": `${splitRatio * 100}%`,
          "--split-secondary": `${(1 - splitRatio) * 100}%`,
        } as React.CSSProperties}
        className={cn(
          "flex-1 min-h-0 min-w-0 overflow-hidden",
          split.direction === "down" ? "flex flex-col" : "flex"
        )}
      >
        <div
          className="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden"
          style={{ flexBasis: "var(--split-primary)" }}
        >
          <FormatAwareEditorPane />
        </div>
        <div
          role="separator"
          aria-orientation={split.direction === "down" ? "horizontal" : "vertical"}
          title={split.direction === "down" ? "上下拖动调整分屏" : "左右拖动调整分屏"}
          onMouseDown={startResize}
          className={cn(
            "group relative shrink-0 bg-app-border hover:bg-accent-primary/30 active:bg-accent-primary/40",
            split.direction === "down" ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize"
          )}
        >
          <div
            className={cn(
              "absolute rounded-full bg-transparent transition-colors group-hover:bg-accent-primary/70",
              split.direction === "down"
                ? "left-1/2 top-1/2 h-0.5 w-12 -translate-x-1/2 -translate-y-1/2"
                : "left-1/2 top-1/2 h-12 w-0.5 -translate-x-1/2 -translate-y-1/2"
            )}
          />
        </div>
        <div
          className="min-h-0 min-w-0 flex-none overflow-hidden"
          style={{ flexBasis: "var(--split-secondary)" }}
        >
          <SplitEditorPane
            noteId={split.noteId}
            readOnly={effectiveReadOnly}
            duplicateDocument={duplicateDocument}
            onToggleReadOnly={() => setSecondaryReadOnly((value) => !value)}
            onPromote={promoteSecondary}
            showHideNoteList={!state.noteListCollapsed}
            onHideNoteList={hideNoteList}
          />
        </div>
      </div>
    </div>
  );
}

function createSplitLoadingState(): NoteLoadingState {
  return {
    requestId: 0,
    pendingNoteId: null,
    pendingSummary: null,
    startedAt: null,
    visible: false,
    slow: false,
    error: null,
  };
}

interface SplitEditorPaneProps {
  noteId: string;
  readOnly: boolean;
  duplicateDocument: boolean;
  onToggleReadOnly: () => void;
  onPromote: (note: Note) => void;
  showHideNoteList: boolean;
  onHideNoteList: () => void;
}

function SplitEditorPane({
  noteId,
  readOnly,
  duplicateDocument,
  onToggleReadOnly,
  onPromote,
  showHideNoteList,
  onHideNoteList,
}: SplitEditorPaneProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const { loadNote: loadPrimaryNote } = useNoteLoader();
  const { t } = useTranslation();
  const [note, setNote] = useState<Note | null>(() => state.activeNote?.id === noteId ? state.activeNote : null);
  const [loadingState, setLoadingState] = useState<NoteLoadingState>(createSplitLoadingState);
  const [syncing, setSyncing] = useState(false);
  const coordinatorRef = useRef<NoteLoadCoordinator | null>(null);
  if (!coordinatorRef.current) coordinatorRef.current = new NoteLoadCoordinator();
  const editorHandleRef = useRef<NoteEditorHandle | null>(null);
  const noteRef = useRef<Note | null>(note);
  noteRef.current = note;

  const tabMeta = useMemo(
    () => state.openNoteTabs.find((tab) => tab.id === noteId) || null,
    [noteId, state.openNoteTabs]
  );

  const splitSink = useMemo<NoteLoadSink>(() => ({
    begin: (payload) => setLoadingState({
      requestId: payload.requestId,
      pendingNoteId: payload.noteId,
      pendingSummary: payload.summary,
      startedAt: payload.startedAt,
      visible: false,
      slow: false,
      error: null,
    }),
    show: (requestId) => setLoadingState((current) => current.requestId === requestId
      ? { ...current, visible: true }
      : current),
    markSlow: (requestId) => setLoadingState((current) => current.requestId === requestId
      ? { ...current, slow: true }
      : current),
    finish: (requestId) => setLoadingState((current) => current.requestId === requestId
      ? createSplitLoadingState()
      : current),
    fail: (requestId, error) => setLoadingState((current) => current.requestId === requestId
      ? { ...current, visible: true, slow: false, error }
      : current),
  }), []);

  useEffect(() => {
    const coordinator = coordinatorRef.current!;
    void coordinator.run({
      noteId,
      summary: {
        title: tabMeta?.title || t("editorTabs.noTitle"),
        notebookId: tabMeta?.notebookId || "",
        contentFormat: tabMeta?.contentFormat,
      },
      sink: splitSink,
      request: () => loadNoteCacheFirst({
        noteId,
        fetchRemote: () => api.getNote(noteId),
        onRevalidated: (remote, cached) => {
          if (!canApplyRevalidatedNote({
            current: noteRef.current,
            cached,
            remote,
            hasDraft: !!loadDraft(noteId),
            pendingNoteId: null,
          })) return;
          setNote(remote);
          actions.updateNoteInList({
            id: remote.id,
            title: remote.title,
            contentText: remote.contentText,
            version: remote.version,
            updatedAt: remote.updatedAt,
          });
          actions.updateNoteTab({
            id: remote.id,
            title: remote.title,
            contentFormat: remote.contentFormat,
            isLocked: remote.isLocked,
            isTrashed: remote.isTrashed,
            updatedAt: remote.updatedAt,
          });
        },
      }),
      onSuccess: (loaded) => {
        setNote(loaded);
        actions.openNoteTab({
          id: loaded.id,
          title: loaded.title,
          notebookId: loaded.notebookId,
          workspaceId: loaded.workspaceId,
          contentFormat: loaded.contentFormat,
          isLocked: loaded.isLocked,
          isTrashed: loaded.isTrashed,
          updatedAt: loaded.updatedAt,
          pinned: tabMeta?.pinned,
        });
      },
    });
    return () => coordinator.cancel();
  }, [actions, noteId, splitSink, t]);

  useEffect(() => {
    return () => {
      try { editorHandleRef.current?.flushSave?.(); } catch { /* ignore */ }
    };
  }, [noteId]);

  const handleUpdate = useCallback(async (data: NoteEditorUpdatePayload) => {
    const current = noteRef.current;
    if (
      readOnly ||
      !current ||
      state.activeNote?.id === current.id ||
      !canWriteNote(current) ||
      (data._noteId && data._noteId !== current.id)
    ) return;
    setSyncing(true);
    try {
      const updated = await api.updateNote(current.id, {
        title: data.title,
        content: data.content ?? current.content,
        contentText: data.contentText ?? current.contentText,
        contentFormat: current.contentFormat,
        version: current.version,
      } as any);
      setNote(updated);
      actions.updateNoteInList({
        id: updated.id,
        title: updated.title,
        contentText: updated.contentText,
        updatedAt: updated.updatedAt,
      });
      actions.updateNoteTab({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
        contentFormat: updated.contentFormat,
        isLocked: updated.isLocked,
        isTrashed: updated.isTrashed,
      });
      if (state.activeNote?.id === updated.id) {
        actions.setActiveNote(updated);
      }
    } catch (err: any) {
      toast.error(err?.message || t("editor.saveFailed"));
    } finally {
      setSyncing(false);
    }
  }, [actions, readOnly, state.activeNote?.id, t]);

  const handleOpenNote = useCallback(async (targetNoteId: string) => {
    await loadPrimaryNote({
      noteId: targetNoteId,
      summary: { title: t("editor.noteLoading"), notebookId: "" },
      request: () => api.getNote(targetNoteId),
      onSuccess: (target) => {
        actions.setActiveNote(target);
        actions.openNoteTab({
          id: target.id,
          title: target.title,
          notebookId: target.notebookId,
          workspaceId: target.workspaceId,
          contentFormat: target.contentFormat,
          isLocked: target.isLocked,
          isTrashed: target.isTrashed,
          updatedAt: target.updatedAt,
        });
      },
    });
  }, [actions, loadPrimaryNote, t]);

  const title = note?.id === noteId ? note.title : tabMeta?.title || t("editorTabs.noTitle");
  const editable = !!note
    && note.id === noteId
    && !readOnly
    && state.activeNote?.id !== noteId
    && canWriteNote(note)
    && !note.isLocked
    && !note.isTrashed
    && !loadingState.pendingNoteId;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-app-bg">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-app-border bg-app-surface/60 px-2.5">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-tx-primary">{title}</div>
        {readOnly && (
          <span
            className="hidden shrink-0 rounded border border-app-border bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary sm:inline-flex"
            title={duplicateDocument
              ? t("editorTabs.sameDocumentMirror", { defaultValue: "同文档只读镜像，避免两个编辑器重复保存" })
              : t("editorTabs.readOnlyReference", { defaultValue: "只读参考" })}
          >
            {duplicateDocument
              ? t("editorTabs.mirror", { defaultValue: "镜像" })
              : t("editorTabs.readOnly", { defaultValue: "只读" })}
          </span>
        )}
        {syncing && <Loader2 size={14} className="shrink-0 animate-spin text-tx-tertiary" />}
        {showHideNoteList && (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
            onClick={onHideNoteList}
            title={t("editorTabs.hideNoteListForSplit", { defaultValue: "隐藏中间笔记列表，扩大分屏空间" })}
            aria-label={t("editorTabs.hideNoteListForSplit", { defaultValue: "隐藏中间笔记列表，扩大分屏空间" })}
          >
            <PanelLeftClose size={14} />
          </button>
        )}
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onToggleReadOnly}
          disabled={duplicateDocument}
          aria-pressed={readOnly}
          title={duplicateDocument
            ? t("editorTabs.sameDocumentMirror", { defaultValue: "同文档分屏固定为只读镜像" })
            : readOnly
              ? t("editorTabs.enableSplitEditing", { defaultValue: "允许副屏编辑" })
              : t("editorTabs.useAsReference", { defaultValue: "切换为只读参考" })}
        >
          {readOnly ? <Eye size={14} /> : <Pencil size={14} />}
        </button>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => note && onPromote(note)}
          disabled={!note || duplicateDocument}
          title={t("editorTabs.promoteSplit", { defaultValue: "设为主编辑文档并交换主副屏" })}
          aria-label={t("editorTabs.promoteSplit", { defaultValue: "设为主编辑文档并交换主副屏" })}
        >
          <ArrowLeftRight size={14} />
        </button>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          onClick={() => actions.closeEditorSplit()}
          title={t("editorTabs.closeSplit")}
          aria-label={t("editorTabs.closeSplit")}
        >
          <X size={15} />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loadingState.visible && (
          <NoteLoadingSkeleton
            mode="overlay"
            showHeader={false}
            state={loadingState}
            onRetry={() => { void coordinatorRef.current?.retry(); }}
            loadingLabel={t("editor.noteLoading")}
            errorTitle={t("noteList.loadErrorTitle")}
            errorDescription={t("noteList.loadErrorDesc")}
            retryLabel={t("noteList.retryLoad")}
          />
        )}
        {note ? (
          note.contentFormat === "markdown" ? (
            <MarkdownEditor
              key={`split-md-${note.id}`}
              ref={editorHandleRef}
              note={note}
              onUpdate={handleUpdate}
              editable={editable}
              onOpenNote={handleOpenNote}
            />
          ) : (
            <TiptapEditor
              key={`split-rte-${note.id}`}
              ref={editorHandleRef}
              note={note}
              onUpdate={handleUpdate}
              editable={editable}
              onOpenNote={handleOpenNote}
              searchQuery={state.searchQuery}
            />
          )
        ) : (
          <div className="h-full" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}
