import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Columns2,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Search as SearchIcon,
  X,
} from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { highlightTextNode, sanitizeSearchHtml } from "@/lib/searchHighlight";
import {
  detectShortcutPlatform,
  detectShortcutSurface,
  formatShortcutForCommand,
  isShortcutAllowedInTarget,
  shortcutMatchesEvent,
} from "@/lib/shortcutRegistry";
import type { SearchResult } from "@/types";
import SearchCenter from "@/components/SearchCenter";
import MobileDrawerUxBridge from "@/components/MobileDrawerUxBridge";

export interface CommandPaletteProps {
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

/**
 * Cmd-K global note search and workspace commands.
 *
 * The unified content tree is now the only everyday navigation hierarchy, so
 * the former manage/focus command for restoring a middle note-list column is
 * intentionally absent.
 */
export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const shortcutPlatform = detectShortcutPlatform();
  const shortcutSurface = detectShortcutSurface();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspaceCommands = useMemo<WorkspaceCommand[]>(() => {
    const commands: WorkspaceCommand[] = [];

    if (state.activeNote) {
      commands.push({
        id: "toggle-editor-fullscreen",
        label: state.editorFullscreen ? "退出编辑器全屏" : "进入编辑器全屏",
        description: state.editorFullscreen
          ? "恢复统一内容树和工作台导航"
          : "临时隐藏全部外侧导航，专注当前文档",
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

    return commands.map((command) => {
      const shortcut = formatShortcutForCommand(command.id, shortcutPlatform, shortcutSurface);
      return shortcut ? { ...command, shortcut } : command;
    });
  }, [
    actions,
    state.activeNote,
    state.editorFullscreen,
    state.editorSplit,
    shortcutPlatform,
    shortcutSurface,
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
      if (
        shortcutMatchesEvent("command-palette", event, shortcutPlatform, shortcutSurface)
        && isShortcutAllowedInTarget("command-palette", event.target)
      ) {
        event.preventDefault();
        if (!open) window.dispatchEvent(new CustomEvent("nowen:open-command-palette"));
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, shortcutPlatform, shortcutSurface]);

  const jumpTo = useCallback(async (id: string) => {
    try {
      const note = await api.getNote(id);
      if (note) {
        actions.setActiveNote(note);
        actions.setSelectedNotebook(note.notebookId || null);
        actions.setViewMode("all");
        actions.setMobileView("editor");
        actions.setMobileSidebar(false);
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
              placeholder="搜索笔记，或输入 > 执行命令…"
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
      <MobileDrawerUxBridge />
      <SearchCenter />
      {typeof document !== "undefined" && paletteBody ? createPortal(paletteBody, document.body) : null}
    </>
  );
}
