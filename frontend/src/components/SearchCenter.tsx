import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Clock3,
  FileCode2,
  FileText,
  Filter,
  Folder,
  Loader2,
  Menu,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions } from "@/store/AppContext";
import { useRailMode } from "@/hooks/useRailMode";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { api } from "@/lib/api";
import { highlightTextNode, sanitizeSearchHtml } from "@/lib/searchHighlight";
import { cn } from "@/lib/utils";
import type { SearchResult } from "@/types";

type MatchFilter = "all" | "title" | "content";
type SortMode = "relevance" | "recent";

type EnhancedSearchResult = SearchResult & {
  matchCount?: number;
  contentFormat?: string;
  notebookName?: string | null;
};

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const handleChange = () => setDesktop(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return desktop;
}

function updateMountedSidebarSearch(value: string): void {
  const input = document.querySelector<HTMLInputElement>("[data-sidebar-search]");
  if (!input || input.value === value) return;

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function normalizeTimestamp(value: string): number {
  if (!value) return 0;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatResultDate(value: string, language: string): string {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) return value || "";
  return new Intl.DateTimeFormat(language.startsWith("zh") ? "zh-CN" : undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

export default function SearchCenter() {
  const { state } = useApp();
  const actions = useAppActions();
  const { loadNote } = useNoteLoader();
  const { i18n } = useTranslation();
  const [railMode] = useRailMode();
  const desktop = useDesktopViewport();
  const language = (i18n.resolvedLanguage || i18n.language || "zh").toLowerCase();
  const isZh = language.startsWith("zh");

  const copy = useMemo(() => (isZh ? {
    title: "全文搜索",
    placeholder: "搜索笔记标题与正文…",
    result: "个搜索结果",
    filteredResult: "个筛选结果",
    all: "全部",
    titleOnly: "仅标题",
    contentOnly: "仅正文",
    relevance: "相关度",
    recent: "最近更新",
    matches: "个匹配项",
    titleMatch: "标题命中",
    contentMatch: "正文命中",
    bothMatch: "标题与正文",
    emptyTitle: "输入关键词开始搜索",
    emptyDescription: "支持标题和正文全文检索，点击结果即可打开笔记。",
    noResultTitle: "没有找到匹配的笔记",
    noResultDescription: "尝试更换关键词，或切换到“全部”范围。",
    loadFailed: "搜索失败，请稍后重试",
    unknownNotebook: "未知笔记本",
    openFailed: "打开笔记失败",
    close: "退出搜索",
    shortcut: "↑↓ 选择 · Enter 打开 · Esc 退出",
  } : {
    title: "Full-text search",
    placeholder: "Search note titles and content…",
    result: " results",
    filteredResult: " filtered results",
    all: "All",
    titleOnly: "Title",
    contentOnly: "Content",
    relevance: "Relevance",
    recent: "Recently updated",
    matches: " matches",
    titleMatch: "Title match",
    contentMatch: "Content match",
    bothMatch: "Title & content",
    emptyTitle: "Type to search your notes",
    emptyDescription: "Search across note titles and content, then open a result in one click.",
    noResultTitle: "No matching notes",
    noResultDescription: "Try another keyword or switch the scope back to All.",
    loadFailed: "Search failed. Please try again.",
    unknownNotebook: "Unknown notebook",
    openFailed: "Failed to open note",
    close: "Exit search",
    shortcut: "↑↓ select · Enter open · Esc exit",
  }), [isZh]);

  const [query, setQuery] = useState(state.searchQuery || "");
  const [results, setResults] = useState<EnhancedSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<MatchFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("relevance");
  const [activeIndex, setActiveIndex] = useState(0);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const requestSequence = useRef(0);

  const isVisible = state.viewMode === "search";
  const railVisible = railMode !== "hidden" || state.sidebarCollapsed;
  const railWidth = railVisible ? (railMode === "label" ? 64 : 48) : 0;
  const desktopLeft = state.editorFullscreen
    ? 0
    : railWidth + (state.sidebarCollapsed ? 0 : state.sidebarWidth + 4);

  useEffect(() => {
    if (state.searchQuery !== query) setQuery(state.searchQuery || "");
  }, [state.searchQuery]);

  useEffect(() => {
    if (!isVisible) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    const normalized = query.trim();
    const sequence = ++requestSequence.current;

    if (!normalized) {
      setResults([]);
      setLoading(false);
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const rows = await api.search(normalized) as EnhancedSearchResult[];
        if (sequence !== requestSequence.current) return;
        setResults(rows);
        setActiveIndex(0);
      } catch (searchError) {
        if (sequence !== requestSequence.current) return;
        console.warn("[SearchCenter] search failed:", searchError);
        setResults([]);
        setError(copy.loadFailed);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    }, 180);

    return () => window.clearTimeout(timer);
  }, [copy.loadFailed, isVisible, query]);

  const notebookPaths = useMemo(() => {
    const notebooks = new Map(state.notebooks.map((notebook) => [notebook.id, notebook]));
    const paths = new Map<string, string>();

    const resolve = (notebookId: string, fallback?: string | null) => {
      if (paths.has(notebookId)) return paths.get(notebookId)!;
      const labels: string[] = [];
      const visited = new Set<string>();
      let currentId: string | null | undefined = notebookId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const notebook = notebooks.get(currentId);
        if (!notebook) break;
        labels.unshift(`${notebook.icon || "📒"} ${notebook.name}`);
        currentId = notebook.parentId;
      }
      const path = labels.length > 0 ? labels.join(" / ") : (fallback || copy.unknownNotebook);
      paths.set(notebookId, path);
      return path;
    };

    for (const result of results) resolve(result.notebookId, result.notebookName);
    return paths;
  }, [copy.unknownNotebook, results, state.notebooks]);

  const visibleResults = useMemo(() => {
    const filtered = results.filter((result) => {
      if (filter === "all") return true;
      if (filter === "title") return result.matchedField === "title" || result.matchedField === "title+content";
      return result.matchedField === "content" || result.matchedField === "title+content";
    });
    if (sortMode === "relevance") return filtered;
    return [...filtered].sort((a, b) => normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt));
  }, [filter, results, sortMode]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(visibleResults.length - 1, 0)));
  }, [visibleResults.length]);

  useEffect(() => {
    const active = visibleResults[activeIndex];
    if (!active) return;
    resultRefs.current.get(active.id)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visibleResults]);

  const setSearchQuery = useCallback((value: string) => {
    setQuery(value);
    actions.setSearchQuery(value);
    if (state.viewMode !== "search") actions.setViewMode("search");
    updateMountedSidebarSearch(value);
  }, [actions, state.viewMode]);

  const exitSearch = useCallback(() => {
    setSearchQuery("");
    actions.setViewMode(state.selectedNotebookId ? "notebook" : "all");
  }, [actions, setSearchQuery, state.selectedNotebookId]);

  const openResult = useCallback(async (result: EnhancedSearchResult) => {
    setOpeningId(result.id);
    actions.setSelectedNotebook(result.notebookId);
    actions.clearSelectedTags();
    actions.setSearchQuery("");
    actions.setViewMode("notebook");
    actions.setMobileSidebar(false);
    actions.setMobileView("editor");
    updateMountedSidebarSearch("");

    await loadNote({
      noteId: result.id,
      summary: {
        title: result.title || copy.emptyTitle,
        notebookId: result.notebookId,
        contentFormat: result.contentFormat,
      },
      request: () => api.getNote(result.id),
      onSuccess: (note) => {
        actions.setActiveNote(note);
        actions.setSelectedNotebook(note.notebookId);
      },
      onError: (openError) => {
        console.error("[SearchCenter] open note failed:", openError);
      },
    });
    setOpeningId((current) => current === result.id ? null : current);
  }, [actions, copy.emptyTitle, loadNote]);

  const onInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      exitSearch();
      return;
    }
    if (visibleResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, visibleResults.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = visibleResults[activeIndex];
      if (active) void openResult(active);
    }
  }, [activeIndex, exitSearch, openResult, visibleResults]);

  useEffect(() => {
    if (!isVisible) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      exitSearch();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [exitSearch, isVisible]);

  if (!isVisible || typeof document === "undefined") return null;

  const content = (
    <section
      className="fixed inset-y-0 right-0 z-[45] flex min-w-0 flex-col overflow-hidden bg-app-bg text-tx-primary"
      style={{ left: desktop ? desktopLeft : 0 }}
      aria-label={copy.title}
      data-swipe-blocker="search-center"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-app-border bg-app-surface/95 px-4 py-3 backdrop-blur-xl md:px-6">
        <button
          type="button"
          onClick={() => actions.setMobileSidebar(true)}
          className="rounded-lg p-2 text-tx-secondary hover:bg-app-hover md:hidden"
          aria-label="Menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
          <Search size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{copy.title}</h1>
          <p className="hidden truncate text-xs text-tx-tertiary sm:block">{copy.shortcut}</p>
        </div>
        <button
          type="button"
          onClick={exitSearch}
          className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          title={copy.close}
          aria-label={copy.close}
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-[1040px] px-4 py-5 md:px-8 md:py-8">
          <div className="rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="flex items-center gap-3 px-4 py-3 md:px-5 md:py-4">
              <Search size={20} className="shrink-0 text-tx-tertiary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={copy.placeholder}
                className="min-w-0 flex-1 bg-transparent text-base text-tx-primary outline-none placeholder:text-tx-tertiary md:text-lg"
                autoComplete="off"
                spellCheck={false}
              />
              {loading && <Loader2 size={18} className="shrink-0 animate-spin text-accent-primary" />}
              {query && !loading && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                  aria-label="Clear"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2 text-sm text-tx-secondary">
              <span className="font-medium tabular-nums text-tx-primary">
                {filter === "all" ? results.length : visibleResults.length}
              </span>
              <span>{filter === "all" ? copy.result : copy.filteredResult}</span>
              {filter !== "all" && results.length !== visibleResults.length && (
                <span className="text-xs text-tx-tertiary">/ {results.length}</span>
              )}
            </div>

            <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
              <div className="inline-flex shrink-0 items-center rounded-lg border border-app-border bg-app-surface p-1">
                <span className="px-1.5 text-tx-tertiary"><Filter size={13} /></span>
                {(["all", "title", "content"] as MatchFilter[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { setFilter(value); setActiveIndex(0); }}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs transition-colors",
                      filter === value
                        ? "bg-accent-primary/12 font-medium text-accent-primary"
                        : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                    )}
                  >
                    {value === "all" ? copy.all : value === "title" ? copy.titleOnly : copy.contentOnly}
                  </button>
                ))}
              </div>

              <div className="inline-flex shrink-0 items-center rounded-lg border border-app-border bg-app-surface p-1">
                <span className="px-1.5 text-tx-tertiary"><SlidersHorizontal size={13} /></span>
                {(["relevance", "recent"] as SortMode[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { setSortMode(value); setActiveIndex(0); }}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs transition-colors",
                      sortMode === value
                        ? "bg-accent-primary/12 font-medium text-accent-primary"
                        : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                    )}
                  >
                    {value === "relevance" ? copy.relevance : copy.recent}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-500">
              {error}
            </div>
          )}

          {!query.trim() ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
                <Search size={26} />
              </div>
              <h2 className="mt-4 text-base font-semibold">{copy.emptyTitle}</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-tx-tertiary">{copy.emptyDescription}</p>
            </div>
          ) : !loading && visibleResults.length === 0 ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-app-surface text-tx-tertiary ring-1 ring-app-border">
                <Search size={25} />
              </div>
              <h2 className="mt-4 text-base font-semibold">{copy.noResultTitle}</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-tx-tertiary">{copy.noResultDescription}</p>
            </div>
          ) : (
            <div className="mt-4 space-y-3 pb-8">
              {visibleResults.map((result, index) => {
                const active = index === activeIndex;
                const snippetHtml = result.snippetHtml || result.snippet || "";
                const matchCount = Math.max(1, result.matchCount || 1);
                const matchedLabel = result.matchedField === "title"
                  ? copy.titleMatch
                  : result.matchedField === "content"
                    ? copy.contentMatch
                    : copy.bothMatch;
                const markdown = result.contentFormat === "markdown";

                return (
                  <button
                    key={result.id}
                    ref={(element) => {
                      if (element) resultRefs.current.set(result.id, element);
                      else resultRefs.current.delete(result.id);
                    }}
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => void openResult(result)}
                    className={cn(
                      "group w-full rounded-2xl border bg-app-surface px-4 py-4 text-left shadow-sm transition-all md:px-5",
                      active
                        ? "border-accent-primary/45 bg-accent-primary/[0.035] shadow-md shadow-black/[0.04]"
                        : "border-app-border hover:border-accent-primary/25 hover:shadow-md hover:shadow-black/[0.035]",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                        markdown ? "bg-emerald-500/10 text-emerald-500" : "bg-accent-primary/10 text-accent-primary",
                      )}>
                        {markdown ? <FileCode2 size={17} /> : <FileText size={17} />}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <h3 className="search-result-html line-clamp-2 break-words text-sm font-semibold leading-6 text-tx-primary md:text-[15px] [&_mark]:rounded-sm [&_mark]:bg-amber-200/80 [&_mark]:px-0.5 [&_mark]:text-amber-950 dark:[&_mark]:bg-amber-400/30 dark:[&_mark]:text-amber-100">
                              {result.titleHtml ? (
                                <span dangerouslySetInnerHTML={{ __html: sanitizeSearchHtml(result.titleHtml) }} />
                              ) : (
                                highlightTextNode(result.title || "(Untitled)", query)
                              )}
                            </h3>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tx-tertiary">
                              <span className="flex min-w-0 max-w-full items-center gap-1" title={notebookPaths.get(result.notebookId)}>
                                <Folder size={11} className="shrink-0" />
                                <span className="truncate">{notebookPaths.get(result.notebookId) || result.notebookName || copy.unknownNotebook}</span>
                              </span>
                              <span className="flex items-center gap-1 whitespace-nowrap">
                                <Clock3 size={11} />
                                {formatResultDate(result.updatedAt, language)}
                              </span>
                              <span className="rounded-full bg-app-hover px-2 py-0.5 text-[10px] text-tx-secondary">
                                {matchedLabel}
                              </span>
                            </div>
                          </div>

                          <span className="inline-flex shrink-0 items-center self-start rounded-full bg-accent-primary/10 px-2.5 py-1 text-[11px] font-medium tabular-nums text-accent-primary">
                            {matchCount}{copy.matches}
                          </span>
                        </div>

                        {snippetHtml && (
                          <div
                            className="search-result-html mt-3 line-clamp-4 break-words rounded-xl border border-app-border/70 bg-app-bg/70 px-3.5 py-3 text-xs leading-6 text-tx-secondary [overflow-wrap:anywhere] [&_mark]:rounded-sm [&_mark]:bg-amber-200/80 [&_mark]:px-0.5 [&_mark]:font-medium [&_mark]:text-amber-950 dark:[&_mark]:bg-amber-400/30 dark:[&_mark]:text-amber-100"
                            dangerouslySetInnerHTML={{ __html: sanitizeSearchHtml(snippetHtml) }}
                          />
                        )}
                      </div>

                      <div className="hidden shrink-0 items-center gap-1 text-tx-tertiary md:flex">
                        {active ? <ArrowDown size={14} className="rotate-[-90deg] text-accent-primary" /> : null}
                        {openingId === result.id && <Loader2 size={14} className="animate-spin text-accent-primary" />}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <footer className="hidden shrink-0 items-center justify-center gap-2 border-t border-app-border bg-app-surface/90 px-4 py-2 text-[11px] text-tx-tertiary backdrop-blur md:flex">
        <ArrowUp size={12} />
        <ArrowDown size={12} />
        <span>{copy.shortcut}</span>
      </footer>
    </section>
  );

  return createPortal(content, document.body);
}
