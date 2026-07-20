/**
 * Tiptap/ProseMirror 富文本编辑器的查找/替换面板。
 * 匹配项通过 ProseMirror decorations 高亮；导航时按精确文档坐标滚动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import {
  Search,
  X,
  ChevronUp,
  ChevronDown,
  CaseSensitive,
  WholeWord,
  Regex,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  getSearchNavigationIndex,
  isSearchNavigationUpdate,
  scrollSearchMatchIntoView,
} from "@/lib/searchMatchScroll";

interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  activeIndex: number;
  matches: { from: number; to: number }[];
  deco: DecorationSet;
}

const emptyState: SearchState = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  activeIndex: -1,
  matches: [],
  deco: DecorationSet.empty,
};

export const searchReplacePluginKey = new PluginKey<SearchState>("searchReplace");

function buildRegex(opts: {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}): RegExp | null {
  const { query, caseSensitive, wholeWord, useRegex } = opts;
  if (!query) return null;
  let pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) pattern = `\\b${pattern}\\b`;
  try {
    return new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

function findMatches(doc: any, regex: RegExp): { from: number; to: number }[] {
  const matches: { from: number; to: number }[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    const text: string = node.text ?? "";
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
      });
    }
  });
  return matches;
}

function buildDecoSet(
  doc: any,
  matches: { from: number; to: number }[],
  activeIndex: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, index) => Decoration.inline(match.from, match.to, {
      class: index === activeIndex
        ? "search-match search-match-active"
        : "search-match",
    })),
  );
}

export function createSearchReplaceExtension() {
  return Extension.create({
    name: "searchReplace",
    addProseMirrorPlugins() {
      return [
        new Plugin<SearchState>({
          key: searchReplacePluginKey,
          state: {
            init: () => emptyState,
            apply(tr, prev) {
              const meta = tr.getMeta(searchReplacePluginKey) as Partial<SearchState> | undefined;
              if (meta) {
                // 上一个/下一个只切换当前装饰，不再为长笔记重新扫描全文。
                if (isSearchNavigationUpdate(meta as Record<string, unknown>)) {
                  const activeIndex = prev.matches.length === 0
                    ? -1
                    : Math.max(-1, Math.min(meta.activeIndex ?? -1, prev.matches.length - 1));
                  return {
                    ...prev,
                    activeIndex,
                    deco: buildDecoSet(tr.doc, prev.matches, activeIndex),
                  };
                }

                const next: SearchState = { ...prev, ...meta };
                const regex = buildRegex(next);
                const matches = regex ? findMatches(tr.doc, regex) : [];
                const activeIndex = matches.length === 0
                  ? -1
                  : typeof meta.activeIndex === "number"
                    ? Math.max(-1, Math.min(meta.activeIndex, matches.length - 1))
                    : 0;
                return {
                  ...next,
                  matches,
                  activeIndex,
                  deco: buildDecoSet(tr.doc, matches, activeIndex),
                };
              }

              if (tr.docChanged && prev.query) {
                const regex = buildRegex(prev);
                const matches = regex ? findMatches(tr.doc, regex) : [];
                const activeIndex = matches.length === 0
                  ? -1
                  : Math.min(prev.activeIndex < 0 ? 0 : prev.activeIndex, matches.length - 1);
                return {
                  ...prev,
                  matches,
                  activeIndex,
                  deco: buildDecoSet(tr.doc, matches, activeIndex),
                };
              }

              return {
                ...prev,
                deco: prev.deco.map(tr.mapping, tr.doc),
              };
            },
          },
          props: {
            decorations(state) {
              return searchReplacePluginKey.getState(state)?.deco ?? null;
            },
          },
        }),
      ];
    },
  });
}

interface SearchReplacePanelProps {
  editor: Editor | null;
  open: boolean;
  onClose: () => void;
  editable?: boolean;
}

export function SearchReplacePanel({
  editor,
  open,
  onClose,
  editable = true,
}: SearchReplacePanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const queryInputRef = useRef<HTMLInputElement>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const dispatchQuery = useCallback((next: Partial<SearchState>) => {
    if (!editor) return null;
    const view = editor.view;
    try {
      view.dispatch(view.state.tr.setMeta(searchReplacePluginKey, next));
    } catch (error) {
      console.warn("[SearchReplacePanel] dispatch failed (likely dirty doc):", error);
      return null;
    }
    const state = searchReplacePluginKey.getState(view.state) ?? null;
    if (state) {
      setMatchCount(state.matches.length);
      setActiveIndex(state.activeIndex);
    }
    return state;
  }, [editor]);

  const scrollActiveIntoView = useCallback(() => {
    if (!editor) return;
    const state = searchReplacePluginKey.getState(editor.state);
    if (!state || state.activeIndex < 0) return;
    const match = state.matches[state.activeIndex];
    if (!match) return;

    const top = scrollSearchMatchIntoView({
      view: editor.view,
      match,
      behavior: "auto",
    });

    // 非标准宿主没有可识别的 overflow 容器时，仍以当前高亮 span 兜底。
    if (top === null) {
      editor.view.dom
        .querySelector<HTMLElement>(".search-match-active")
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [editor]);

  const scheduleActiveScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollActiveIntoView();
    });
  }, [scrollActiveIntoView]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    dispatchQuery({ query, caseSensitive, wholeWord, useRegex });
  }, [query, caseSensitive, wholeWord, useRegex, open, dispatchQuery]);

  useEffect(() => {
    if (open) {
      if (editor) {
        const { from, to } = editor.state.selection;
        if (from < to) {
          const selected = editor.state.doc.textBetween(from, to, " ");
          if (selected && selected.length < 100) setQuery(selected);
        }
      }
      requestAnimationFrame(() => {
        queryInputRef.current?.focus();
        queryInputRef.current?.select();
      });
      return;
    }

    if (editor) {
      try {
        editor.view.dispatch(
          editor.view.state.tr.setMeta(searchReplacePluginKey, { query: "" }),
        );
      } catch (error) {
        console.warn("[SearchReplacePanel] clear-on-close dispatch failed:", error);
      }
    }
  }, [open, editor]);

  const goNext = useCallback(() => {
    if (!editor) return;
    const state = searchReplacePluginKey.getState(editor.state);
    if (!state || state.matches.length === 0) return;
    dispatchQuery({
      activeIndex: getSearchNavigationIndex(state.activeIndex, state.matches.length, 1),
    });
    scheduleActiveScroll();
  }, [editor, dispatchQuery, scheduleActiveScroll]);

  const goPrev = useCallback(() => {
    if (!editor) return;
    const state = searchReplacePluginKey.getState(editor.state);
    if (!state || state.matches.length === 0) return;
    dispatchQuery({
      activeIndex: getSearchNavigationIndex(state.activeIndex, state.matches.length, -1),
    });
    scheduleActiveScroll();
  }, [editor, dispatchQuery, scheduleActiveScroll]);

  const replaceCurrent = useCallback(() => {
    if (!editor || matchCount === 0 || activeIndex < 0) return;
    const state = searchReplacePluginKey.getState(editor.state);
    const match = state?.matches[activeIndex];
    if (!match) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: match.from, to: match.to })
      .insertContent(replaceWith)
      .run();
    requestAnimationFrame(() => {
      dispatchQuery({ query, caseSensitive, wholeWord, useRegex });
    });
  }, [
    editor,
    matchCount,
    activeIndex,
    replaceWith,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
    dispatchQuery,
  ]);

  const replaceAll = useCallback(() => {
    if (!editor || matchCount === 0) return;
    const state = searchReplacePluginKey.getState(editor.state);
    if (!state) return;
    const sorted = [...state.matches].sort((a, b) => b.from - a.from);
    const chain = editor.chain().focus();
    sorted.forEach((match) => {
      chain.setTextSelection({ from: match.from, to: match.to }).insertContent(replaceWith);
    });
    chain.run();
    toast.success(
      t("searchReplace.replacedCount", { count: sorted.length })
      || `已替换 ${sorted.length} 处`,
    );
    requestAnimationFrame(() => {
      dispatchQuery({ query, caseSensitive, wholeWord, useRegex });
    });
  }, [
    editor,
    matchCount,
    replaceWith,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
    dispatchQuery,
    t,
  ]);

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) goPrev();
      else goNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const onReplaceKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) replaceAll();
      else replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const regexInvalid = useMemo(() => {
    if (!useRegex || !query) return false;
    try {
      new RegExp(query);
      return false;
    } catch {
      return true;
    }
  }, [useRegex, query]);

  if (!open) return null;

  return (
    <div
      className="absolute top-2 right-3 z-30 flex flex-col gap-1.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-2 w-[340px] max-w-[calc(100vw-1.5rem)]"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <Search size={14} className="text-tx-secondary shrink-0 ml-1" />
        <input
          ref={queryInputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onQueryKeyDown}
          placeholder={t("searchReplace.findPlaceholder") || "查找"}
          className={cn(
            "flex-1 min-w-0 px-2 py-1 text-sm bg-app-surface border border-app-border rounded focus:outline-none focus:ring-1 focus:ring-accent-primary",
            regexInvalid && "border-red-500 focus:ring-red-500",
          )}
        />
        <span className="text-xs text-tx-secondary tabular-nums px-1 shrink-0 min-w-[42px] text-center">
          {regexInvalid
            ? "!"
            : matchCount === 0
              ? "0/0"
              : `${activeIndex + 1}/${matchCount}`}
        </span>
        <button
          type="button"
          onClick={goPrev}
          disabled={matchCount === 0}
          title={t("searchReplace.prev") || "上一个 (Shift+Enter)"}
          className="p-1 rounded hover:bg-app-hover text-tx-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={matchCount === 0}
          title={t("searchReplace.next") || "下一个 (Enter)"}
          className="p-1 rounded hover:bg-app-hover text-tx-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t("searchReplace.close") || "关闭 (Esc)"}
          className="p-1 rounded hover:bg-app-hover text-tx-secondary"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex items-center gap-0.5 px-1">
        <ToggleBtn
          active={caseSensitive}
          onClick={() => setCaseSensitive((value) => !value)}
          title={t("searchReplace.caseSensitive") || "区分大小写"}
        >
          <CaseSensitive size={14} />
        </ToggleBtn>
        <ToggleBtn
          active={wholeWord}
          onClick={() => setWholeWord((value) => !value)}
          title={t("searchReplace.wholeWord") || "全字匹配"}
        >
          <WholeWord size={14} />
        </ToggleBtn>
        <ToggleBtn
          active={useRegex}
          onClick={() => setUseRegex((value) => !value)}
          title={t("searchReplace.regex") || "正则表达式"}
        >
          <Regex size={14} />
        </ToggleBtn>
        {editable && (
          <button
            type="button"
            onClick={() => setShowReplace((value) => !value)}
            className="ml-auto text-xs text-tx-secondary hover:text-tx-primary px-2 py-0.5 rounded hover:bg-app-hover"
          >
            {showReplace
              ? t("searchReplace.hideReplace") || "收起替换"
              : t("searchReplace.showReplace") || "替换…"}
          </button>
        )}
      </div>

      {editable && showReplace && (
        <div className="flex items-center gap-1">
          <span className="w-[14px] shrink-0 ml-1" />
          <input
            type="text"
            value={replaceWith}
            onChange={(event) => setReplaceWith(event.target.value)}
            onKeyDown={onReplaceKeyDown}
            placeholder={t("searchReplace.replacePlaceholder") || "替换为"}
            className="flex-1 min-w-0 px-2 py-1 text-sm bg-app-surface border border-app-border rounded focus:outline-none focus:ring-1 focus:ring-accent-primary"
          />
          <button
            type="button"
            onClick={replaceCurrent}
            disabled={matchCount === 0}
            className="px-2 py-1 text-xs rounded hover:bg-app-hover text-tx-primary disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("searchReplace.replace") || "替换 (Enter)"}
          >
            {t("searchReplace.replace") || "替换"}
          </button>
          <button
            type="button"
            onClick={replaceAll}
            disabled={matchCount === 0}
            className="px-2 py-1 text-xs rounded bg-accent-primary/10 hover:bg-accent-primary/20 text-accent-primary disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("searchReplace.replaceAll") || "全部替换 (Ctrl+Enter)"}
          >
            {t("searchReplace.replaceAll") || "全部"}
          </button>
        </div>
      )}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "p-1 rounded transition-colors",
        active
          ? "bg-accent-primary/20 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
      )}
    >
      {children}
    </button>
  );
}
