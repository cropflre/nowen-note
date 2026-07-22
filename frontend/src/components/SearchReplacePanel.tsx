/**
 * SearchReplacePanel —— Tiptap/ProseMirror 富文本编辑器的"查找/替换"面板。
 * ----------------------------------------------------------------------------
 * 设计要点：
 *   - 不依赖第三方扩展，自己写一个 ProseMirror 装饰器插件，避开第三方 v2/v3 兼容
 *     问题；总代码量约 200 行，可控可调。
 *   - 装饰器扫描整个 doc，给每个匹配项打 "search-match" 高亮 class；当前命中项
 *     额外打 "search-match-active"，CSS 用更深的色彩区分。
 *   - 替换走 editor.commands.insertContent + 选区 setTextSelection，避免 mark
 *     污染（保留原有 textStyle/color/fontSize 由用户决定，目前先按"插入纯文本"
 *     处理；如果未来要保留格式，可改为 replaceWith TextNode + 复制原 marks）。
 *   - 区分大小写、整词、正则三个开关；空查询时清空装饰避免无意义全文遍历。
 *
 * 这个文件只对外暴露：
 *   - createSearchReplaceExtension()：Tiptap Extension，挂载装饰器与查询状态
 *   - SearchReplacePanel：浮窗面板组件
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

// ---------------------------------------------------------------------------
// ProseMirror 装饰扩展
// ---------------------------------------------------------------------------

interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  /** 当前命中索引，从 0 开始；-1 表示无命中 */
  activeIndex: number;
  /** 所有命中位置（doc 内的绝对位置） */
  matches: { from: number; to: number }[];
  /** 装饰集，用于编辑器渲染 */
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

/** 把用户输入转成最终的正则 */
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
    return null; // 用户写了非法正则，外层 UI 会提示
  }
}

/** 在整个 doc 中扫描所有匹配，按文本节点逐段切，避免跨节点误匹配 */
function findMatches(doc: any, regex: RegExp): { from: number; to: number }[] {
  const matches: { from: number; to: number }[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    const text: string = node.text ?? "";
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text))) {
      // 防御性处理：零宽匹配（如 /\b/g）会死循环
      if (m.index === regex.lastIndex) {
        regex.lastIndex++;
        continue;
      }
      matches.push({ from: pos + m.index, to: pos + m.index + m[0].length });
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
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === activeIndex ? "search-match search-match-active" : "search-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

/** 创建 Tiptap 扩展：维护查询状态 + 渲染装饰 */
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
              // 外部派发的 setSearchMeta 优先：重新计算 matches + decoSet
              const meta = tr.getMeta(searchReplacePluginKey);
              if (meta) {
                // 仅切换上一个/下一个时复用已有 matches，避免长笔记重复扫描全文。
                if (isSearchNavigationUpdate(meta as Record<string, unknown>)) {
                  const activeIndex = prev.matches.length === 0
                    ? -1
                    : Math.max(-1, Math.min(meta.activeIndex, prev.matches.length - 1));
                  return {
                    ...prev,
                    activeIndex,
                    deco: buildDecoSet(tr.doc, prev.matches, activeIndex),
                  };
                }
                const next: SearchState = { ...prev, ...meta };
                const regex = buildRegex(next);
                const matches = regex ? findMatches(tr.doc, regex) : [];
                let activeIndex = matches.length === 0 ? -1 : 0;
                // 如果是"导航类"更新（next/prev），保留 caller 传入的 activeIndex
                if (typeof meta.activeIndex === "number") {
                  activeIndex = Math.max(-1, Math.min(meta.activeIndex, matches.length - 1));
                }
                return {
                  ...next,
                  matches,
                  activeIndex,
                  deco: buildDecoSet(tr.doc, matches, activeIndex),
                };
              }
              // 文档变化时重新扫描（用户在搜索过程中编辑）
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
              // 仅 mapping decoSet（光标移动/选区变化）
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

// ---------------------------------------------------------------------------
// 浮窗面板组件
// ---------------------------------------------------------------------------

interface SearchReplacePanelProps {
  editor: Editor | null;
  open: boolean;
  onClose: () => void;
  /** 是否允许替换（只读模式可隐藏替换输入框） */
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

  // 派发查询到 PM 插件
  const dispatchQuery = useCallback(
    (next: Partial<SearchState>) => {
      if (!editor) return;
      const view = editor.view;
      // 防御：若编辑器当前 doc 是脏的（未通过 repair），任何 dispatch 都会让
      // appendTransaction 阶段在 contentMatchAt 上崩溃 —— 包 try/catch 让搜索
      // 面板自己降级而不是把整个 React 树带崩。
      try {
        view.dispatch(view.state.tr.setMeta(searchReplacePluginKey, next));
      } catch (e) {
        console.warn("[SearchReplacePanel] dispatch failed (likely dirty doc):", e);
        return;
      }
      // 读最新 state
      const s = searchReplacePluginKey.getState(view.state);
      if (s) {
        setMatchCount(s.matches.length);
        setActiveIndex(s.activeIndex);
      }
    },
    [editor],
  );

  // 用 ProseMirror 的精确坐标定位命中行，避免长代码块只滚动整个 <pre>/<code>。
  const scrollActiveIntoView = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.activeIndex < 0) return;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    const top = scrollSearchMatchIntoView({
      view: editor.view,
      match: m,
      // 连续按 Enter 时立即以最后一次导航为准，避免平滑动画追不上索引。
      behavior: "auto",
    });
    if (top === null) {
      editor.view.dom
        .querySelector<HTMLElement>(".search-match-active")
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [editor]);

  const scheduleActiveScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollActiveIntoView();
    });
  }, [scrollActiveIntoView]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  // query / 选项变化时自动重新搜索
  useEffect(() => {
    if (!open) return;
    dispatchQuery({ query, caseSensitive, wholeWord, useRegex });
  }, [query, caseSensitive, wholeWord, useRegex, open, dispatchQuery]);

  // 打开时聚焦 + 把当前选区文本带进去
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
    } else {
      // 关闭时清空装饰
      if (editor) {
        const view = editor.view;
        try {
          view.dispatch(view.state.tr.setMeta(searchReplacePluginKey, { query: "" }));
        } catch (e) {
          // 脏 doc 场景：忽略即可，下次正常 dispatch 时再清
          console.warn("[SearchReplacePanel] clear-on-close dispatch failed:", e);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const goNext = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.matches.length === 0) return;
    dispatchQuery({
      activeIndex: getSearchNavigationIndex(s.activeIndex, s.matches.length, 1),
    });
    scheduleActiveScroll();
  }, [editor, dispatchQuery, scheduleActiveScroll]);

  const goPrev = useCallback(() => {
    if (!editor) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s || s.matches.length === 0) return;
    dispatchQuery({
      activeIndex: getSearchNavigationIndex(s.activeIndex, s.matches.length, -1),
    });
    scheduleActiveScroll();
  }, [editor, dispatchQuery, scheduleActiveScroll]);

  const replaceCurrent = useCallback(() => {
    if (!editor || matchCount === 0 || activeIndex < 0) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s) return;
    const m = s.matches[activeIndex];
    if (!m) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: m.from, to: m.to })
      .insertContent(replaceWith)
      .run();
    // 替换后重新走查询，自动跳到下一个
    requestAnimationFrame(() => {
      dispatchQuery({ query, caseSensitive, wholeWord, useRegex });
    });
  }, [editor, matchCount, activeIndex, replaceWith, query, caseSensitive, wholeWord, useRegex, dispatchQuery]);

  const replaceAll = useCallback(() => {
    if (!editor || matchCount === 0) return;
    const s = searchReplacePluginKey.getState(editor.state);
    if (!s) return;
    // 倒序替换，避免位置偏移
    const sorted = [...s.matches].sort((a, b) => b.from - a.from);
    const chain = editor.chain().focus();
    sorted.forEach((m) => {
      chain.setTextSelection({ from: m.from, to: m.to }).insertContent(replaceWith);
    });
    chain.run();
    const replaced = sorted.length;
    toast.success(t("searchReplace.replacedCount", { count: replaced }) || `已替换 ${replaced} 处`);
    requestAnimationFrame(() => {
      dispatchQuery({ query, caseSensitive, wholeWord, useRegex });
    });
  }, [editor, matchCount, replaceWith, query, caseSensitive, wholeWord, useRegex, dispatchQuery, t]);

  const onQueryKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) replaceAll();
      else replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
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
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 第一行：查找输入 + 命中计数 + 上下导航 + 关闭 */}
      <div className="flex items-center gap-1">
        <Search size={14} className="text-tx-secondary shrink-0 ml-1" />
        <input
          ref={queryInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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

      {/* 第二行：选项开关 + 展开替换 */}
      <div className="flex items-center gap-0.5 px-1">
        <ToggleBtn
          active={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
          title={t("searchReplace.caseSensitive") || "区分大小写"}
        >
          <CaseSensitive size={14} />
        </ToggleBtn>
        <ToggleBtn
          active={wholeWord}
          onClick={() => setWholeWord((v) => !v)}
          title={t("searchReplace.wholeWord") || "全字匹配"}
        >
          <WholeWord size={14} />
        </ToggleBtn>
        <ToggleBtn
          active={useRegex}
          onClick={() => setUseRegex((v) => !v)}
          title={t("searchReplace.regex") || "正则表达式"}
        >
          <Regex size={14} />
        </ToggleBtn>
        {editable && (
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            className="ml-auto text-xs text-tx-secondary hover:text-tx-primary px-2 py-0.5 rounded hover:bg-app-hover"
          >
            {showReplace
              ? t("searchReplace.hideReplace") || "收起替换"
              : t("searchReplace.showReplace") || "替换…"}
          </button>
        )}
      </div>

      {/* 第三行：替换输入 + 替换按钮（仅展开时显示） */}
      {editable && showReplace && (
        <div className="flex items-center gap-1">
          <span className="w-[14px] shrink-0 ml-1" />
          <input
            type="text"
            value={replaceWith}
            onChange={(e) => setReplaceWith(e.target.value)}
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
