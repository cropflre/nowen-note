import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, Extension, ReactNodeViewRenderer } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { AnimatePresence, motion } from "framer-motion";import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { common, createLowlight } from "lowlight";
import { DOMParser as ProseMirrorDOMParser, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { markdownToSimpleHtml } from "@/lib/importService";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Heading1, Heading2, Heading3,
  Quote, ImagePlus, CheckSquare, Highlighter, Minus, Undo, Redo,
  FileCode, Sparkles, X, ZoomIn, ZoomOut, RotateCcw,
  Table2, Indent, Outdent, AlignLeft, AlignCenter, AlignRight, Trash2,
  FileType, Check, AlertCircle
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { Note, Tag } from "@/types";
import TagInput from "@/components/TagInput";
import AIWritingAssistant from "@/components/AIWritingAssistant";
import { SlashCommandsMenu, getDefaultSlashCommands, createSlashExtension, createSlashEventHandlers } from "@/components/SlashCommands";
import CodeBlockView from "@/components/CodeBlockView";
import { useTranslation } from "react-i18next";

const lowlight = createLowlight(common);

// ---------------------------------------------------------------------------
// ProseMirror 防御性补丁：避免 "Position X out of range" RangeError 导致崩溃
// ---------------------------------------------------------------------------
// 背景：
//   ProseMirror 的 DOMObserver 在某些情况下（如中文 IME composition、React
//   NodeView 的 DOM 结构与 PM 文档树短暂不一致、inputRule 引起的节点类型转换
//   等）会调用 Node.resolve(pos) 解析一个越界（常为负数）的位置，直接抛出
//   未被捕获的 RangeError，导致整个编辑器崩溃、页面显示异常。
//
// 思路：
//   覆盖 Node.prototype.resolve，对越界位置钳制到 [0, content.size] 范围内
//   再调用原实现。对于绝大多数场景：
//     - 合法位置：行为完全不变（走原 resolve 路径）。
//     - 越界位置：返回一个合法端点的 ResolvedPos，而不是抛错崩溃。
//
//   这与 PM 的设计哲学兼容：它会在下一次事务中通过 DOMObserver 重新同步 DOM
//   与文档树，通常一瞬即恢复一致；而崩溃后编辑器无法继续操作，用户必须刷新。
//
// 这是全局一次性补丁，使用 Symbol 防重复应用。
// ---------------------------------------------------------------------------
const RESOLVE_PATCHED = Symbol.for("nowen.pm.resolve.patched");
if (!(ProseMirrorNode.prototype as any)[RESOLVE_PATCHED]) {
  const originalResolve = ProseMirrorNode.prototype.resolve;
  ProseMirrorNode.prototype.resolve = function patchedResolve(pos: number) {
    const size = this.content.size;
    if (pos < 0 || pos > size) {
      // 位置越界：钳制到合法范围，避免抛 RangeError 崩溃。
      // 记录一次警告方便排查，但不中断用户输入。
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          `[PM Patch] resolve() called with out-of-range position ${pos} (valid: 0..${size}); clamped.`
        );
      }
      const clamped = Math.max(0, Math.min(size, pos));
      return originalResolve.call(this, clamped);
    }
    return originalResolve.call(this, pos);
  };
  (ProseMirrorNode.prototype as any)[RESOLVE_PATCHED] = true;
}


// 自定义缩进扩展
// 支持段落、标题、列表（bullet / ordered / task）、引用、代码块整体做"手动缩进"调整。
// 通过 data-indent 属性 + CSS 的 padding-left 实现纯视觉缩进，不破坏文档结构。
const INDENT_MIN = 0;
const INDENT_MAX = 8;
const INDENTABLE_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
] as const;

const IndentExtension = Extension.create({
  name: "indent",
  addGlobalAttributes() {
    return [
      {
        types: [...INDENTABLE_TYPES],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => parseInt(element.getAttribute("data-indent") || "0", 10),
            renderHTML: (attributes) => {
              if (!attributes.indent || attributes.indent === 0) return {};
              return { "data-indent": attributes.indent };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      // 对选区覆盖的可缩进块按 delta 调整 indent（限制 0..INDENT_MAX）
      changeIndent: (delta: number) => ({ state, tr, dispatch }: any) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (!(INDENTABLE_TYPES as readonly string[]).includes(node.type.name)) return;
          const current = (node.attrs as any).indent || 0;
          const next = Math.max(INDENT_MIN, Math.min(INDENT_MAX, current + delta));
          if (next === current) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
    } as any;
  },
});

/**
 * 键盘扩展：
 *   - Tab / Shift-Tab：智能缩进 —— 代码块内插空格；列表内 sink/lift；表格内由 tiptap-table 处理；其余调块级 indent。
 *   - Mod-s：立即保存（由外部通过 ref 注入 flush 函数）。
 */
function createKeyboardExtension(flushSaveRef: React.MutableRefObject<() => void>) {
  return Extension.create({
    name: "nowenKeyboard",
    addKeyboardShortcuts() {
      const editor = this.editor as any;

      const isInCodeBlock = () => editor.isActive("codeBlock");
      const isInTable = () => editor.isActive("table");
      const isInTaskList = () => editor.isActive("taskList") || editor.isActive("taskItem");
      const isInBulletOrOrdered = () =>
        editor.isActive("bulletList") || editor.isActive("orderedList") || editor.isActive("listItem");

      const handleTab = (delta: 1 | -1) => {
        // 表格：交给 tiptap-table 默认的 goToNextCell/goToPreviousCell
        if (isInTable()) return false;

        // 代码块：插入 / 删除 2 个空格
        if (isInCodeBlock()) {
          if (delta === 1) {
            editor.chain().focus().insertContent("  ").run();
            return true;
          } else {
            // Shift+Tab：若光标前有至多 2 个空格则删掉
            const { state } = editor;
            const { from, empty } = state.selection;
            if (!empty) return false;
            const before = state.doc.textBetween(Math.max(0, from - 2), from, "\n", "\n");
            const strip = before.endsWith("  ") ? 2 : before.endsWith(" ") ? 1 : 0;
            if (strip === 0) return true; // 阻止默认行为但不删
            editor.chain().focus().deleteRange({ from: from - strip, to: from }).run();
            return true;
          }
        }

        // 任务列表 / 普通列表：sink / lift
        if (isInTaskList()) {
          const ok = delta === 1
            ? editor.chain().focus().sinkListItem("taskItem").run()
            : editor.chain().focus().liftListItem("taskItem").run();
          if (ok) return true;
          // 若无法 sink/lift（例如已是最外层），退化为块级 indent
        } else if (isInBulletOrOrdered()) {
          const ok = delta === 1
            ? editor.chain().focus().sinkListItem("listItem").run()
            : editor.chain().focus().liftListItem("listItem").run();
          if (ok) return true;
        }

        // 其余：调整块级 indent 属性
        return editor.chain().focus().changeIndent(delta).run();
      };

      return {
        Tab: () => handleTab(1),
        "Shift-Tab": () => handleTab(-1),
        "Mod-s": () => {
          flushSaveRef.current?.();
          return true; // 返回 true 阻止浏览器默认的"保存网页"对话框
        },
      };
    },
  });
}

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}

function ToolbarButton({ onClick, isActive, disabled, children, title }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "p-1.5 rounded-md transition-colors",
        isActive
          ? "bg-accent-primary/20 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        disabled && "opacity-30 cursor-not-allowed"
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-app-border mx-1" />;
}

interface TiptapEditorProps {
  note: Note;
  onUpdate: (data: { content: string; contentText: string; title: string }) => void;
  onTagsChange?: (tags: Tag[]) => void;
  onHeadingsChange?: (headings: HeadingItem[]) => void;
  onEditorReady?: (scrollTo: (pos: number) => void) => void;
  editable?: boolean;
  /**
   * 访客模式（分享页可编辑场景）：
   * - 禁用 TagInput（依赖 useApp，分享页无 AppProvider，会崩）
   * - 隐藏 AI 助手入口（访客无登录态，调 AI API 会 401）
   * 默认 false（正常登录态使用）
   */
  isGuest?: boolean;
}

function extractHeadings(editor: any): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const doc = editor.state.doc;
  let idx = 0;
  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "heading") {
      headings.push({
        id: `h-${idx++}`,
        level: node.attrs.level,
        text: node.textContent || "",
        pos,
      });
    }
  });
  return headings;
}

export default function TiptapEditor({ note, onUpdate, onTagsChange, onHeadingsChange, onEditorReady, editable = true, isGuest = false }: TiptapEditorProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const [wordStats, setWordStats] = useState({ chars: 0, charsNoSpace: 0, words: 0 });
  const [showAI, setShowAI] = useState(false);
  const [aiSelectedText, setAiSelectedText] = useState("");
  const [aiPosition, setAiPosition] = useState<{ top: number; left: number } | undefined>();
  // 图片预览状态
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageDrag, setImageDrag] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, imgX: 0, imgY: 0 });
  const { t, i18n } = useTranslation();

  // 斜杠命令事件处理器（稳定引用）
  const slashHandlers = useRef(createSlashEventHandlers());
  const slashExtension = useRef(
    createSlashExtension(
      slashHandlers.current.onActivate,
      slashHandlers.current.onDeactivate,
      slashHandlers.current.onQueryChange,
    )
  );

  // Markdown 粘贴提示 toast
  const [pasteToast, setPasteToast] = useState<{ type: "converting" | "success" | "error"; message: string } | null>(null);
  const pasteToastTimer = useRef<NodeJS.Timeout | null>(null);

  const showPasteToast = useCallback((type: "converting" | "success" | "error", message: string, duration = 2500) => {
    if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
    setPasteToast({ type, message });
    if (type !== "converting") {
      pasteToastTimer.current = setTimeout(() => setPasteToast(null), duration);
    }
  }, []);

  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  // 防止 setContent 触发 onUpdate 导致无限循环
  const isSettingContent = useRef(false);
  // 保持最新的 note ref，避免闭包引用过期
  const noteRef = useRef(note);
  noteRef.current = note;
  // 保持最新的 onUpdate ref
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // 立即保存（Ctrl/Cmd+S 使用）：清掉 debounce 并立刻调用 onUpdate
  const flushSaveRef = useRef<() => void>(() => {});

  // 稳定的键盘扩展引用（Tab/Shift-Tab/Mod-s）
  const keyboardExtension = useRef(createKeyboardExtension(flushSaveRef));

  const computeStats = useCallback((text: string) => {
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, "").length;
    // 中文按字计数 + 英文按空格分词
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ").trim();
    const enWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
    return { chars, charsNoSpace, words: cjk + enWords };
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        code: false,
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: t('tiptap.placeholder'),
        emptyEditorClass: "is-editor-empty",
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: "rounded-lg max-w-full mx-auto my-4 shadow-md" },
      }),
      CodeBlockLowlight.extend({
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
      }).configure({ lowlight, defaultLanguage: null as any }),
      Underline,
      Highlight.configure({
        multicolor: true,
        HTMLAttributes: { class: "highlight-mark" },
      }),
      TaskList.configure({
        HTMLAttributes: {
          class: 'task-list',
        },
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: {
          class: 'task-item',
        },
      }),
      Table.configure({
        resizable: true,
        handleWidth: 5,
        cellMinWidth: 60,
        lastColumnResizable: true,
        HTMLAttributes: { class: 'tiptap-table' },
      }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      IndentExtension,
      keyboardExtension.current,
      slashExtension.current,
    ],
    content: parseContent(note.content),
    editable,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[300px] px-1",
      },
      // 在 heading / blockquote 等块级节点行首按 Backspace 时，
      // 统一把当前节点转为普通段落，避免某些导入/InputRule 后的
      // 节点难以通过 Backspace 退出的问题（用户反馈的 # 开头无法删除）。
      handleKeyDown: (view, event) => {
        if (event.key !== "Backspace" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return false;
        }
        const { state: s } = view;
        const { selection } = s;
        if (!selection.empty) return false;
        const { $from } = selection;
        // 必须位于块级节点的第一个位置（行首）
        if ($from.parentOffset !== 0) return false;
        const parent = $from.parent;
        const parentType = parent.type.name;
        // 仅对 heading / blockquote 做行首 backspace 转段落
        if (parentType !== "heading" && parentType !== "blockquote") {
          return false;
        }
        const paragraphType = s.schema.nodes.paragraph;
        if (!paragraphType) return false;
        try {
          // 对 heading：直接 setNode 变为 paragraph
          if (parentType === "heading") {
            const depth = $from.depth;
            const tr = s.tr.setBlockType($from.before(depth), $from.after(depth), paragraphType);
            view.dispatch(tr.scrollIntoView());
            return true;
          }
          // 对 blockquote：lift 出引用
          // 交由默认命令处理 —— 返回 false
          return false;
        } catch {
          return false;
        }
      },
      handlePaste: (view, event) => {
        // 始终阻止浏览器默认粘贴行为，防止页面跳转到空白页
        event.preventDefault();
        try {
          // 1) 处理剪贴板中的图片文件（如截图粘贴）
          const items = event.clipboardData?.items;
          if (items) {
            for (let i = 0; i < items.length; i++) {
              if (items[i].type.startsWith("image/")) {
                const file = items[i].getAsFile();
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    const src = e.target?.result as string;
                    if (src) {
                      const { state: editorState, dispatch } = view;
                      const node = editorState.schema.nodes.image?.create({ src });
                      if (node) {
                        const tr = editorState.tr.replaceSelectionWith(node);
                        dispatch(tr);
                      }
                    }
                  };
                  reader.readAsDataURL(file);
                }
                return true;
              }
            }
          }

          const text = event.clipboardData?.getData("text/plain") || "";
          const html = event.clipboardData?.getData("text/html") || "";

          // 2) 若当前光标在代码块内：不管来源是 html 还是 text，始终保留原始文本 + 换行
          const { state: stCode } = view;
          const $pasteFrom = stCode.selection.$from;
          let inCodeBlock = false;
          for (let d = $pasteFrom.depth; d >= 0; d--) {
            if ($pasteFrom.node(d).type.name === "codeBlock") {
              inCodeBlock = true;
              break;
            }
          }
          if (inCodeBlock) {
            if (!text) return true;
            const tr = stCode.tr.insertText(text);
            view.dispatch(tr);
            return true;
          }

          // 3) 多行纯文本（非 Markdown）且看起来像代码：整段包进单一 codeBlock。
          //    注意：必须优先于 HTML 分支，因为 VS Code / 浏览器复制代码时
          //    通常同时带 text/html（每行一个 <div> 或 <pre><br>），
          //    若走 HTML 解析会被拆成多块，导致"每行一个代码块"。
          //    增加 looksLikeCode 判断：含大量中文自然语言的多行文本不应被包成 codeBlock。
          if (text && text.includes("\n") && !looksLikeMarkdown(text) && looksLikeCode(text)) {
            // 把纯文本包在 <pre><code> 中，通过 PM 的 DOMParser.parseSlice → replaceSelection
            // 让 PM 自己处理块级节点（codeBlock）的嵌套与光标定位。
            // 之前的做法是手动 codeBlockType.create() + replaceSelectionWith()，
            // 但在光标位于段落内等场景下 PM 无法正确 fit 块级节点到行内位置，
            // 导致文档结构损坏 → 后续 DOM mutation 时 resolveSelection 报
            // "Position -12 out of range"。
            const { state, dispatch } = view;
            const parser = ProseMirrorDOMParser.fromSchema(state.schema);
            const wrapper = document.createElement("div");
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = text;
            pre.appendChild(code);
            wrapper.appendChild(pre);
            const slice = parser.parseSlice(wrapper);
            const tr = state.tr.replaceSelection(slice).scrollIntoView();
            dispatch(tr);
            return true;
          }

          // 4) Markdown 纯文本：转 HTML 后插入
          if (text && looksLikeMarkdown(text)) {
            showPasteToast("converting", t("tiptap.markdownConverting"));
            try {
              const convertedHtml = markdownToSimpleHtml(text);
              const { state, dispatch } = view;
              const parser = ProseMirrorDOMParser.fromSchema(state.schema);
              const tempDiv = document.createElement("div");
              tempDiv.innerHTML = convertedHtml;
              const slice = parser.parseSlice(tempDiv);
              const tr = state.tr.replaceSelection(slice);
              dispatch(tr);
              showPasteToast("success", t("tiptap.markdownConvertSuccess"));
            } catch (err) {
              console.error("Markdown paste conversion failed:", err);
              showPasteToast("error", t("tiptap.markdownConvertError"));
              const { state, dispatch } = view;
              const tr = state.tr.insertText(text);
              dispatch(tr);
            }
            return true;
          }

          // 5) 只有 HTML 没有多行纯文本（如从网页复制的富文本片段）：解析插入
          if (html && html.trim().length > 0) {
            const { state, dispatch } = view;
            const parser = ProseMirrorDOMParser.fromSchema(state.schema);
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = html;
            const slice = parser.parseSlice(tempDiv);
            const tr = state.tr.replaceSelection(slice);
            dispatch(tr);
            return true;
          }

          // 6) 单行纯文本或其他：直接插入
          if (text) {
            const { state: st, dispatch: dp } = view;
            const tr = st.tr.insertText(text);
            dp(tr);
          }
          return true;
        } catch (err) {
          console.error("Paste handling error:", err);
          // 出错时尝试插入纯文本，避免页面崩溃
          try {
            const fallbackText = event.clipboardData?.getData("text/plain") || "";
            if (fallbackText) {
              const { state: fst, dispatch: fdp } = view;
              const tr = fst.tr.insertText(fallbackText);
              fdp(tr);
            }
          } catch {}
          return true;
        }
      },
    },
    onUpdate: ({ editor }) => {
      // setContent 触发的 onUpdate 不应该保存（防止死循环）
      if (isSettingContent.current) return;

      const text = editor.getText();
      setWordStats(computeStats(text));
      onHeadingsChange?.(extractHeadings(editor));
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const json = JSON.stringify(editor.getJSON());
        const title = titleRef.current?.value || noteRef.current.title;
        onUpdateRef.current({ content: json, contentText: text, title });
      }, 500);
    },
  });

  // 实现 flushSave：Ctrl/Cmd+S 触发，绕过 500ms debounce 立即保存
  flushSaveRef.current = () => {
    if (!editor) return;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    const json = JSON.stringify(editor.getJSON());
    const text = editor.getText();
    const title = titleRef.current?.value || noteRef.current.title;
    onUpdateRef.current({ content: json, contentText: text, title });
    try {
      toast.success(t('tiptap.saved') || 'Saved');
    } catch {}
  };

  // 切换笔记时同步编辑器内容
  useEffect(() => {
    // 切换笔记时立即清理旧的 debounce timer，防止旧笔记的保存请求泄漏
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }

    if (editor && note) {
      const parsed = parseContent(note.content);
      const currentJson = JSON.stringify(editor.getJSON());
      const newJson = JSON.stringify(parsed);
      if (currentJson !== newJson) {
        // 标记正在设置内容，阻止 onUpdate 触发保存
        isSettingContent.current = true;
        editor.commands.setContent(parsed);
        // 使用 queueMicrotask 确保在 Tiptap 事务完成后才解锁
        queueMicrotask(() => {
          isSettingContent.current = false;
        });
      }
      setWordStats(computeStats(editor.getText()));
      onHeadingsChange?.(extractHeadings(editor));
    }
    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
  }, [note.id, note.content]);
  //   ^^^^^^^^^^^^^^^^^^^^^^
  //   依赖为什么是 content 而不是 version：
  //
  //   父组件（EditorPane.handleUpdate）在保存成功后，为了避免打断用户输入，
  //   只回填 version/updatedAt/title，**不回填 content**。因此：
  //
  //   1) 正常打字保存：note.version 会 +1 但 note.content 不变
  //      → 若依赖 version，此 effect 会被触发，用 旧 note.content 去 setContent，
  //        把用户刚输入的文本覆盖回退（这就是"输入任何文本都自动回退"的 bug）。
  //      → 改用 content 依赖后，content 没变，effect 不跑，用户输入不被回退。
  //
  //   2) 恢复历史版本：VersionHistoryPanel.onRestore → setActiveNote(updated)，
  //      updated.content 是新的（老版本内容） → content 变化 → effect 触发 → setContent。
  //
  //   3) 切换笔记：note.id 变化 → effect 触发。
  //
  //   内部仍保留 currentJson !== newJson 护栏，避免同一 JSON 重复 setContent 抖动光标。

  // 组件卸载时清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, []);

  // 图片点击预览事件监听
  useEffect(() => {
    if (!editor) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "IMG" && target.closest(".ProseMirror")) {
        const src = (target as HTMLImageElement).src;
        if (src) {
          setPreviewImage(src);
          setImageZoom(1);
          setImageDrag({ x: 0, y: 0 });
        }
      }
    };
    const editorDom = editor.view.dom;
    editorDom.addEventListener("click", handleClick);
    return () => editorDom.removeEventListener("click", handleClick);
  }, [editor]);

  // 图片预览滚轮缩放
  const handlePreviewWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setImageZoom(prev => {
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      return Math.max(0.1, Math.min(5, prev + delta));
    });
  }, []);

  // 图片预览拖拽
  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, imgX: imageDrag.x, imgY: imageDrag.y };
  }, [imageDrag]);

  const handlePreviewMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setImageDrag({
      x: dragStart.current.imgX + (e.clientX - dragStart.current.x),
      y: dragStart.current.imgY + (e.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handlePreviewMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 动态切换编辑器的可编辑状态
  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // Provide scrollTo callback to parent
  useEffect(() => {
    if (!editor) return;
    const scrollTo = (pos: number) => {
      editor.commands.focus();
      editor.commands.setTextSelection(pos);
      // Scroll the heading node into view
      const dom = editor.view.domAtPos(pos + 1);
      if (dom?.node) {
        const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    onEditorReady?.(scrollTo);
  }, [editor, onEditorReady]);

  const handleTitleChange = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const title = titleRef.current?.value || "";
      const json = editor ? JSON.stringify(editor.getJSON()) : note.content;
      const text = editor ? editor.getText() : note.contentText;
      onUpdate({ content: json, contentText: text, title });
    }, 500);
  }, [editor, note, onUpdate]);

  const handleImageUpload = useCallback(() => {
    if (!editor) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const src = e.target?.result as string;
        editor.chain().focus().setImage({ src }).run();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [editor]);

  /**
   * 严格作用于当前选区的代码块切换：
   *   - 光标在代码块内：取消代码块（转为段落），与默认 toggleCodeBlock 一致
   *   - 无选区：将光标所在的整个块切换为代码块（与默认行为一致）
   *   - 有选区：把选区覆盖的所有顶层块合并为一个 codeBlock
   *            （以顶层块为粒度，不做"半块切出"处理，避免跨多块替换产生多个代码块）
   */
  const toggleCodeBlockStrict = useCallback(() => {
    if (!editor) return;
    const { state } = editor;
    const { selection, schema, doc } = state;
    const codeBlockType = schema.nodes.codeBlock;
    if (!codeBlockType) return;

    // 光标已在代码块内：取消代码块
    if (editor.isActive("codeBlock")) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    // 无选区：退回默认行为（转当前块为代码块）
    if (selection.empty) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    const { from, to } = selection;
    const $from = doc.resolve(from);

    // 仅支持顶层（doc 直接子块）范围的整体包裹；
    // 嵌套结构（列表 / 表格 / 引用块等）内部的选区交给默认命令，避免破坏结构
    if ($from.depth !== 1) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }
    // 为避免 $to.before(1) 在 to 正好位于两块边界时指到"下一个块"，
    // 用 (to - 1) 解析末块位置；当 from === to 已被上面 selection.empty 排除，所以 to-1 >= from。
    const $toInside = doc.resolve(Math.max(from, to - 1));
    if ($toInside.depth !== 1) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    // 选区覆盖的顶层块范围（左闭右开）：从首块起点到末块终点
    const blockStart = $from.before(1);
    const blockEnd = $toInside.after(1);

    // 收集范围内所有顶层块的文本，按换行拼接
    const lines: string[] = [];
    doc.nodesBetween(blockStart, blockEnd, (node, _pos, _parent, _index) => {
      // 只处理 doc 的直接子节点
      if (_parent === doc) {
        if (node.type.name === "codeBlock" || node.isTextblock) {
          lines.push(node.textContent);
        } else {
          // 非文本块（如 horizontalRule、image 等）：用空行占位，避免完全丢失
          lines.push("");
        }
        return false; // 不再深入该块内部
      }
      return true;
    });

    const codeText = lines.join("\n");
    const codeNode = codeText
      ? codeBlockType.create({}, schema.text(codeText))
      : codeBlockType.create();

    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        if (!dispatch) return true;
        // 先删除覆盖范围，再在原位置插入单一 codeBlock
        tr.delete(blockStart, blockEnd);
        tr.insert(blockStart, codeNode);
        // 光标定位到新代码块末尾
        const caretPos = blockStart + codeNode.nodeSize - 1;
        const safePos = Math.min(caretPos, tr.doc.content.size);
        tr.setSelection(TextSelection.near(tr.doc.resolve(safePos), -1));
        return true;
      })
      .run();
  }, [editor]);

  const openAIAssistant = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, " ");
    setAiSelectedText(selected || editor.getText().slice(0, 500));

    // 获取选区在屏幕上的位置
    const coords = editor.view.coordsAtPos(from);
    const editorRect = editor.view.dom.getBoundingClientRect();
    setAiPosition({
      top: Math.min(coords.top + 28, window.innerHeight - 500),
      left: Math.min(coords.left, window.innerWidth - 420),
    });
    setShowAI(true);
  }, [editor]);

  const handleAIInsert = useCallback((text: string) => {
    if (!editor) return;
    const { to } = editor.state.selection;
    editor.chain().focus().insertContentAt(to, text).run();
  }, [editor]);

  const handleAIReplace = useCallback((text: string) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      // 无选区时，插入到光标处
      editor.chain().focus().insertContent(text).run();
    } else {
      editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, text).run();
    }
  }, [editor]);

  if (!editor) return null;

  const iconSize = 15;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-4 py-2 border-b border-app-border bg-app-surface/50 md:flex-wrap overflow-x-auto hide-scrollbar touch-pan-x transition-colors">
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title={t('tiptap.undo')}>
          <Undo size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title={t('tiptap.redo')}>
          <Redo size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive("heading", { level: 1 })}
          title={t('tiptap.heading1')}
        >
          <Heading1 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive("heading", { level: 2 })}
          title={t('tiptap.heading2')}
        >
          <Heading2 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive("heading", { level: 3 })}
          title={t('tiptap.heading3')}
        >
          <Heading3 size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title={t('tiptap.bold')}
        >
          <Bold size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title={t('tiptap.italic')}
        >
          <Italic size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive("underline")}
          title={t('tiptap.underline')}
        >
          <UnderlineIcon size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive("strike")}
          title={t('tiptap.strikethrough')}
        >
          <Strikethrough size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          isActive={editor.isActive("highlight")}
          title={t('tiptap.highlight')}
        >
          <Highlighter size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title={t('tiptap.bulletList')}
        >
          <List size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title={t('tiptap.orderedList')}
        >
          <ListOrdered size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          isActive={editor.isActive("taskList")}
          title={t('tiptap.taskList')}
        >
          <CheckSquare size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          title={t('tiptap.blockquote')}
        >
          <Quote size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={toggleCodeBlockStrict}
          isActive={editor.isActive("codeBlock")}
          title={t('tiptap.codeBlock')}
        >
          <FileCode size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title={t('tiptap.horizontalRule')}
        >
          <Minus size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={handleImageUpload} title={t('tiptap.insertImage')}>
          <ImagePlus size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          title={t('tiptap.insertTable')}
        >
          <Table2 size={iconSize} />
        </ToolbarButton>

        {/* 表格操作按钮（仅在光标在表格内时显示） */}
        {editor.isActive('table') && (
          <>
            <ToolbarDivider />
            <ToolbarButton
              onClick={() => editor.chain().focus().addRowAfter().run()}
              title={t('tiptap.addRowAfter')}
            >
              <span className="text-[10px] font-bold leading-none">+行</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteRow().run()}
              title={t('tiptap.deleteRow')}
            >
              <span className="text-[10px] font-bold leading-none text-red-500">-行</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().addColumnAfter().run()}
              title={t('tiptap.addColumnAfter')}
            >
              <span className="text-[10px] font-bold leading-none">+列</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteColumn().run()}
              title={t('tiptap.deleteColumn')}
            >
              <span className="text-[10px] font-bold leading-none text-red-500">-列</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteTable().run()}
              title={t('tiptap.deleteTable')}
            >
              <Trash2 size={iconSize - 2} className="text-red-500" />
            </ToolbarButton>
          </>
        )}

        <ToolbarDivider />

        {/* 缩进控制 —— 逻辑与 Tab/Shift-Tab 键盘快捷键完全一致 */}
        <ToolbarButton
          onClick={() => {
            if (editor.isActive("taskList")) {
              if (editor.chain().focus().sinkListItem("taskItem").run()) return;
            } else if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
              if (editor.chain().focus().sinkListItem("listItem").run()) return;
            }
            (editor.chain().focus() as any).changeIndent(1).run();
          }}
          title={t('tiptap.indent')}
        >
          <Indent size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (editor.isActive("taskList")) {
              if (editor.chain().focus().liftListItem("taskItem").run()) return;
            } else if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
              if (editor.chain().focus().liftListItem("listItem").run()) return;
            }
            (editor.chain().focus() as any).changeIndent(-1).run();
          }}
          title={t('tiptap.outdent')}
        >
          <Outdent size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        {/* 段落对齐 */}
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          isActive={editor.isActive({ textAlign: 'left' })}
          title={t('tiptap.alignLeft')}
        >
          <AlignLeft size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          isActive={editor.isActive({ textAlign: 'center' })}
          title={t('tiptap.alignCenter')}
        >
          <AlignCenter size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          isActive={editor.isActive({ textAlign: 'right' })}
          title={t('tiptap.alignRight')}
        >
          <AlignRight size={iconSize} />
        </ToolbarButton>

        {!isGuest && <ToolbarDivider />}

        {!isGuest && (
          <ToolbarButton onClick={openAIAssistant} title={t('tiptap.aiAssistant')}>
            <Sparkles size={iconSize} className="text-violet-500" />
          </ToolbarButton>
        )}
      </div>

      {/* Title */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-0">
        <input
          ref={titleRef}
          defaultValue={note.title}
          onChange={handleTitleChange}
          placeholder={t('tiptap.titlePlaceholder')}
          readOnly={!editable}
          className={cn(
            "w-full bg-transparent text-2xl font-bold text-tx-primary placeholder:text-tx-tertiary focus:outline-none",
            !editable && "cursor-default"
          )}
        />
        <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-2 text-[10px] text-tx-tertiary">
          <span>{t('tiptap.version')}{note.version}</span>
          <span className="max-md:hidden">·</span>
          <span>{t('tiptap.updatedAt')}{new Date(note.updatedAt + "Z").toLocaleString()}</span>
          <span className="max-md:hidden">·</span>
          <span>{wordStats.words}{t('tiptap.words')}</span>
          <span className="max-md:hidden">·</span>
          <span>{wordStats.charsNoSpace}{t('tiptap.chars')}</span>
        </div>
      </div>

      {/* Tag Bar：访客模式下隐藏（TagInput 依赖 AppProvider + 登录态 API） */}
      {!isGuest && (
        <div className="px-4 md:px-8 pb-2">
          <TagInput
            noteId={note.id}
            noteTags={note.tags || []}
            onTagsChange={onTagsChange}
          />
        </div>
      )}

      {/* Bubble menu for inline formatting */}
      {editor && (
        <BubbleMenu editor={editor}
          className="flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
        >
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive("bold")}
            title={t('tiptap.bold')}
          >
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive("italic")}
            title={t('tiptap.italic')}
          >
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            isActive={editor.isActive("underline")}
            title={t('tiptap.underline')}
          >
            <UnderlineIcon size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            isActive={editor.isActive("strike")}
            title={t('tiptap.strikethrough')}
          >
            <Strikethrough size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            isActive={editor.isActive("highlight")}
            title={t('tiptap.highlight')}
          >
            <Highlighter size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={toggleCodeBlockStrict}
            isActive={editor.isActive("codeBlock")}
            title={t('tiptap.codeBlock')}
          >
            <FileCode size={14} />
          </ToolbarButton>
          {!isGuest && (
            <>
              <div className="w-px h-4 bg-app-border mx-0.5" />
              <ToolbarButton onClick={openAIAssistant} title={t('tiptap.aiAssistant')}>
                <Sparkles size={14} className="text-violet-500" />
              </ToolbarButton>
            </>
          )}
        </BubbleMenu>
      )}

      {/* Editor content */}
      <div className="flex-1 overflow-auto px-4 md:px-8 pb-12">
        <EditorContent editor={editor} />
      </div>

      {/* Markdown 粘贴转换提示 Toast */}
      <AnimatePresence>
        {pasteToast && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg border text-sm font-medium backdrop-blur-sm",
              pasteToast.type === "converting" && "bg-accent-primary/10 border-accent-primary/20 text-accent-primary",
              pasteToast.type === "success" && "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400",
              pasteToast.type === "error" && "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
            )}
          >
            {pasteToast.type === "converting" && (
              <FileType size={16} className="animate-pulse" />
            )}
            {pasteToast.type === "success" && <Check size={16} />}
            {pasteToast.type === "error" && <AlertCircle size={16} />}
            <span>{pasteToast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 斜杠命令菜单 */}
      <SlashCommandsMenu
        editor={editor}
        items={getDefaultSlashCommands(t, handleImageUpload, openAIAssistant)}
      />

      {/* 图片预览 Lightbox */}
      <AnimatePresence>
        {previewImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) { setPreviewImage(null); } }}
            onWheel={handlePreviewWheel}
            onMouseMove={handlePreviewMouseMove}
            onMouseUp={handlePreviewMouseUp}
            onMouseLeave={handlePreviewMouseUp}
          >
            {/* 工具栏 */}
            <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
              <button
                onClick={() => setImageZoom(prev => Math.min(5, prev + 0.25))}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="放大"
              >
                <ZoomIn size={18} />
              </button>
              <button
                onClick={() => setImageZoom(prev => Math.max(0.1, prev - 0.25))}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="缩小"
              >
                <ZoomOut size={18} />
              </button>
              <button
                onClick={() => { setImageZoom(1); setImageDrag({ x: 0, y: 0 }); }}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="重置"
              >
                <RotateCcw size={18} />
              </button>
              <span className="text-white/70 text-xs font-mono min-w-[3rem] text-center">
                {Math.round(imageZoom * 100)}%
              </span>
              <button
                onClick={() => setPreviewImage(null)}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>
            {/* 图片 */}
            <motion.img
              src={previewImage}
              alt="preview"
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              transition={{ duration: 0.2 }}
              className="max-w-[90vw] max-h-[90vh] object-contain select-none"
              style={{
                transform: `scale(${imageZoom}) translate(${imageDrag.x / imageZoom}px, ${imageDrag.y / imageZoom}px)`,
                cursor: isDragging ? 'grabbing' : 'grab',
              }}
              onMouseDown={handlePreviewMouseDown}
              draggable={false}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Writing Assistant */}
      <AnimatePresence>
        {showAI && (
          <AIWritingAssistant
            selectedText={aiSelectedText}
            fullText={editor?.getText() || ""}
            onInsert={handleAIInsert}
            onReplace={handleAIReplace}
            onClose={() => setShowAI(false)}
            position={aiPosition}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 检测粘贴的多行纯文本是否看起来像代码/命令，而非中文自然语言段落。
 *
 * 策略：计算"中文字符密度"——如果文本中中文字符占比较高，说明是自然语言文本，
 * 不应自动包成 codeBlock。同时检测一些代码特征（缩进、大括号、分号结尾等）。
 *
 * 用例对比：
 *   - 代码：`const x = 1;\nif (x) {\n  return;\n}`       → true（无中文，有代码特征）
 *   - 运维文档：`#查看raid信息\nyum install megacli -y\n通过命令...` → false（中文占比高）
 *   - shell 命令：`ls -la\ncd /tmp\nmkdir test`           → true（无中文，命令格式）
 */
function looksLikeCode(text: string): boolean {
  // 统计中文字符数量（CJK统一汉字 + 扩展）
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
  const cjkCount = cjkChars ? cjkChars.length : 0;
  // 统计非空白可见字符总数
  const visibleChars = text.replace(/\s/g, "").length;
  if (visibleChars === 0) return false;

  const cjkRatio = cjkCount / visibleChars;

  // 如果中文字符占比 > 20%，大概率是自然语言文本而非代码
  if (cjkRatio > 0.2) return false;

  // 如果中文字符占比 > 8% 且没有明显的代码特征，也不当做代码
  if (cjkRatio > 0.08) {
    const lines = text.split("\n");
    let codeSignals = 0;
    for (const line of lines) {
      const trimmed = line.trimEnd();
      // 缩进（至少2空格或tab开头）
      if (/^(\s{2,}|\t)/.test(line) && trimmed.length > 0) codeSignals++;
      // 行尾分号、大括号
      if (/[;{}]\s*$/.test(trimmed)) codeSignals++;
      // 赋值语句
      if (/[=!<>]=|=>|->/.test(trimmed)) codeSignals++;
      // 函数调用 xxx(...)
      if (/\w+\(.*\)\s*[;{]?\s*$/.test(trimmed)) codeSignals++;
    }
    // 如果代码特征不够多，不当做代码
    if (codeSignals < lines.length * 0.3) return false;
  }

  return true;
}

/**
 * 检测粘贴的文本是否包含 Markdown 格式标记
 * 通过匹配多种 Markdown 语法特征来判断
 */
function looksLikeMarkdown(text: string): boolean {
  const lines = text.split("\n");
  let score = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // 标题：# ## ###
    if (/^#{1,6}\s+.+/.test(trimmed)) score += 2;
    // 代码块开始/结束：``` 或 ~~~
    else if (/^(`{3,}|~{3,})/.test(trimmed)) score += 2;
    // 表格行：| xxx | xxx |
    else if (/^\|.+\|$/.test(trimmed)) score += 2;
    // 表格分隔行：|---|---|
    else if (/^\|[\s:]*-{2,}[\s:]*\|/.test(trimmed)) score += 3;
    // 无序列表：- xxx 或 * xxx（排除分隔线）
    else if (/^[-*+]\s+(?!\[[ xX]\])/.test(trimmed) && !/^[-*_]{3,}$/.test(trimmed)) score += 1;
    // 有序列表：1. xxx
    else if (/^\d+\.\s+/.test(trimmed)) score += 1;
    // 引用块：> xxx
    else if (/^>\s+/.test(trimmed)) score += 1;
    // 粗体：**xxx**
    else if (/\*\*.+?\*\*/.test(trimmed)) score += 1;
    // 行内代码：`xxx`
    else if (/`.+?`/.test(trimmed)) score += 0.5;
    // 链接：[xxx](url)
    else if (/\[.+?\]\(.+?\)/.test(trimmed)) score += 1;
    // 任务列表：- [x] 或 - [ ]
    else if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) score += 2;
    // 水平线：--- *** ___
    else if (/^(---|\*\*\*|___)$/.test(trimmed)) score += 1;
  }

  // 得分阈值：至少需要 3 分才认为是 Markdown 内容
  // 单独的一行粗体或行内代码不应触发转换
  return score >= 3;
}

/**
 * 解析笔记内容（JSON / HTML / 纯文本）为 Tiptap 可用的 doc 结构
 */
function parseContent(content: string): any {
  if (!content || content === "{}") {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      // HTML 内容直接返回字符串，Tiptap 可以解析 HTML
      if (content.trim().startsWith("<")) {
        return content;
      }
      return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content }] }] };
    }
  }
  return content;
}
