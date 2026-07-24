/**
 * CommandPalette —— Cmd-K 全局搜索与工作台命令
 * ----------------------------------------------------------------------------
 * Sidebar 搜索负责持久化浏览，并由 SearchCenter 展示完整结果页；Cmd-K 仍然保持
 * “即用即走”的快速跳转语义。布局命令与搜索结果共用入口，但不会污染搜索状态。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Columns2,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Search as SearchIcon,
  X,
} from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { highlightTextNode, sanitizeSearchHtml } from "@/lib/searchHighlight";
import {
  emitSidebarSearchSync,
  normalizeSidebarSearchValue,
  SIDEBAR_SEARCH_CHANGE_EVENT,
} from "@/lib/sidebarSearchBridge";
import {
  EDITOR_LAYOUT_TOGGLE_SHORTCUT_LABEL,
  isEditorLayoutToggleShortcut,
} from "@/lib/editorWorkspaceLayout";
import type { SearchResult } from "@/types";
import SearchCenter from "@/components/SearchCenter";
import MobileDrawerUxBridge from "@/components/MobileDrawerUxBridge";

export interface CommandPaletteProps {
  /** 由外部控制开合；App 层一个 useState 即可 */
  open: boolean;
  onClose: () => void;
}

interface WorkspaceCommand {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  shortcut?: string;
  icon: React.ReactNode;
  run: () => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

/**
 * Sidebar 仍保留历史上的本地 searchInput，但不再允许它直接决定 viewMode。
 * 输入组件把真实用户输入发送到这里，由全局 searchQuery 作为唯一业务状态；反向同步
 * 只更新 Sidebar 的显示值，不触发其旧的“空值 → all”分支。
 */
function SidebarSearchStateBridge() {
  const { state } = useApp();
  const actions = useAppActions();
  const focusTimerRef = useRef<number | null>(null);
  const mobileSidebarOpenRef = useRef(state.mobileSidebarOpen);
  const viewModeRef = useRef(state.viewMode);

  useEffect(() => {
    mobileSidebarOpenRef.current = state.mobileSidebarOpen;
    viewModeRef.current = state.viewMode;
  }, [state.mobileSidebarOpen, state.viewMode]);

  useEffect(() => {
    emitSidebarSearchSync(state.searchQuery || "");
  }, [state.mobileSidebarOpen, state.searchQuery, state.sidebarCollapsed]);

  useEffect(() => {
    const handleSidebarSearchChange = (event: Event) => {
      const value = normalizeSidebarSearchValue((event as CustomEvent<unknown>).detail);
      if (value == null) return;

      actions.setSearchQuery(value);
      if (viewModeRef.current !== "search") actions.setViewMode("search");

      // SearchCenter 会在首次进入 search 时自动 focus。移动抽屉仍打开时，稍后把焦点
      // 交还给用户正在使用的 Sidebar 输入框，避免 Android 键盘突然收起或跳到遮罩后。
      if (mobileSidebarOpenRef.current) {
        if (focusTimerRef.current != null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>("[data-sidebar-search]");
          input?.focus({ preventScroll: true });
          focusTimerRef.current = null;
        }, 40);
      }
    };

    window.addEventListener(SIDEBAR_SEARCH_CHANGE_EVENT, handleSidebarSearchChange);
    return () => {
      window.removeEventListener(SIDEBAR_SEARCH_CHANGE_EVENT, handleSidebarSearchChange);
      if (focusTimerRef.current != null) window.clearTimeout(focusTimerRef.current);
    };
  }, [actions]);

  return null;
}

/**
 * 历史兼容守卫：只在“刚离开 search 会话 + 已打开目标笔记 + 查询已清空”这一窄窗口
 * 修正旧版本可能留下的 all 状态。新的 Sidebar bridge 已不会再制造该竞态。
 */
function SearchNavigationGuard() {
  const { state } = useApp();
  const actions = useAppActions();
  const wasSearch = useRef(false);

  useEffect(() => {
    if (state.viewMode === "search") {
      wasSearch.current = true;
      return;
    }
    if (!wasSearch.current || state.searchQuery.trim()) return;

    const openedIntoSelectedNotebook = !!state.activeNote
      && !!state.selectedNotebookId
      && state.activeNote.notebookId === state.selectedNotebookId;

    if (openedIntoSelectedNotebook && state.viewMode === "all") {
      actions.setViewMode("notebook");
    }
    wasSearch.current = false;
  }, [
    actions,
    state.activeNote?.id,
    state.activeNote?.notebookId,
    state.searchQuery,
    state.selectedNotebookId,
    state.viewMode,
  ]);

  return null;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspaceCommands = useMemo<WorkspaceCommand[]>(() => {
    const commands: WorkspaceCommand[] = [
      {
        id: "toggle-note-list",
        label: state.noteListCollapsed ? "显示笔记列表" : "隐藏笔记列表",
        description: state.noteListCollapsed
          ? "恢复管理模式的中间笔记列表"
          : "进入创作模式，让编辑器占满剩余空间",
        keywords: ["布局", "笔记列表", "创作模式", "管理模式", "sidebar", "list"],
        shortcut: EDITOR_LAYOUT_TOGGLE_SHORTCUT_LABEL,
        icon: state.noteListCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />,
        run: actions.toggleNoteListCollapsed,
      },
    ];

    if (state.activeNote) {
      commands.push({
        id: "toggle-editor-fullscreen",
        label: state.editorFullscreen ? "退出编辑器全屏" : "进入编辑器全屏",
        description: state.editorFullscreen
          ? "恢复目录树和笔记列表"
          : "临时隐藏全部外侧导航，不修改面板折叠偏好",
        keywords: ["全屏", "专注", "编辑器", "fullscreen"],
        icon: state.editorFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />,
        run: actions.toggleEditorFullscreen,
      });

      commands.push(
        {
          id: "split-right",
          label: "在右侧分屏参考当前文档",
          description: "创建左右双编辑区；同一文档会自动以只读镜像打开",
          keywords: ["分屏", "右侧", "左右", "split"],
          icon: <Columns2 size={16} />,
          run: () => actions.splitEditor({ noteId: state.activeNote!.id, direction: "right" }),
        },
        {
          id: "split-down",
          label: "在下方分屏参考当前文档",
          description: "创建上下双编辑区；同一文档会自动以只读镜像打开",
          keywords: ["分屏", "下方", "上下", "split"],
          icon: <Columns2 size={16} className="rotate-90" />,
          run: () => actions.splitEditor({ noteId: state.activeNote!.id, direction: "down" }),
        },
      );
    }

    if (state.editorSplit) {
      commands.push({
        id: "close-split",
        label: "关闭分屏",
        description: "副屏文档仍保留在已打开标签页中",
        keywords: ["分屏", "关闭", "split"],
        icon: <X size={16} />,
        run: actions.closeEditorSplit,
      });
    }

    return commands;
  }, [
    actions,
    state.activeNote,
    state.editorFullscreen,
    state.editorSplit,
    state.noteListCollapsed,
  ]);

  const normalizedQuery = query.trim();
  const commandQuery = normalizedQuery.startsWith(">")
    ? normalizedQuery.slice(1).trim().toLowerCase()
    : normalizedQuery.toLowerCase();
  const commandOnly = normalizedQuery.startsWith(">");

  const visibleCommands = useMemo(() => {
    if (!commandQuery) return workspaceCommands;
    return workspaceCommands.filter((command) => {
      const haystack = [command.label, command.description, ...command.keywords].join(" ").toLowerCase();
      return haystack.includes(commandQuery);
    });
  }, [commandQuery, workspaceCommands]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setActiveIdx(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (open) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!normalizedQuery || commandOnly) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      const request = new AbortController();
      abortRef.current?.abort();
      abortRef.current = request;
      try {
        const rows = await api.search(normalizedQuery);
        if (request.signal.aborted) return;
        setResults(rows);
        setActiveIdx(0);
      } catch (error) {
        if (request.signal.aborted) return;
        console.warn("[CommandPalette] search failed:", error);
        setResults([]);
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    }, 200);
  }, [commandOnly, normalizedQuery, open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditorLayoutToggleShortcut(event) && !isEditableTarget(event.target)) {
        event.preventDefault();
        actions.toggleNoteListCollapsed();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!open) window.dispatchEvent(new CustomEvent("nowen:open-command-palette"));
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actions, onClose, open]);

  const jumpTo = useCallback(async (id: string) => {
    try {
      const note = await api.getNote(id);
      if (note) {
        actions.setActiveNote(note);
        actions.setMobileView("editor");
      }
    } catch (error) {
      console.error("[CommandPalette] open note failed:", error);
    } finally {
      onClose();
    }
  }, [actions, onClose]);

  const runCommand = useCallback((command: WorkspaceCommand) => {
    command.run();
    onClose();
  }, [onClose]);

  const onInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && commandOnly && visibleCommands[0]) {
      event.preventDefault();
      runCommand(visibleCommands[0]);
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIdx((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIdx((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeIdx];
      if (result) void jumpTo(result.id);
    }
  }, [activeIdx, commandOnly, jumpTo, results, runCommand, visibleCommands]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, results]);

  const paletteBody = useMemo(() => {
    if (!open) return null;
    const showEmptySearch = normalizedQuery && !commandOnly && results.length === 0 && !loading;
    return (
      <div
        className="fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[15vh]"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" aria-hidden />
        <div
          className="relative w-full max-w-[640px] overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="全局搜索与工作台命令"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-app-border px-4 py-3">
            <SearchIcon size={18} className="shrink-0 text-tx-tertiary" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="搜索笔记，或输入 > 执行布局命令…"
              className="flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
              autoComplete="off"
              spellCheck={false}
            />
            {loading && <Loader2 size={16} className="animate-spin text-tx-tertiary" />}
            <kbd className="hidden h-5 items-center rounded border border-app-border px-1.5 text-[10px] text-tx-tertiary sm:inline-flex">
              Esc
            </kbd>
          </div>

          <div ref={listRef} className="max-h-[56vh] overflow-y-auto py-1">
            {visibleCommands.length > 0 && (
              <section aria-label="工作台命令">
                <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-tx-tertiary">
                  工作台命令
                </div>
                {visibleCommands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    onClick={() => runCommand(command)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-app-hover"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-app-hover text-tx-secondary">
                      {command.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-tx-primary">{command.label}</span>
                      <span className="block truncate text-xs text-tx-tertiary">{command.description}</span>
                    </span>
                    {command.shortcut && (
                      <kbd className="hidden shrink-0 rounded border border-app-border px-1.5 py-0.5 text-[10px] text-tx-tertiary sm:inline-flex">
                        {command.shortcut}
                      </kbd>
                    )}
                  </button>
                ))}
              </section>
            )}

            {!commandOnly && results.length > 0 && (
              <div className="mt-1 border-t border-app-border px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-tx-tertiary">
                笔记搜索结果
              </div>
            )}

            {showEmptySearch && visibleCommands.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-tx-tertiary">
                未找到与 &ldquo;{query}&rdquo; 匹配的笔记或命令
              </div>
            )}

            {!normalizedQuery && (
              <div className="border-t border-app-border px-4 py-3 text-center text-xs text-tx-tertiary">
                输入关键词搜索笔记；输入 &gt; 只筛选命令
              </div>
            )}

            {results.map((result, index) => {
              const active = index === activeIdx;
              const snippetHtml = result.snippetHtml || result.snippet;
              return (
                <button
                  key={result.id}
                  data-idx={index}
                  type="button"
                  onMouseEnter={() => setActiveIdx(index)}
                  onClick={() => void jumpTo(result.id)}
                  className={[
                    "flex w-full items-start gap-3 px-4 py-2 text-left transition-colors",
                    active ? "bg-app-hover" : "hover:bg-app-hover/60",
                  ].join(" ")}
                >
                  <FileText size={16} className="mt-0.5 shrink-0 text-tx-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="search-result-html truncate text-sm text-tx-primary">
                      {result.titleHtml ? (
                        <span dangerouslySetInnerHTML={{ __html: sanitizeSearchHtml(result.titleHtml) }} />
                      ) : (
                        highlightTextNode(result.title || "(无标题)", query)
                      )}
                    </div>
                    {snippetHtml && (
                      <div
                        className="search-result-html mt-0.5 truncate text-xs text-tx-tertiary"
                        dangerouslySetInnerHTML={{ __html: sanitizeSearchHtml(snippetHtml) }}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }, [
    activeIdx,
    commandOnly,
    jumpTo,
    loading,
    normalizedQuery,
    onClose,
    onInputKeyDown,
    open,
    query,
    results,
    runCommand,
    visibleCommands,
  ]);

  return (
    <>
      <SidebarSearchStateBridge />
      <SearchNavigationGuard />
      <MobileDrawerUxBridge />
      <SearchCenter />
      {typeof document !== "undefined" && paletteBody ? createPortal(paletteBody, document.body) : null}
    </>
  );
}
