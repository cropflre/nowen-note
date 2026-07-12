/**
 * MarkdownSlashMenu —— CodeMirror 6 Markdown 编辑器的斜杠命令菜单
 * ----------------------------------------------------------------------------
 * 设计：
 *   - 通过 CM6 的 `updateListener` 识别"当前光标处于 `/xxx` 模式"
 *   - 识别成功时派发一个外部回调，由 React 组件渲染浮层
 *   - 浮层本身是 React Portal（挂到 body），通过 keymap 处理上/下/回车/Esc
 *   - 执行命令后删除用户输入的 `/xxx` 文本，再调用命令
 *
 * 仅在当前"一行中、光标前的片段是 /[\w\u4e00-\u9fff]*、且该片段起点是行首或空格之后"时激活。
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactDOM from "react-dom";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import {
  Bold,
  CheckSquare,
  FileCode,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImagePlus,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
  Sparkles,
  Table2,
} from "lucide-react";
import {
  toggleHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  toggleCodeBlock,
  insertHorizontalRule,
  insertTable,
  toggleWrap,
} from "@/lib/markdownCommands";

// ---------------------------------------------------------------------------
// 命令项定义
// ---------------------------------------------------------------------------

export interface MdSlashItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  category: string;
  keywords: string[];
  /** 命令被触发时执行：此时用户输入的 /xxx 已被删除 */
  run: (view: EditorView) => void;
}

export function getDefaultMdSlashItems(
  t: (key: string) => string,
  opts: { onImageUpload?: () => void; onAIAssistant?: () => void },
): MdSlashItem[] {
  const size = 16;
  return [
    {
      id: "h1",
      label: t("slash.heading1"),
      description: t("slash.heading1Desc"),
      icon: <Heading1 size={size} />,
      category: t("slash.catHeadings"),
      keywords: ["h1", "heading", "title", "标题", "一级"],
      run: (v) => toggleHeading(v, 1),
    },
    {
      id: "h2",
      label: t("slash.heading2"),
      description: t("slash.heading2Desc"),
      icon: <Heading2 size={size} />,
      category: t("slash.catHeadings"),
      keywords: ["h2", "heading", "标题", "二级"],
      run: (v) => toggleHeading(v, 2),
    },
    {
      id: "h3",
      label: t("slash.heading3"),
      description: t("slash.heading3Desc"),
      icon: <Heading3 size={size} />,
      category: t("slash.catHeadings"),
      keywords: ["h3", "heading", "标题", "三级"],
      run: (v) => toggleHeading(v, 3),
    },
    {
      id: "h4",
      label: t("slash.heading4"),
      description: t("slash.heading4Desc"),
      icon: <Heading4 size={size} />,
      category: t("slash.catHeadings"),
      keywords: ["h4", "heading", "标题", "四级"],
      run: (v) => toggleHeading(v, 4),
    },
    {
      id: "h5",
      label: t("slash.heading5"),
      description: t("slash.heading5Desc"),
      icon: <Heading5 size={size} />,
      category: t("slash.catHeadings"),
      keywords: ["h5", "heading", "标题", "五级"],
      run: (v) => toggleHeading(v, 5),
    },
    {
      id: "h6",
      label: t("slash.heading6"),
      description: t("slash.heading6Desc"),
      icon: <Heading6 size={size} />,
      category: t("slash.catHeadings"),
      keywords: ["h6", "heading", "标题", "六级"],
      run: (v) => toggleHeading(v, 6),
    },
    {
      id: "ul",
      label: t("slash.bulletList"),
      description: t("slash.bulletListDesc"),
      icon: <List size={size} />,
      category: t("slash.catLists"),
      keywords: ["ul", "bullet", "list", "无序", "列表"],
      run: (v) => toggleBulletList(v),
    },
    {
      id: "ol",
      label: t("slash.orderedList"),
      description: t("slash.orderedListDesc"),
      icon: <ListOrdered size={size} />,
      category: t("slash.catLists"),
      keywords: ["ol", "ordered", "number", "有序", "编号", "列表"],
      run: (v) => toggleOrderedList(v),
    },
    {
      id: "todo",
      label: t("slash.taskList"),
      description: t("slash.taskListDesc"),
      icon: <CheckSquare size={size} />,
      category: t("slash.catLists"),
      keywords: ["todo", "task", "checkbox", "待办", "任务"],
      run: (v) => toggleTaskList(v),
    },
    {
      id: "quote",
      label: t("slash.blockquote"),
      description: t("slash.blockquoteDesc"),
      icon: <Quote size={size} />,
      category: t("slash.catFormat"),
      keywords: ["quote", "blockquote", "引用"],
      run: (v) => toggleBlockquote(v),
    },
    {
      id: "code",
      label: t("slash.codeBlock"),
      description: t("slash.codeBlockDesc"),
      icon: <FileCode size={size} />,
      category: t("slash.catFormat"),
      keywords: ["code", "codeblock", "代码", "代码块"],
      run: (v) => toggleCodeBlock(v),
    },
    {
      id: "hr",
      label: t("slash.horizontalRule"),
      description: t("slash.horizontalRuleDesc"),
      icon: <Minus size={size} />,
      category: t("slash.catFormat"),
      keywords: ["hr", "divider", "separator", "分割线"],
      run: (v) => insertHorizontalRule(v),
    },
    {
      id: "bold",
      label: t("slash.bold"),
      description: t("slash.boldDesc"),
      icon: <Bold size={size} />,
      category: t("slash.catInline"),
      keywords: ["bold", "strong", "加粗", "粗体"],
      run: (v) => toggleWrap(v, "**"),
    },
    {
      id: "italic",
      label: t("slash.italic"),
      description: t("slash.italicDesc"),
      icon: <Italic size={size} />,
      category: t("slash.catInline"),
      keywords: ["italic", "em", "斜体"],
      run: (v) => toggleWrap(v, "*"),
    },
    {
      id: "image",
      label: t("slash.image"),
      description: t("slash.imageDesc"),
      icon: <ImagePlus size={size} />,
      category: t("slash.catInsert"),
      keywords: ["image", "picture", "photo", "图片", "插图"],
      run: () => opts.onImageUpload?.(),
    },
    {
      id: "table",
      label: t("slash.table"),
      description: t("slash.tableDesc"),
      icon: <Table2 size={size} />,
      category: t("slash.catInsert"),
      keywords: ["table", "grid", "表格"],
      run: (v) => insertTable(v),
    },
    ...(opts.onAIAssistant
      ? [
          {
            id: "ai",
            label: t("slash.ai"),
            description: t("slash.aiDesc"),
            icon: <Sparkles size={size} className="text-violet-500" />,
            category: t("slash.catAI"),
            keywords: ["ai", "assistant", "智能", "助手"],
            run: () => opts.onAIAssistant?.(),
          } as MdSlashItem,
        ]
      : []),
  ];
}

// ---------------------------------------------------------------------------
// CM6 扩展：检测 `/xxx` 并回调外部状态
// ---------------------------------------------------------------------------

export interface SlashState {
  /** true: 菜单应显示 */
  active: boolean;
  /** 用户输入的查询（不含前缀 `/`） */
  query: string;
  /** /xxx 在文档中的起点位置（含 `/`） */
  from: number;
  /** 屏幕坐标，相对视口 */
  coords: { top: number; left: number; bottom: number } | null;
}

export const emptySlashState: SlashState = {
  active: false,
  query: "",
  from: 0,
  coords: null,
};

/**
 * 检测当前光标位置是否处于 `/query` 语境：
 *   - 必须是空选区
 *   - 光标前的文本以 `/` 开头
 *   - `/` 的紧前字符必须是行首或空白
 *   - `/` 和光标之间只能是字母/数字/中日韩字符
 */
function detectSlash(view: EditorView): SlashState {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return emptySlashState;
  const pos = sel.from;
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(line.from, pos);
  // 匹配行内最后一个 `/xxx`
  const m = before.match(/(?:^|\s)(\/[\w\u4e00-\u9fff\u3400-\u4dbf]*)$/);
  if (!m) return emptySlashState;
  const token = m[1];
  const from = pos - token.length;
  const coords = view.coordsAtPos(from);
  return {
    active: true,
    query: token.slice(1),
    from,
    coords: coords
      ? { top: coords.top, left: coords.left, bottom: coords.bottom }
      : null,
  };
}

/**
 * 创建 CM6 扩展：在每次视图更新时检测 slash，并通过回调通知 React 侧。
 * 返回 `[extension, keyHandler]`：
 *   - extension：注册到 EditorState
 *   - keyHandler：键盘事件（上下/回车/Esc）的侦听函数，外部组件通过 addEventListener 使用
 */
export function createSlashPlugin(
  onChange: (state: SlashState) => void,
) {
  return ViewPlugin.define((view) => {
    // 初始就同步一次
    onChange(detectSlash(view));
    return {
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          onChange(detectSlash(u.view));
        }
      },
      destroy() {
        onChange(emptySlashState);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// React 浮层
// ---------------------------------------------------------------------------

interface SlashMenuProps {
  state: SlashState;
  items: MdSlashItem[];
  view: EditorView | null;
  /** 菜单关闭时通知外部（便于外部复位 state） */
  onClose: () => void;
}

export const MarkdownSlashMenu: React.FC<SlashMenuProps> = ({ state, items, view, onClose }) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    if (!state.active) return [];
    const q = state.query.toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      if (item.label.toLowerCase().includes(q)) return true;
      if (item.id.toLowerCase().includes(q)) return true;
      return item.keywords.some((k) => k.toLowerCase().includes(q));
    });
  }, [items, state.active, state.query]);

  // 查询变化后索引复位
  useEffect(() => {
    setActiveIndex(0);
  }, [state.query, state.active]);

  // 滚动保证选中项可见
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const execute = useCallback(
    (item: MdSlashItem) => {
      if (!view) return;
      // 1) 删除用户输入的 "/xxx"
      const endPos = state.from + 1 + state.query.length;
      view.dispatch({
        changes: { from: state.from, to: endPos, insert: "" },
      });
      // 2) 执行命令
      try {
        item.run(view);
      } finally {
        onClose();
      }
    },
    [view, state.from, state.query, onClose],
  );

  // 键盘处理：注入 CM6 的 dom keydown
  useEffect(() => {
    if (!state.active || !view) return;
    const handler = (e: KeyboardEvent) => {
      if (!state.active) return;
      if (filtered.length === 0) {
        if (e.key === "Escape") {
          onClose();
          e.preventDefault();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        execute(filtered[activeIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const dom = view.dom;
    dom.addEventListener("keydown", handler, true);
    return () => dom.removeEventListener("keydown", handler, true);
  }, [state.active, filtered, activeIndex, view, execute, onClose]);

  if (!state.active || !state.coords || filtered.length === 0) return null;

  // 浮层定位：优先显示在当前字符下方，屏幕底部不够时则上移
  const top = state.coords.bottom + 6;
  const left = state.coords.left;

  return ReactDOM.createPortal(
    <div
      className="fixed z-[200] w-72 max-h-72 overflow-y-auto rounded-lg border border-app-border bg-app-surface shadow-xl text-sm"
      style={{ top, left }}
      // 不 stealFocus：用户还在 CM6 里输入
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={listRef} className="py-1">
        {filtered.map((item, idx) => (
          <div
            key={item.id}
            data-idx={idx}
            className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer ${
              idx === activeIndex ? "bg-app-hover" : ""
            }`}
            onMouseEnter={() => setActiveIndex(idx)}
            onClick={() => execute(item)}
          >
            <div className="mt-0.5 text-tx-secondary shrink-0">{item.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="text-tx-primary font-medium leading-5 truncate">{item.label}</div>
              {item.description && (
                <div className="text-[11px] text-tx-tertiary leading-4 truncate">
                  {item.description}
                </div>
              )}
            </div>
            <div className="text-[10px] text-tx-tertiary shrink-0 mt-0.5">{item.category}</div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
};
