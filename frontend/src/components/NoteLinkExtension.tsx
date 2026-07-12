/**
 * 笔记引用扩展
 *
 * 支持两种触发方式：
 *   - 输入 [[ 触发笔记搜索
 *   - 输入 @ 触发笔记搜索
 *
 * 引用格式：
 *   - 笔记级：href="note:NOTE_ID"
 *   - 块级：href="note:NOTE_ID#blk:BLOCK_ID"
 *
 * 显示为可点击的链接，点击打开目标笔记。
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Editor, Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { FileText, Search, Loader2, ArrowLeft, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6 } from "lucide-react";

// 笔记搜索结果
interface NoteSearchResult {
  id: string;
  title: string;
  notebookId: string;
  updatedAt: string;
}

// 标题块信息
interface HeadingItem {
  blockId: string;
  level: number;
  text: string;
  order: number;
}

// 菜单视图类型
type MenuView = "search" | "headings";

// 笔记引用菜单属性
interface NoteLinkMenuProps {
  editor: Editor;
  position: { top: number; left: number };
  query: string;
  onSelect: (note: NoteSearchResult, heading?: HeadingItem) => void;
  onClose: () => void;
}

// 笔记引用菜单组件
function NoteLinkMenu({ editor, position, query, onSelect, onClose }: NoteLinkMenuProps) {
  const { t } = useTranslation();
  const [results, setResults] = useState<NoteSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // BLOCK-LINKS-UI-01: 两级菜单状态
  const [view, setView] = useState<MenuView>("search");
  const [selectedNote, setSelectedNote] = useState<NoteSearchResult | null>(null);
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [headingsLoading, setHeadingsLoading] = useState(false);
  const [headingsError, setHeadingsError] = useState<string | null>(null);

  // 搜索笔记
  useEffect(() => {
    if (!query && query !== "") return;

    const searchNotes = async () => {
      setLoading(true);
      try {
        const data = await api.searchNotes(query, 10);
        setResults(data || []);
      } catch (err) {
        console.error("Failed to search notes:", err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    };

    // 防抖
    const timer = setTimeout(searchNotes, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // 重置选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, view]);

  // 滚动选中项到可见区域
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // 加载笔记的 headings
  const loadHeadings = useCallback(async (note: NoteSearchResult) => {
    setSelectedNote(note);
    setView("headings");
    setHeadingsLoading(true);
    setHeadingsError(null);
    setHeadings([]);

    try {
      const data = await api.getNoteHeadings(note.id);
      setHeadings(data.headings || []);
    } catch (err) {
      console.error("Failed to load headings:", err);
      setHeadingsError(t("noteLink.headingsLoadError", { defaultValue: "加载标题失败" }));
    } finally {
      setHeadingsLoading(false);
    }
  }, [t]);

  // 返回搜索视图
  const handleBack = useCallback(() => {
    setView("search");
    setSelectedNote(null);
    setHeadings([]);
    setHeadingsError(null);
  }, []);

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const maxIndex = view === "search" ? results.length - 1 : headings.length; // +1 for "引用整篇笔记"
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, maxIndex + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const maxIndex = view === "search" ? results.length - 1 : headings.length;
        setSelectedIndex((prev) => (prev - 1 + maxIndex + 1) % Math.max(1, maxIndex + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (view === "search") {
          if (results[selectedIndex]) {
            loadHeadings(results[selectedIndex]);
          }
        } else {
          // headings 视图：0 = 引用整篇笔记，1+ = 具体 heading
          if (selectedIndex === 0 && selectedNote) {
            onSelect(selectedNote);
          } else if (headings[selectedIndex - 1] && selectedNote) {
            onSelect(selectedNote, headings[selectedIndex - 1]);
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (view === "headings") {
          handleBack();
        } else {
          onClose();
        }
      } else if (e.key === "Backspace" && view === "headings") {
        e.preventDefault();
        handleBack();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [results, selectedIndex, onSelect, onClose, view, headings, selectedNote, loadHeadings, handleBack]);

  // 点击外部关闭
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // 获取标题图标
  const getHeadingIcon = (level: number) => {
    switch (level) {
      case 1: return <Heading1 size={14} />;
      case 2: return <Heading2 size={14} />;
      case 3: return <Heading3 size={14} />;
      case 4: return <Heading4 size={14} />;
      case 5: return <Heading5 size={14} />;
      case 6: return <Heading6 size={14} />;
      default: return <Heading3 size={14} />;
    }
  };

  // 渲染搜索视图
  const renderSearchView = () => (
    <>
      {/* 搜索输入框 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border">
        <Search size={14} className="text-tx-tertiary" />
        <input
          type="text"
          value={query}
          readOnly
          className="flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
          placeholder={t("noteLink.searchPlaceholder", { defaultValue: "搜索笔记..." })}
        />
        {loading && <Loader2 size={14} className="animate-spin text-tx-tertiary" />}
      </div>

      {/* 搜索结果 */}
      <div className="overflow-y-auto max-h-[250px]">
        {results.length === 0 && !loading ? (
          <div className="px-3 py-4 text-center text-xs text-tx-tertiary">
            {t("noteLink.noResults", { defaultValue: "没有找到匹配的笔记" })}
          </div>
        ) : (
          results.map((note, index) => (
            <button
              key={note.id}
              ref={(el) => { itemRefs.current[index] = el; }}
              onClick={() => loadHeadings(note)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
                index === selectedIndex
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-secondary hover:bg-app-hover"
              )}
            >
              <FileText size={14} className="shrink-0" />
              <span className="flex-1 truncate">{note.title}</span>
            </button>
          ))
        )}
      </div>
    </>
  );

  // 渲染标题选择视图
  const renderHeadingsView = () => (
    <>
      {/* 头部：返回按钮 + 笔记标题 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border">
        <button
          onClick={handleBack}
          className="p-1 rounded hover:bg-app-hover transition-colors"
          title={t("noteLink.back", { defaultValue: "返回" })}
        >
          <ArrowLeft size={14} className="text-tx-tertiary" />
        </button>
        <FileText size={14} className="text-tx-tertiary shrink-0" />
        <span className="flex-1 text-xs font-medium text-tx-primary truncate">
          {selectedNote?.title}
        </span>
        {headingsLoading && <Loader2 size={14} className="animate-spin text-tx-tertiary" />}
      </div>

      {/* 标题列表 */}
      <div className="overflow-y-auto max-h-[250px]">
        {/* 引用整篇笔记 */}
        <button
          ref={(el) => { itemRefs.current[0] = el; }}
          onClick={() => selectedNote && onSelect(selectedNote)}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
            0 === selectedIndex
              ? "bg-accent-primary/10 text-accent-primary"
              : "text-tx-secondary hover:bg-app-hover"
          )}
        >
          <FileText size={14} className="shrink-0" />
          <span className="flex-1 truncate">
            {t("noteLink.linkToNote", { defaultValue: "引用整篇笔记" })}
          </span>
        </button>

        {/* 分隔线 */}
        {headings.length > 0 && (
          <div className="border-t border-app-border mx-2" />
        )}

        {/* 标题列表 */}
        {headingsLoading ? (
          <div className="px-3 py-4 text-center text-xs text-tx-tertiary">
            {t("noteLink.loadingHeadings", { defaultValue: "加载标题中..." })}
          </div>
        ) : headingsError ? (
          <div className="px-3 py-4 text-center text-xs text-tx-tertiary">
            {headingsError}
          </div>
        ) : headings.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-tx-tertiary">
            {t("noteLink.noHeadings", { defaultValue: "该笔记暂无标题块" })}
          </div>
        ) : (
          headings.map((heading, index) => {
            const itemIndex = index + 1; // +1 because "引用整篇笔记" is at index 0
            return (
              <button
                key={heading.blockId}
                ref={(el) => { itemRefs.current[itemIndex] = el; }}
                onClick={() => selectedNote && onSelect(selectedNote, heading)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
                  itemIndex === selectedIndex
                    ? "bg-accent-primary/10 text-accent-primary"
                    : "text-tx-secondary hover:bg-app-hover"
                )}
                style={{ paddingLeft: `${12 + (heading.level - 1) * 16}px` }}
              >
                <span className="shrink-0 text-tx-tertiary">
                  {getHeadingIcon(heading.level)}
                </span>
                <span className="flex-1 truncate">{heading.text}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-app-elevated rounded-lg border border-app-border shadow-lg overflow-hidden"
      style={{
        top: position.top,
        left: position.left,
        minWidth: 280,
        maxHeight: 300,
      }}
    >
      {view === "search" ? renderSearchView() : renderHeadingsView()}
    </div>
  );
}

// 笔记引用扩展插件
const noteLinkPluginKey = new PluginKey("noteLink");

export function createNoteLinkExtension(
  onOpenNote: (noteId: string) => void
) {
  return Extension.create({
    name: "noteLink",

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: noteLinkPluginKey,
          props: {
            handleKeyDown: (view, event) => {
              // 检测 [[ 触发
              const { state } = view;
              const { selection } = state;
              const { $from } = selection;

              // 获取当前行文本
              const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
              const isTrigger = textBefore.endsWith("[[");

              if (isTrigger && event.key === "[") {
                // 触发笔记搜索菜单
                // 这里需要通过事件通知外部组件显示菜单
                return false;
              }

              return false;
            },
            handleClick: (view, pos, event) => {
              // 检测点击笔记链接
              const { state } = view;
              const node = state.doc.nodeAt(pos);
              if (!node) return false;

              // 检查是否是带有 note-link 属性的链接
              const marks = node.marks;
              for (const mark of marks) {
                if (mark.type.name === "link") {
                  const href = mark.attrs.href;
                  if (href && href.startsWith("note:")) {
                    // 解析 noteId（忽略 #blk: 部分）
                    const noteId = href.slice(5).split("#")[0];
                    onOpenNote(noteId);
                    return true;
                  }
                }
              }

              return false;
            },
          },
        }),
      ];
    },
  });
}

// 导出菜单组件供外部使用
export { NoteLinkMenu };
export type { NoteSearchResult, HeadingItem };
