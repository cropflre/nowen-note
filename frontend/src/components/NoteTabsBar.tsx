import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FileCode, FileText, Folder, List, Lock, Pin, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions, type OpenNoteTab } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import type { Notebook, NoteListItem } from "@/types";

type TabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
} | null;

type CreateMenuState = {
  x: number;
  y: number;
} | null;

type CreateNoteFormat = "tiptap-json" | "markdown";

type CreateNotebookMenuState = {
  x: number;
  y: number;
  contentFormat: CreateNoteFormat;
} | null;

type TabListMenuState = {
  x: number;
  y: number;
} | null;

type DragInsertTarget = {
  tabId: string;
  edge: "before" | "after";
} | null;

function getNextTabAfterClose(tabs: OpenNoteTab[], closingId: string): OpenNoteTab | null {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index === -1) return null;
  return tabs[index + 1] || tabs[index - 1] || null;
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/]/g, "\\]");
}

function escapeNoteLinkTitle(title: string): string {
  return title
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "｜")
    .replace(/\]/g, "\\]");
}

function buildWikiNoteLink(tab: OpenNoteTab, fallbackTitle: string): string {
  const title = escapeNoteLinkTitle(tab.title || fallbackTitle);
  return `[[note:${tab.id}|${title}]]`;
}

function getNotebookPath(notebooks: Notebook[], notebookId: string): string[] {
  const byId = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const path: string[] = [];
  let cursor: string | null | undefined = notebookId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const notebook = byId.get(cursor);
    if (!notebook) break;
    path.unshift(notebook.name);
    cursor = notebook.parentId ?? null;
  }
  return path;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy copy.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

export default function NoteTabsBar() {
  const { state } = useApp();
  const actions = useAppActions();
  const { loadNote } = useNoteLoader();
  const { t } = useTranslation();
  const { openNoteTabs, activeNote, noteLoading } = state;
  const [contextMenu, setContextMenu] = useState<TabContextMenuState>(null);
  const [createMenu, setCreateMenu] = useState<CreateMenuState>(null);
  const [createNotebookMenu, setCreateNotebookMenu] = useState<CreateNotebookMenuState>(null);
  const [tabListMenu, setTabListMenu] = useState<TabListMenuState>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragInsertTarget, setDragInsertTarget] = useState<DragInsertTarget>(null);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const createNotebookMenuRef = useRef<HTMLDivElement | null>(null);
  const tabListMenuRef = useRef<HTMLDivElement | null>(null);
  const tabListTriggerRef = useRef<HTMLButtonElement | null>(null);
  const suppressClickRef = useRef(false);

  const notebookOptions = useMemo(() => {
    return state.notebooks
      .map((notebook) => ({
        notebook,
        label: getNotebookPath(state.notebooks, notebook.id).join(" / ") || notebook.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [state.notebooks]);

  const validNotebookIds = useMemo(
    () => new Set(state.notebooks.map((notebook) => notebook.id)),
    [state.notebooks]
  );

  const targetTab = useMemo(() => {
    if (!contextMenu) return null;
    return openNoteTabs.find((tab) => tab.id === contextMenu.tabId) || null;
  }, [contextMenu, openNoteTabs]);

  const openNote = useCallback(async (noteId: string) => {
    if (activeNote?.id === noteId) return;
    try { window.dispatchEvent(new CustomEvent("nowen:before-note-switch")); } catch { /* ignore */ }
    const targetTab = openNoteTabs.find((tab) => tab.id === noteId);
    await loadNote({
      noteId,
      summary: {
        title: targetTab?.title || t("editorTabs.noTitle"),
        notebookId: targetTab?.notebookId || "",
        contentFormat: targetTab?.contentFormat,
      },
      request: () => api.getNote(noteId),
      onSuccess: (note) => {
        const existingTab = openNoteTabs.find((tab) => tab.id === note.id);
        actions.setActiveNote(note);
        actions.setMobileView("editor");
        actions.openNoteTab({
          id: note.id,
          title: note.title,
          notebookId: note.notebookId,
          workspaceId: note.workspaceId,
          contentFormat: note.contentFormat,
          isLocked: note.isLocked,
          isTrashed: note.isTrashed,
          updatedAt: note.updatedAt,
          pinned: existingTab?.pinned,
        });
      },
    });
  }, [actions, activeNote?.id, loadNote, openNoteTabs, t]);

  const closeTab = useCallback((noteId: string) => {
    const closingActive = activeNote?.id === noteId;
    const nextTab = closingActive ? getNextTabAfterClose(openNoteTabs, noteId) : null;
    actions.closeNoteTab(noteId);
    if (!closingActive) return;
    if (nextTab) {
      void openNote(nextTab.id);
    } else {
      actions.setActiveNote(null);
    }
  }, [actions, activeNote?.id, openNote, openNoteTabs]);

  const ensureTargetActive = useCallback((tab: OpenNoteTab) => {
    if (activeNote?.id !== tab.id) {
      void openNote(tab.id);
    }
  }, [activeNote?.id, openNote]);

  const closeOtherTabs = useCallback((tab: OpenNoteTab) => {
    actions.setNoteTabs([tab]);
    ensureTargetActive(tab);
  }, [actions, ensureTargetActive]);

  const closeTabsToSide = useCallback((tab: OpenNoteTab, side: "left" | "right") => {
    const targetIndex = openNoteTabs.findIndex((item) => item.id === tab.id);
    if (targetIndex === -1) return;
    const nextTabs = side === "left"
      ? openNoteTabs.slice(targetIndex)
      : openNoteTabs.slice(0, targetIndex + 1);
    const activeKept = !!activeNote && nextTabs.some((item) => item.id === activeNote.id);
    actions.setNoteTabs(nextTabs);
    if (!activeKept) ensureTargetActive(tab);
  }, [actions, activeNote, ensureTargetActive, openNoteTabs]);

  const closeAllTabs = useCallback(() => {
    actions.clearNoteTabs();
    actions.setActiveNote(null);
  }, [actions]);

  const reorderTabs = useCallback((sourceId: string, target: NonNullable<DragInsertTarget>) => {
    if (sourceId === target.tabId) return;
    const source = openNoteTabs.find((tab) => tab.id === sourceId);
    if (!source) return;
    const withoutSource = openNoteTabs.filter((tab) => tab.id !== sourceId);
    const targetIndex = withoutSource.findIndex((tab) => tab.id === target.tabId);
    if (targetIndex === -1) return;
    const insertIndex = target.edge === "before" ? targetIndex : targetIndex + 1;
    const nextTabs = [...withoutSource];
    nextTabs.splice(insertIndex, 0, source);
    actions.setNoteTabs(nextTabs);
  }, [actions, openNoteTabs]);

  const updateDragInsertTarget = useCallback((event: React.DragEvent<HTMLElement>, tabId: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setDragInsertTarget((target) =>
      target?.tabId === tabId && target.edge === edge ? target : { tabId, edge }
    );
  }, []);

  const splitTab = useCallback((tab: OpenNoteTab, direction: "right" | "down") => {
    actions.splitEditor({ noteId: tab.id, direction });
  }, [actions]);

  const createNote = useCallback(async (contentFormat: CreateNoteFormat, notebookId: string) => {
    if (creating) return;

    setCreating(true);
    setCreateMenu(null);
    setCreateNotebookMenu(null);
    try {
      const note = await api.createNote({
        notebookId,
        title: t("common.untitledNote"),
        contentFormat,
        ...(contentFormat === "markdown" ? { content: "", contentText: "" } : {}),
      });
      actions.setActiveNote(note);
      actions.setMobileView("editor");
      actions.openNoteTab({
        id: note.id,
        title: note.title,
        notebookId: note.notebookId,
        workspaceId: note.workspaceId,
        contentFormat: note.contentFormat,
        isLocked: note.isLocked,
        isTrashed: note.isTrashed,
        updatedAt: note.updatedAt,
      });
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
        contentFormat: note.contentFormat,
      } as NoteListItem);
      actions.refreshNotebooks();
      actions.refreshNotes();
    } catch (err: any) {
      toast.error(err?.message || t("noteList.createFailed"));
    } finally {
      setCreating(false);
    }
  }, [
    actions,
    activeNote?.notebookId,
    creating,
    openNoteTabs,
    state.notebooks,
    state.selectedNotebookId,
    t,
  ]);

  const startCreateNote = useCallback((contentFormat: CreateNoteFormat) => {
    const candidateIds = [activeNote?.notebookId, state.selectedNotebookId].filter(Boolean) as string[];
    const notebookId = candidateIds.find((id) => validNotebookIds.has(id));
    if (notebookId) {
      void createNote(contentFormat, notebookId);
      return;
    }
    if (state.notebooks.length === 0) {
      toast.warning(t("common.needNotebookFirst"));
      return;
    }
    setCreateMenu(null);
    setCreateNotebookMenu({
      contentFormat,
      x: createMenu?.x ?? Math.max(8, window.innerWidth / 2 - 144),
      y: createMenu?.y ?? 48,
    });
  }, [
    activeNote?.notebookId,
    createMenu?.x,
    createMenu?.y,
    createNote,
    state.notebooks.length,
    state.selectedNotebookId,
    t,
    validNotebookIds,
  ]);

  const copyFromTab = useCallback(async (
    tab: OpenNoteTab,
    type: "wiki" | "markdown" | "title" | "id" | "path",
  ) => {
    const title = tab.title || t("editorTabs.noTitle");
    const notebookPath = getNotebookPath(state.notebooks, tab.notebookId);
    const value = type === "wiki"
      ? buildWikiNoteLink(tab, t("editorTabs.noTitle"))
      : type === "markdown"
        ? `[${escapeMarkdownLinkText(title)}](note:${tab.id})`
        : type === "title"
          ? title
          : type === "id"
            ? tab.id
            : [...notebookPath, title].join(" / ") || title;
    const ok = await copyText(value);
    ok ? toast.success(t("editorTabs.copySuccess")) : toast.error(t("editorTabs.copyFailed"));
  }, [state.notebooks, t]);

  const togglePinned = useCallback((tab: OpenNoteTab) => {
    actions.updateNoteTab({ id: tab.id, pinned: !tab.pinned });
  }, [actions]);

  const runMenuAction = useCallback((action: () => void) => {
    action();
    setContextMenu(null);
  }, []);

  const runCopyAction = useCallback((action: () => Promise<void>) => {
    void action();
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!contextMenu && !createMenu && !createNotebookMenu && !tabListMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (createMenuRef.current?.contains(event.target as Node)) return;
      if (createNotebookMenuRef.current?.contains(event.target as Node)) return;
      if (tabListMenuRef.current?.contains(event.target as Node)) return;
      if (tabListTriggerRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
      setCreateMenu(null);
      setCreateNotebookMenu(null);
      setTabListMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setCreateMenu(null);
        setCreateNotebookMenu(null);
        setTabListMenu(null);
        if (tabListMenu) {
          window.requestAnimationFrame(() => tabListTriggerRef.current?.focus());
        }
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu, createMenu, createNotebookMenu, tabListMenu]);

  useEffect(() => {
    if (contextMenu && !targetTab) setContextMenu(null);
  }, [contextMenu, targetTab]);

  useLayoutEffect(() => {
    if (!tabListMenu) return;
    const activeItem = tabListMenuRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    const firstItem = tabListMenuRef.current?.querySelector<HTMLButtonElement>("[data-note-tab-id]");
    (activeItem || firstItem)?.focus();
  }, [tabListMenu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "w") return;
      if (isEditableTarget(event.target)) return;
      if (!activeNote || openNoteTabs.length === 0) return;
      event.preventDefault();
      closeTab(activeNote.id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeNote, closeTab, openNoteTabs.length]);

  if (openNoteTabs.length === 0) return null;

  const menuX = contextMenu ? Math.max(8, Math.min(contextMenu.x, window.innerWidth - 236)) : 0;
  const menuY = contextMenu ? Math.max(8, Math.min(contextMenu.y, window.innerHeight - 500)) : 0;
  const createMenuX = createMenu ? Math.max(8, Math.min(createMenu.x, window.innerWidth - 252)) : 0;
  const createMenuY = createMenu ? Math.max(8, Math.min(createMenu.y, window.innerHeight - 180)) : 0;
  const createNotebookMenuX = createNotebookMenu ? Math.max(8, Math.min(createNotebookMenu.x, window.innerWidth - 300)) : 0;
  const createNotebookMenuY = createNotebookMenu ? Math.max(8, Math.min(createNotebookMenu.y, window.innerHeight - 360)) : 0;
  const tabListMenuX = tabListMenu ? Math.max(8, Math.min(tabListMenu.x, window.innerWidth - 296)) : 0;
  const tabListMenuY = tabListMenu ? Math.max(8, Math.min(tabListMenu.y, window.innerHeight - 96)) : 0;

  return (
    <div
      className="hidden md:flex h-9 shrink-0 items-stretch border-b border-app-border bg-app-surface/60 overflow-hidden"
      aria-label={t("editorTabs.openedTabs")}
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden px-2">
        {openNoteTabs.map((tab) => {
          const active = activeNote?.id === tab.id;
          const title = tab.title || t("editorTabs.noTitle");
          return (
            <button
              key={tab.id}
              type="button"
              draggable
              onClick={(e) => {
                if (suppressClickRef.current) {
                  e.preventDefault();
                  return;
                }
                void openNote(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.id);
                }
              }}
              onDragStart={(e) => {
                setContextMenu(null);
                setCreateMenu(null);
                setDraggingTabId(tab.id);
                setDragInsertTarget(null);
                suppressClickRef.current = true;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(e) => {
                if (!draggingTabId || draggingTabId === tab.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                updateDragInsertTarget(e, tab.id);
              }}
              onDragEnter={(e) => {
                if (!draggingTabId || draggingTabId === tab.id) return;
                updateDragInsertTarget(e, tab.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const sourceId = draggingTabId || e.dataTransfer.getData("text/plain");
                if (sourceId && dragInsertTarget) reorderTabs(sourceId, dragInsertTarget);
                setDraggingTabId(null);
                setDragInsertTarget(null);
                window.setTimeout(() => {
                  suppressClickRef.current = false;
                }, 0);
              }}
              onDragEnd={() => {
                setDraggingTabId(null);
                setDragInsertTarget(null);
                window.setTimeout(() => {
                  suppressClickRef.current = false;
                }, 0);
              }}
              className={cn(
                "group relative my-1 mr-1 flex max-w-[180px] min-w-[108px] items-center gap-1.5 rounded-t-md px-2.5 text-xs transition-colors",
                active
                  ? "bg-app-bg text-tx-primary shadow-sm"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                draggingTabId === tab.id && "opacity-45"
              )}
              title={title}
            >
              {dragInsertTarget?.tabId === tab.id && dragInsertTarget.edge === "before" && (
                <span className="pointer-events-none absolute -left-0.5 top-1 bottom-1 z-10 w-0.5 rounded-full bg-accent-primary" />
              )}
              {dragInsertTarget?.tabId === tab.id && dragInsertTarget.edge === "after" && (
                <span className="pointer-events-none absolute -right-0.5 top-1 bottom-1 z-10 w-0.5 rounded-full bg-accent-primary" />
              )}
              {tab.pinned && <Pin size={11} className="shrink-0 text-accent-primary fill-accent-primary/20" />}
              {tab.isLocked ? (
                <Lock size={12} className="shrink-0 text-orange-500" />
              ) : tab.contentFormat === "markdown" ? (
                <FileCode size={12} className="shrink-0 text-emerald-500" />
              ) : (
                <FileText size={12} className="shrink-0 text-tx-tertiary" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{title}</span>
              {active && noteLoading ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary animate-pulse" />
              ) : tab.contentFormat === "markdown" ? (
                <span className="shrink-0 rounded border border-emerald-500/30 px-1 text-[9px] font-mono text-emerald-500">
                  MD
                </span>
              ) : null}
              <span
                role="button"
                tabIndex={-1}
                aria-label={t("editorTabs.close")}
                title={t("editorTabs.close")}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-tx-tertiary opacity-60 hover:bg-app-active hover:text-tx-primary group-hover:opacity-100"
              >
                <X size={11} />
              </span>
              {active && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent-primary" />}
            </button>
          );
        })}
        <button
          type="button"
          className="my-1 mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setContextMenu(null);
            setCreateNotebookMenu(null);
            setCreateMenu((menu) => menu ? null : { x: rect.left, y: rect.bottom + 6 });
          }}
          disabled={creating}
          title={t("editorTabs.newDocument")}
          aria-label={t("editorTabs.newDocument")}
        >
          <Plus size={16} className={creating ? "animate-pulse" : undefined} />
        </button>
      </div>
      <div className="pointer-events-none w-8 bg-gradient-to-r from-transparent to-app-surface/80" />
      <div className="flex shrink-0 items-center border-l border-app-border/70 px-1">
        <button
          ref={tabListTriggerRef}
          type="button"
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setContextMenu(null);
            setCreateMenu(null);
            setCreateNotebookMenu(null);
            setTabListMenu((menu) => menu ? null : {
              x: rect.right - 288,
              y: rect.bottom + 6,
            });
          }}
          aria-label={t("editorTabs.allOpenedTabs")}
          title={t("editorTabs.openedTabCount", { count: openNoteTabs.length })}
          aria-haspopup="dialog"
          aria-expanded={!!tabListMenu}
        >
          <List size={14} />
          <span className="min-w-3 text-center tabular-nums">{openNoteTabs.length}</span>
        </button>
      </div>

      {createMenu && createPortal(
        <div
          ref={createMenuRef}
          className="fixed z-[80] w-60 rounded-xl border border-app-border bg-white py-1.5 shadow-xl dark:bg-zinc-950"
          style={{ left: createMenuX, top: createMenuY }}
          role="menu"
        >
          <CreateMenuItem
            icon={<FileText size={15} />}
            label={t("editorTabs.newRichTextNote")}
            description={t("editorTabs.richTextEditor")}
            onClick={() => startCreateNote("tiptap-json")}
          />
          <CreateMenuItem
            icon={<FileCode size={15} />}
            label={t("editorTabs.newMarkdownNote")}
            description={t("editorTabs.markdownEditor")}
            onClick={() => startCreateNote("markdown")}
          />
        </div>,
        document.body
      )}

      {createNotebookMenu && createPortal(
        <div
          ref={createNotebookMenuRef}
          className="fixed z-[80] w-72 overflow-hidden rounded-xl border border-app-border bg-white shadow-xl dark:bg-zinc-950"
          style={{ left: createNotebookMenuX, top: createNotebookMenuY }}
          role="menu"
        >
          <div className="border-b border-app-border px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-tx-primary">
              <Folder size={15} className="shrink-0 text-accent-primary" />
              <span className="truncate">{t("common.selectNotebook")}</span>
            </div>
            <p className="mt-1 text-xs text-tx-tertiary">{t("common.selectNotebookHint")}</p>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {notebookOptions.map(({ notebook, label }) => (
              <button
                key={notebook.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                onClick={() => void createNote(createNotebookMenu.contentFormat, notebook.id)}
                role="menuitem"
                title={label}
              >
                <span className="shrink-0">{notebook.icon || "📁"}</span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}

      {tabListMenu && createPortal(
        <div
          ref={tabListMenuRef}
          className="fixed z-[80] w-72 overflow-hidden rounded-xl border border-app-border bg-white shadow-xl dark:bg-zinc-950"
          style={{ left: tabListMenuX, top: tabListMenuY }}
          role="dialog"
          aria-modal="false"
          aria-label={t("editorTabs.allOpenedTabs")}
          data-testid="note-tabs-switcher"
        >
          <div className="border-b border-app-border px-3 py-2 text-xs font-medium text-tx-tertiary">
            {t("editorTabs.openedTabCount", { count: openNoteTabs.length })}
          </div>
          <div className="max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto py-1">
            {openNoteTabs.map((tab) => {
              const active = activeNote?.id === tab.id;
              const title = tab.title || t("editorTabs.noTitle");
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group flex items-center px-1.5",
                    active ? "bg-accent-primary/10" : "hover:bg-app-hover",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm text-tx-secondary transition-colors hover:text-tx-primary"
                    onClick={() => {
                      setTabListMenu(null);
                      void openNote(tab.id);
                    }}
                    aria-current={active ? "page" : undefined}
                    data-note-tab-id={tab.id}
                    title={title}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {active ? <Check size={14} className="text-accent-primary" /> : null}
                    </span>
                    {tab.pinned ? (
                      <Pin size={12} className="shrink-0 fill-accent-primary/20 text-accent-primary" />
                    ) : tab.isLocked ? (
                      <Lock size={13} className="shrink-0 text-orange-500" />
                    ) : tab.contentFormat === "markdown" ? (
                      <FileCode size={13} className="shrink-0 text-emerald-500" />
                    ) : (
                      <FileText size={13} className="shrink-0 text-tx-tertiary" />
                    )}
                    <span className={cn("min-w-0 flex-1 truncate", active && "font-medium text-tx-primary")}>{title}</span>
                  </button>
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-tx-tertiary opacity-60 transition-colors hover:bg-app-active hover:text-tx-primary group-hover:opacity-100"
                    onClick={() => closeTab(tab.id)}
                    aria-label={`${t("editorTabs.close")}：${title}`}
                    title={t("editorTabs.close")}
                    data-close-note-tab-id={tab.id}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}

      {contextMenu && targetTab && createPortal(
            <div
              ref={menuRef}
              className="fixed z-[80] w-56 rounded-xl border border-app-border bg-white py-1 shadow-xl dark:bg-zinc-950"
              style={{ left: menuX, top: menuY }}
              role="menu"
            >
          <TabMenuItem label={t("editorTabs.close")} shortcut="Ctrl+W" onClick={() => runMenuAction(() => closeTab(targetTab.id))} />
          <TabMenuItem label={t("editorTabs.closeOtherTabs")} onClick={() => runMenuAction(() => closeOtherTabs(targetTab))} />
          <TabMenuItem label={t("editorTabs.closeTabsToRight")} onClick={() => runMenuAction(() => closeTabsToSide(targetTab, "right"))} />
          <TabMenuItem label={t("editorTabs.closeTabsToLeft")} onClick={() => runMenuAction(() => closeTabsToSide(targetTab, "left"))} />
          <TabMenuItem label={t("editorTabs.closeAllTabs")} onClick={() => runMenuAction(closeAllTabs)} />
          <MenuSeparator />
          <TabMenuItem label={t("editorTabs.splitRight")} onClick={() => runMenuAction(() => splitTab(targetTab, "right"))} />
          <TabMenuItem label={t("editorTabs.splitDown")} onClick={() => runMenuAction(() => splitTab(targetTab, "down"))} />
          <TabMenuItem label={t("editorTabs.closeSplit")} onClick={() => runMenuAction(actions.closeEditorSplit)} />
          <TabMenuItem label={t("editorTabs.closeAllSplits")} onClick={() => runMenuAction(actions.clearEditorSplits)} />
          <MenuSeparator />
          <TabMenuItem label={t("editorTabs.copyWikiLink")} onClick={() => runCopyAction(() => copyFromTab(targetTab, "wiki"))} />
          <TabMenuItem label={t("editorTabs.copyMarkdownLink")} onClick={() => runCopyAction(() => copyFromTab(targetTab, "markdown"))} />
          <TabMenuItem label={t("editorTabs.copyTitle")} onClick={() => runCopyAction(() => copyFromTab(targetTab, "title"))} />
          <TabMenuItem label={t("editorTabs.copyNoteId")} onClick={() => runCopyAction(() => copyFromTab(targetTab, "id"))} />
          <TabMenuItem label={t("editorTabs.copyReadablePath")} onClick={() => runCopyAction(() => copyFromTab(targetTab, "path"))} />
          <MenuSeparator />
          <TabMenuItem
            label={targetTab.pinned ? t("editorTabs.unpinTab") : t("editorTabs.pinTab")}
            onClick={() => runMenuAction(() => togglePinned(targetTab))}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

function MenuSeparator() {
  return <div className="mx-2 my-1 h-px bg-app-border" />;
}

function CreateMenuItem({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-app-hover"
      onClick={onClick}
      role="menuitem"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-tx-tertiary">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-tx-primary">{label}</span>
        <span className="block truncate text-xs text-tx-tertiary">{description}</span>
      </span>
    </button>
  );
}

function TabMenuItem({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center justify-between gap-3 px-3 text-left text-sm text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
      onClick={onClick}
      role="menuitem"
    >
      <span className="truncate">{label}</span>
      {shortcut && <span className="shrink-0 text-xs text-tx-tertiary">{shortcut}</span>}
    </button>
  );
}
