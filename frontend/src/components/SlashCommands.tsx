import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { Editor, Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, List, ListOrdered, CheckSquare,
  Quote, FileCode, Minus, ImagePlus, Sparkles,
  Bold, Italic, Highlighter, Table2,
  Strikethrough, Code, Link as LinkIcon, Workflow, Sigma, BookOpen, Film
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { nextFootnoteIdentifier } from "@/components/FootnoteExtensions";
import { prompt as promptDialog } from "@/components/ui/confirm";

export interface SlashCommandItem {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  category: string;
  keywords: string[];
  action: (editor: Editor) => void;
}

interface SlashMenuProps {
  editor: Editor;
  items: SlashCommandItem[];
  query: string;
  position: { top: number; left: number };
  onSelect: (item: SlashCommandItem) => void;
  onClose: () => void;
}

function SlashMenu({ editor, items, query, position, onSelect, onClose }: SlashMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 根据搜索词过滤命令
  const filteredItems = items.filter((item) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.keywords.some((kw) => kw.toLowerCase().includes(q)) ||
      item.id.toLowerCase().includes(q)
    );
  });

  // 按分类分组
  const categories = Array.from(new Set(filteredItems.map((i) => i.category)));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 滚动选中项到可见区域
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          onSelect(filteredItems[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [filteredItems, selectedIndex, onSelect, onClose]);

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

  if (filteredItems.length === 0) {
    return (
      <div
        ref={menuRef}
        className="fixed z-[60] w-[280px] bg-app-elevated border border-app-border rounded-xl shadow-2xl p-3"
        style={{ top: position.top, left: position.left }}
      >
        <p className="text-xs text-tx-tertiary text-center py-2">无匹配命令</p>
      </div>
    );
  }

  let flatIndex = 0;

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] w-[280px] max-h-[320px] overflow-y-auto bg-app-elevated border border-app-border rounded-xl shadow-2xl py-1.5"
      style={{ top: position.top, left: position.left }}
    >
      {categories.map((cat) => {
        const catItems = filteredItems.filter((i) => i.category === cat);
        return (
          <div key={cat}>
            <div className="px-3 pt-2 pb-1">
              <span className="text-[10px] font-medium text-tx-tertiary uppercase tracking-wider">{cat}</span>
            </div>
            {catItems.map((item) => {
              const idx = flatIndex++;
              return (
                <button
                  key={item.id}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                    idx === selectedIndex
                      ? "bg-accent-primary/10 text-accent-primary"
                      : "text-tx-secondary hover:bg-app-hover"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors",
                    idx === selectedIndex ? "bg-accent-primary/15" : "bg-app-hover"
                  )}>
                    {item.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{item.label}</div>
                    <div className="text-[10px] text-tx-tertiary truncate">{item.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// 获取默认的斜杠命令列表
export function getDefaultSlashCommands(t: (key: string) => string, onImageUpload?: () => void, onAIAssistant?: () => void): SlashCommandItem[] {
  return [
    // 标题
    {
      id: "heading1",
      label: t("slash.heading1"),
      description: t("slash.heading1Desc"),
      icon: <Heading1 size={16} />,
      category: t("slash.catHeadings"),
      keywords: ["h1", "heading", "title", "标题", "一级"],
      action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      id: "heading2",
      label: t("slash.heading2"),
      description: t("slash.heading2Desc"),
      icon: <Heading2 size={16} />,
      category: t("slash.catHeadings"),
      keywords: ["h2", "heading", "subtitle", "标题", "二级"],
      action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: "heading3",
      label: t("slash.heading3"),
      description: t("slash.heading3Desc"),
      icon: <Heading3 size={16} />,
      category: t("slash.catHeadings"),
      keywords: ["h3", "heading", "标题", "三级"],
      action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      id: "heading4",
      label: t("slash.heading4"),
      description: t("slash.heading4Desc"),
      icon: <Heading4 size={16} />,
      category: t("slash.catHeadings"),
      keywords: ["h4", "heading", "标题", "四级"],
      action: (editor) => editor.chain().focus().toggleHeading({ level: 4 }).run(),
    },
    {
      id: "heading5",
      label: t("slash.heading5"),
      description: t("slash.heading5Desc"),
      icon: <Heading5 size={16} />,
      category: t("slash.catHeadings"),
      keywords: ["h5", "heading", "标题", "五级"],
      action: (editor) => editor.chain().focus().toggleHeading({ level: 5 }).run(),
    },
    {
      id: "heading6",
      label: t("slash.heading6"),
      description: t("slash.heading6Desc"),
      icon: <Heading6 size={16} />,
      category: t("slash.catHeadings"),
      keywords: ["h6", "heading", "标题", "六级"],
      action: (editor) => editor.chain().focus().toggleHeading({ level: 6 }).run(),
    },
    // 列表
    {
      id: "bulletList",
      label: t("slash.bulletList"),
      description: t("slash.bulletListDesc"),
      icon: <List size={16} />,
      category: t("slash.catLists"),
      keywords: ["ul", "bullet", "list", "无序", "列表"],
      action: (editor) => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: "orderedList",
      label: t("slash.orderedList"),
      description: t("slash.orderedListDesc"),
      icon: <ListOrdered size={16} />,
      category: t("slash.catLists"),
      keywords: ["ol", "ordered", "number", "有序", "编号", "列表"],
      action: (editor) => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: "taskList",
      label: t("slash.taskList"),
      description: t("slash.taskListDesc"),
      icon: <CheckSquare size={16} />,
      category: t("slash.catLists"),
      keywords: ["todo", "task", "checkbox", "待办", "任务", "复选"],
      action: (editor) => editor.chain().focus().toggleTaskList().run(),
    },
    // 格式
    {
      id: "blockquote",
      label: t("slash.blockquote"),
      description: t("slash.blockquoteDesc"),
      icon: <Quote size={16} />,
      category: t("slash.catFormat"),
      keywords: ["quote", "blockquote", "引用"],
      action: (editor) => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      id: "codeBlock",
      label: t("slash.codeBlock"),
      description: t("slash.codeBlockDesc"),
      icon: <FileCode size={16} />,
      category: t("slash.catFormat"),
      keywords: ["code", "codeblock", "代码", "代码块"],
      action: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      // mermaid 流程图：本质是 codeBlock + language=mermaid，CodeBlockView
      // 识别该 language 后会切换到流程图渲染模式。这里塞一段最小可渲染示例，
      // 让用户一插入就能看到结果，再按需修改。
      id: "mermaid",
      label: t("slash.mermaid"),
      description: t("slash.mermaidDesc"),
      icon: <Workflow size={16} />,
      category: t("slash.catFormat"),
      keywords: ["mermaid", "flowchart", "diagram", "graph", "流程", "流程图", "图表"],
      action: (editor) => {
        const sample = "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[继续]\n  B -->|否| D[结束]";
        editor
          .chain()
          .focus()
          .insertContent({
            type: "codeBlock",
            attrs: { language: "mermaid" },
            content: [{ type: "text", text: sample }],
          })
          .run();
      },
    },
    {
      // LaTeX 数学公式（块级）：插入一个空的 mathBlock 节点，自动进入编辑态
      // 让用户立即输入公式源码。行内公式由 input rule `$..$ ` 触发，不在
      // slash 菜单里另开命令避免冗余。
      id: "math",
      label: t("slash.math"),
      description: t("slash.mathDesc"),
      icon: <Sigma size={16} />,
      category: t("slash.catFormat"),
      keywords: ["math", "latex", "katex", "formula", "equation", "公式", "数学", "方程"],
      action: (editor) => {
        editor
          .chain()
          .focus()
          .insertContent({
            type: "mathBlock",
            attrs: { latex: "" },
          })
          .run();
      },
    },
    {
      // 脚注：在光标处插入 ref，并在文档末尾追加配对的 def。
      // identifier 自动取下一个未占用的数字，用户后续可双击 ref / def 改名。
      id: "footnote",
      label: t("slash.footnote"),
      description: t("slash.footnoteDesc"),
      icon: <BookOpen size={16} />,
      category: t("slash.catFormat"),
      keywords: ["footnote", "fn", "脚注", "注释", "注解"],
      action: (editor) => {
        const id = nextFootnoteIdentifier(editor);
        // 在光标处插入引用
        editor
          .chain()
          .focus()
          .insertContent({
            type: "footnoteReference",
            attrs: { identifier: id },
          })
          .run();
        // 在文档末尾追加定义（避免插在光标处打断阅读流）。
        // 注意：上一步的 editor.state 已被 chain 更新，重新取最新 state。
        const docEnd = editor.state.doc.content.size;
        editor
          .chain()
          .focus()
          .insertContentAt(docEnd, {
            type: "footnoteDefinition",
            attrs: { identifier: id, content: "" },
          })
          .run();
      },
    },
    {
      id: "horizontalRule",
      label: t("slash.horizontalRule"),
      description: t("slash.horizontalRuleDesc"),
      icon: <Minus size={16} />,
      category: t("slash.catFormat"),
      keywords: ["hr", "divider", "separator", "分割线", "横线"],
      action: (editor) => editor.chain().focus().setHorizontalRule().run(),
    },
    // 内联格式
    {
      id: "bold",
      label: t("slash.bold"),
      description: t("slash.boldDesc"),
      icon: <Bold size={16} />,
      category: t("slash.catInline"),
      keywords: ["bold", "strong", "加粗", "粗体"],
      action: (editor) => editor.chain().focus().toggleBold().run(),
    },
    {
      id: "italic",
      label: t("slash.italic"),
      description: t("slash.italicDesc"),
      icon: <Italic size={16} />,
      category: t("slash.catInline"),
      keywords: ["italic", "em", "斜体"],
      action: (editor) => editor.chain().focus().toggleItalic().run(),
    },
    {
      id: "highlight",
      label: t("slash.highlight"),
      description: t("slash.highlightDesc"),
      icon: <Highlighter size={16} />,
      category: t("slash.catInline"),
      keywords: ["highlight", "mark", "高亮", "标记"],
      action: (editor) => editor.chain().focus().toggleHighlight().run(),
    },
    {
      id: "strike",
      label: t("slash.strike"),
      description: t("slash.strikeDesc"),
      icon: <Strikethrough size={16} />,
      category: t("slash.catInline"),
      keywords: ["strike", "strikethrough", "del", "删除", "删除线", "横线"],
      action: (editor) => editor.chain().focus().toggleStrike().run(),
    },
    {
      id: "inlineCode",
      label: t("slash.inlineCode"),
      description: t("slash.inlineCodeDesc"),
      icon: <Code size={16} />,
      category: t("slash.catInline"),
      keywords: ["code", "inline", "monospace", "行内", "代码"],
      action: (editor) => editor.chain().focus().toggleCode().run(),
    },
    {
      id: "link",
      label: t("slash.link"),
      description: t("slash.linkDesc"),
      icon: <LinkIcon size={16} />,
      category: t("slash.catInline"),
      keywords: ["link", "url", "hyperlink", "链接", "超链接"],
      action: (editor) => {
        // 已有选区：把选中文本变成链接；无选区：弹输入框获取 URL，
        // 然后以 URL 作为可见文本插入并应用 link mark。
        // 输入框支持 markdown.com.cn 标准的带标题写法 `https://x.com "标题"`，
        // 解析时把空格后的 "..." 部分作为 link 的 title 属性，鼠标悬停显示。
        const { from, to, empty } = editor.state.selection;
        const previousAttrs = editor.getAttributes("link") as { href?: string; title?: string | null };
        const previous = previousAttrs?.href ?? "";
        const previousTitle = previousAttrs?.title ?? "";
        const defaultValue = previous
          ? previousTitle
            ? `${previous} "${previousTitle}"`
            : previous
          : "https://";

        // action 类型签名是同步 void，这里 fire-and-forget 一个 async IIFE，
        // 让弹窗在菜单关闭后再异步弹出，互不打扰。
        void (async () => {
          const url = await promptDialog({
            title: t("slash.link"),
            placeholder: 'https://example.com  或  https://example.com "标题"',
            defaultValue,
            confirmText: t("common.confirm"),
            cancelText: t("common.cancel"),
            allowEmpty: true,
          });
          if (url == null) return; // 用户取消

          const trimmed = url.trim();
          if (!trimmed) {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            return;
          }

          const match = trimmed.match(/^(\S+)(?:\s+"([^"]*)")?$/);
          const rawHref = (match?.[1] ?? trimmed).trim();
          const linkTitle = match?.[2] ?? null;

          const safe = /^(https?:|mailto:|tel:|\/|#)/i.test(rawHref)
            ? rawHref
            : `https://${rawHref}`;

          const attrs: { href: string; title?: string | null } = { href: safe };
          if (linkTitle) attrs.title = linkTitle;

          if (empty) {
            editor
              .chain()
              .focus()
              .insertContent({ type: "text", text: rawHref, marks: [{ type: "link", attrs }] })
              .run();
          } else {
            editor.chain().focus().setTextSelection({ from, to }).extendMarkRange("link").setLink(attrs).run();
          }
        })();
      },
    },
    // 插入
    {
      id: "image",
      label: t("slash.image"),
      description: t("slash.imageDesc"),
      icon: <ImagePlus size={16} />,
      category: t("slash.catInsert"),
      keywords: ["image", "picture", "photo", "图片", "插图"],
      action: () => onImageUpload?.(),
    },
    {
      // 视频：弹窗输 URL 后调 setVideo。支持直链 mp4/webm + B 站 / YouTube /
      // 腾讯视频 / Vimeo。URL 解析失败时 setVideo 返回 false，这里丢个警告。
      id: "video",
      label: t("slash.video") || "视频",
      description: t("slash.videoDesc") || "插入 B 站 / YouTube / mp4 等视频链接",
      icon: <Film size={16} />,
      category: t("slash.catInsert"),
      keywords: ["video", "movie", "bilibili", "youtube", "mp4", "视频", "记录片"],
      action: (editor) => {
        void (async () => {
          const url = await promptDialog({
            title: t("slash.video") || "插入视频",
            placeholder: "https://www.bilibili.com/video/BV...  或 .mp4 直链",
            defaultValue: "",
            confirmText: t("common.confirm"),
            cancelText: t("common.cancel"),
            allowEmpty: false,
          });
          if (!url) return;
          const ok = (editor.commands as any).setVideo(url.trim());
          if (!ok) {
            console.warn("[slash] setVideo failed: unrecognized url", url);
          }
        })();
      },
    },
    {
      id: "table",
      label: t("slash.table"),
      description: t("slash.tableDesc"),
      icon: <Table2 size={16} />,
      category: t("slash.catInsert"),
      keywords: ["table", "grid", "表格"],
      action: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    // AI
    {
      id: "ai",
      label: t("slash.ai"),
      description: t("slash.aiDesc"),
      icon: <Sparkles size={16} className="text-violet-500" />,
      category: t("slash.catAI"),
      keywords: ["ai", "assistant", "智能", "助手", "写作"],
      action: () => onAIAssistant?.(),
    },
  ];
}

// Tiptap 扩展：监听 "/" 输入
const slashPluginKey = new PluginKey("slashCommands");

export function createSlashExtension(
  onActivate: (query: string, pos: { top: number; left: number; from: number }) => void,
  onDeactivate: () => void,
  onQueryChange: (query: string) => void,
) {
  return Extension.create({
    name: "slashCommands",

    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin({
          key: slashPluginKey,
          state: {
            init() {
              return { active: false, from: 0, query: "" };
            },
            apply(tr, prev) {
              const meta = tr.getMeta(slashPluginKey);
              if (meta) return meta;
              // 如果文档变化了，检查是否还在斜杠命令模式
              if (tr.docChanged && prev.active) {
                const { from } = prev;
                const $pos = tr.doc.resolve(Math.min(from, tr.doc.content.size));
                const textBefore = $pos.parent.textBetween(
                  0,
                  Math.min($pos.parentOffset, $pos.parent.content.size),
                  undefined,
                  "\ufffc"
                );
                // 查找最后一个 "/"
                const slashIdx = textBefore.lastIndexOf("/");
                if (slashIdx === -1) {
                  return { active: false, from: 0, query: "" };
                }
                const query = textBefore.slice(slashIdx + 1);
                // 如果查询中包含空格，关闭菜单
                if (query.includes(" ") || query.includes("\n")) {
                  return { active: false, from: 0, query: "" };
                }
                return { ...prev, query };
              }
              return prev;
            },
          },
          props: {
            handleKeyDown(view, event) {
              const state = slashPluginKey.getState(view.state);
              if (event.key === "/" && !state?.active) {
                // 检查光标前是否是行首或空格
                const { $from } = view.state.selection;
                const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
                const trimmed = textBefore.trim();
                // 只在行首或空内容时触发
                if (trimmed === "" || textBefore.endsWith(" ")) {
                  // 延迟激活，等 "/" 字符插入后
                  setTimeout(() => {
                    const { state: newState } = view;
                    const { from } = newState.selection;
                    const coords = view.coordsAtPos(from);
                    const editorRect = view.dom.getBoundingClientRect();
                    
                    const tr = newState.tr.setMeta(slashPluginKey, {
                      active: true,
                      from: from,
                      query: "",
                    });
                    view.dispatch(tr);

                    onActivate("", {
                      top: Math.min(coords.bottom + 4, window.innerHeight - 340),
                      left: Math.min(coords.left, window.innerWidth - 300),
                      from: from - 1, // "/" 字符的位置
                    });
                  }, 10);
                }
              }
              return false;
            },
          },
          view() {
            return {
              update(view) {
                const state = slashPluginKey.getState(view.state);
                if (state?.active) {
                  onQueryChange(state.query);
                }
              },
            };
          },
        }),
      ];
    },
  });
}

export interface SlashCommandsRef {
  isActive: boolean;
}

interface SlashCommandsProps {
  editor: Editor | null;
  items: SlashCommandItem[];
}

export const SlashCommandsMenu = forwardRef<SlashCommandsRef, SlashCommandsProps>(
  function SlashCommandsMenu({ editor, items }, ref) {
    const [isActive, setIsActive] = useState(false);
    const [query, setQuery] = useState("");
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const slashFrom = useRef(0);

    useImperativeHandle(ref, () => ({
      get isActive() { return isActive; },
    }));

    const handleSelect = useCallback((item: SlashCommandItem) => {
      if (!editor) return;
      // 删除 "/" 和查询文本
      const { state } = editor;
      const from = slashFrom.current;
      const to = state.selection.from;
      editor.chain().focus().deleteRange({ from, to }).run();
      // 执行命令
      item.action(editor);
      // 关闭菜单
      setIsActive(false);
      // 重置 plugin state
      const tr = editor.state.tr.setMeta(slashPluginKey, { active: false, from: 0, query: "" });
      editor.view.dispatch(tr);
    }, [editor]);

    const handleClose = useCallback(() => {
      setIsActive(false);
      if (editor) {
        const tr = editor.state.tr.setMeta(slashPluginKey, { active: false, from: 0, query: "" });
        editor.view.dispatch(tr);
      }
    }, [editor]);

    // 暴露激活/关闭方法给外部
    useEffect(() => {
      if (!editor) return;
      // 通过自定义事件通信
      const handleActivate = (e: CustomEvent) => {
        setIsActive(true);
        setQuery(e.detail.query);
        setPosition({ top: e.detail.top, left: e.detail.left });
        slashFrom.current = e.detail.from;
      };
      const handleDeactivate = () => {
        setIsActive(false);
      };
      const handleQueryChange = (e: CustomEvent) => {
        setQuery(e.detail.query);
      };

      window.addEventListener("slash-activate" as any, handleActivate as any);
      window.addEventListener("slash-deactivate" as any, handleDeactivate as any);
      window.addEventListener("slash-query" as any, handleQueryChange as any);

      return () => {
        window.removeEventListener("slash-activate" as any, handleActivate as any);
        window.removeEventListener("slash-deactivate" as any, handleDeactivate as any);
        window.removeEventListener("slash-query" as any, handleQueryChange as any);
      };
    }, [editor]);

    if (!isActive || !editor) return null;

    return (
      <SlashMenu
        editor={editor}
        items={items}
        query={query}
        position={position}
        onSelect={handleSelect}
        onClose={handleClose}
      />
    );
  }
);

// 辅助函数：创建事件分发器
export function createSlashEventHandlers() {
  return {
    onActivate: (query: string, pos: { top: number; left: number; from: number }) => {
      window.dispatchEvent(new CustomEvent("slash-activate", { detail: { query, ...pos } }));
    },
    onDeactivate: () => {
      window.dispatchEvent(new CustomEvent("slash-deactivate"));
    },
    onQueryChange: (query: string) => {
      window.dispatchEvent(new CustomEvent("slash-query", { detail: { query } }));
    },
  };
}
