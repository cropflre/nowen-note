import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useEditor, EditorContent, Extension, ReactNodeViewRenderer } from "@tiptap/react";
import { posToDOMRect } from "@tiptap/core";
import { AnimatePresence, motion } from "framer-motion";import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import ResizableImageView from "./ResizableImageView";
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
import { markdownToHtml as mdToFullHtml, detectFormat as detectContentFormat } from "@/lib/contentFormat";
import { api } from "@/lib/api";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Heading1, Heading2, Heading3,
  Quote, ImagePlus, CheckSquare, Highlighter, Minus, Undo, Redo,
  FileCode, Sparkles, X, ZoomIn, ZoomOut, RotateCcw,
  Table2, Indent, Outdent, AlignLeft, AlignCenter, AlignRight, Trash2,
  FileType, Check, AlertCircle, Info
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { Note, Tag } from "@/types";
import TagInput from "@/components/TagInput";
import AIWritingAssistant from "@/components/AIWritingAssistant";
import type { NoteEditorHandle, NoteEditorHeading, NoteEditorProps } from "@/components/editors/types";
import type { FormatMenuPayload } from "@/lib/desktopBridge";
import { sendFormatState } from "@/lib/desktopBridge";
import { SlashCommandsMenu, getDefaultSlashCommands, createSlashExtension, createSlashEventHandlers } from "@/components/SlashCommands";
import CodeBlockView from "@/components/CodeBlockView";
import MobileFloatingToolbar, { MobileToolbarItem } from "@/components/MobileFloatingToolbar";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";
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


// ---------------------------------------------------------------------------
// 粘贴 HTML 归一化：把"伪多行段落"拆成真正的多个 <p>
// ---------------------------------------------------------------------------
// 很多来源（微信/QQ/钉钉/飞书网页复制、Word、部分浏览器富文本）在 clipboard
// 的 text/html 里会把多行文本序列化成：
//     <p>行1<br>行2<br>行3</p>          ← 同一段落内多个 <br>
//     <div>行1</div><div>行2</div>       ← 多个 <div> 当段落
// 这种结构粘到 Tiptap 后 ProseMirror 会解析成**一个 paragraph 节点里多个
// hardBreak**，视觉上是多行，但块级操作（toggleHeading / setParagraph /
// blockquote）会把**整段**转换，就出现"只选一行却整段变标题"的 bug。
//
// 这里在粘贴进入 PM DOMParser 之前，把顶层的 <br> 拆成段落边界、把 <div>
// 统一升级为 <p>，让 PM 看到的是真正的多段落结构。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rescuePastedImages：从论坛 / 懒加载页面复制 HTML 时，<img src> 经常是
// 1×1 占位图（如 Discuz 的 static/image/common/none.gif），真正的图片地址
// 藏在 file / zoomfile / data-src / data-original / data-lazy-src 等自定义
// 属性里。这里把这些属性值"救"回到 src，并尝试把相对路径补成绝对 URL，
// 避免粘贴后图片完全消失或显示成 1×1 透明块。
//
// 选择第一个非空的"看起来像真正图片地址"的属性值；若 src 已经是绝对的
// http(s)/data:/blob: URL 则保留不动（不覆盖用户原本就正常的图）。
// ---------------------------------------------------------------------------
function rescuePastedImages(root: Element): void {
  // 1) 先扫一遍找出本片段内"任意一个绝对 URL 的 origin"，作为相对路径的 base。
  //    优先用 <a href>/<link href>/已经是绝对地址的 <img src>，因为 Discuz
  //    复制过来的 HTML 往往带有指向源站的链接（如附件下载链接）。
  let pasteBaseOrigin: string | null = null;
  const pickOrigin = (raw: string | null) => {
    if (pasteBaseOrigin || !raw) return;
    if (!/^https?:\/\//i.test(raw)) return;
    try {
      pasteBaseOrigin = new URL(raw).origin;
    } catch {
      /* ignore malformed */
    }
  };
  root.querySelectorAll("a[href]").forEach((a) => pickOrigin(a.getAttribute("href")));
  root.querySelectorAll("img").forEach((img) => {
    pickOrigin(img.getAttribute("src"));
    pickOrigin(img.getAttribute("file"));
    pickOrigin(img.getAttribute("zoomfile"));
    pickOrigin(img.getAttribute("data-src"));
    pickOrigin(img.getAttribute("data-original"));
  });

  // 2) 占位图特征：Discuz/typecho/常见 lazyload 库都用极小的 gif/png 占位，
  //    或干脆 src 为空、为 about:blank。命中即视为"需要救援"。
  const isPlaceholderSrc = (src: string | null): boolean => {
    if (!src) return true;
    const s = src.trim();
    if (!s || s === "about:blank") return true;
    // data:image/gif;base64,R0lGODlh...（1×1 透明 gif/png 占位）
    if (/^data:image\/(gif|png);base64,/i.test(s) && s.length < 200) return true;
    // Discuz 标准占位
    if (/\/none\.gif(\?|$)/i.test(s)) return true;
    if (/\/(blank|placeholder|spacer|grey|loading)\.(gif|png|svg)(\?|$)/i.test(s)) return true;
    return false;
  };

  // 3) 把相对/协议相对路径补成绝对 URL（找不到 base 则保持原样，让浏览器自行决定）
  const toAbsolute = (url: string): string => {
    const u = url.trim();
    if (!u) return u;
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.startsWith("//")) return `https:${u}`;
    if (!pasteBaseOrigin) return u;
    if (u.startsWith("/")) return `${pasteBaseOrigin}${u}`;
    return `${pasteBaseOrigin}/${u.replace(/^\.?\//, "")}`;
  };

  // 4) 救援每一个 <img>：按优先级挑一个有效的真实地址覆盖到 src
  root.querySelectorAll("img").forEach((img) => {
    const currentSrc = img.getAttribute("src");
    // src 已经是合法且非占位的远端/data URL → 不动
    if (currentSrc && /^(https?:|data:|blob:)/i.test(currentSrc) && !isPlaceholderSrc(currentSrc)) {
      return;
    }
    // 候选属性顺序：Discuz 的 zoomfile（点击放大原图）> file > 通用 lazyload 属性
    const candidates = [
      "zoomfile",
      "file",
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-actualsrc",
      "data-echo",
    ];
    let picked: string | null = null;
    for (const attr of candidates) {
      const v = img.getAttribute(attr);
      if (v && v.trim()) {
        picked = v.trim();
        break;
      }
    }
    // 候选都没有，但当前 src 是相对路径（非占位）→ 也尝试补全
    if (!picked && currentSrc && !isPlaceholderSrc(currentSrc)) {
      picked = currentSrc;
    }
    if (!picked) return; // 救不回来，留给 PM 决定（通常会被丢弃）
    const abs = toAbsolute(picked);
    if (abs && /^(https?:|data:|blob:)/i.test(abs)) {
      img.setAttribute("src", abs);
    }
  });

  // 5) Discuz 把 <img> 包在 <ignore_js_op> 里（一个 Discuz 自造标签，
  //    PM schema 认不出会被丢，连带 <img> 一起丢）。这里把它替换为 <span>。
  root.querySelectorAll("ignore_js_op").forEach((el) => {
    const span = el.ownerDocument.createElement("span");
    while (el.firstChild) span.appendChild(el.firstChild);
    el.replaceWith(span);
  });
}

function normalizePastedHtmlForBlocks(html: string): string {
  if (!html) return html;
  try {
    const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, "text/html");
    const root = doc.getElementById("__root");
    if (!root) return html;

    // 0) 先抢救图片：把 Discuz / 懒加载站点中藏在 file/zoomfile/data-src
    //    等属性里的"真正图片地址"提升到 src，并补全相对路径，
    //    避免后续 PM DOMParser 把"src 是占位 / 空 / 相对路径"的 <img> 节点丢掉。
    rescuePastedImages(root);

    // 1) 顶层 <div> 直接替换为 <p>（保留内部内联内容）
    //    注意只处理"直接子节点层"，不递归改动引用/表格内的 <div>。
    Array.from(root.children).forEach((child) => {
      if (child.tagName === "DIV") {
        const p = doc.createElement("p");
        while (child.firstChild) p.appendChild(child.firstChild);
        child.replaceWith(p);
      }
    });

    // 2) 递归遍历 block 元素内部：<p>/<h1..h6>/<li>/<blockquote> 里若出现顶层 <br>，
    //    就按 <br> 切成多个同类型的兄弟节点（对 <p> 最常见，对标题也适用）。
    const splitByTopLevelBr = (el: Element) => {
      const brs = Array.from(el.children).filter((c) => c.tagName === "BR");
      if (brs.length === 0) return;
      const parent = el.parentNode;
      if (!parent) return;
      // 收集每一段内容（按 <br> 切分的内联片段）
      const groups: Node[][] = [[]];
      Array.from(el.childNodes).forEach((n) => {
        if (n.nodeType === 1 && (n as Element).tagName === "BR") {
          groups.push([]);
        } else {
          groups[groups.length - 1].push(n);
        }
      });
      // 丢掉完全空白的首/尾段，中间空段保留为空段落（符合用户视觉预期）
      while (groups.length && isWhitespaceGroup(groups[0])) groups.shift();
      while (groups.length && isWhitespaceGroup(groups[groups.length - 1])) groups.pop();
      if (groups.length <= 1) return; // 没有实际切分效果
      const frag = doc.createDocumentFragment();
      groups.forEach((nodes) => {
        const clone = doc.createElement(el.tagName.toLowerCase());
        // 拷贝属性（保留 class/style 等）
        Array.from(el.attributes).forEach((a) => clone.setAttribute(a.name, a.value));
        nodes.forEach((n) => clone.appendChild(n));
        frag.appendChild(clone);
      });
      parent.replaceChild(frag, el);
    };

    const isWhitespaceGroup = (nodes: Node[]) =>
      nodes.every((n) => n.nodeType === 3 && !(n.nodeValue || "").trim());

    // 只拆顶层 block：<p> <h1..h6>，避免破坏列表/表格/代码块内部结构
    const topBlocks = Array.from(root.querySelectorAll(":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6"));
    topBlocks.forEach(splitByTopLevelBr);

    return root.innerHTML;
  } catch (e) {
    // 异常时不阻塞粘贴流程，返回原 HTML
    if (typeof console !== "undefined") console.warn("[normalizePastedHtmlForBlocks] failed:", e);
    return html;
  }
}


// ---------------------------------------------------------------------------
// 智能 toggleHeading：先把当前段落里的 hardBreak 拆成独立段落，再 toggle
// ---------------------------------------------------------------------------
// 对应用户场景：老数据里已经存在"一个 <p> + 多个 <br>"的伪多行段落。
// 若用户只选中其中几个字点 H1，期望只把这一行转成标题，而不是整段。
//
// 策略：
//   1) 找到选区所覆盖的 paragraph 节点范围；
//   2) 对这些 paragraph 里的 hardBreak，从后往前遍历（避免位置偏移问题），
//      在 hardBreak 处执行 split（把前后切成两个 paragraph），并删除 hardBreak
//      自身；
//   3) split 完成后，用户光标会自然落到他原本选中的那一行对应的新段落里；
//   4) 最后调用标准 toggleHeading，只影响该段。
//
// 如果原段落里没有 hardBreak，直接走标准 toggleHeading（无性能损失）。
// ---------------------------------------------------------------------------
function toggleHeadingSmart(editor: any, level: 1 | 2 | 3 | 4 | 5 | 6) {
  if (!editor || editor.isDestroyed) return;
  try {
    const { state } = editor;
    const hardBreakType = state.schema.nodes.hardBreak;
    if (!hardBreakType) {
      editor.chain().focus().toggleHeading({ level }).run();
      return;
    }
    const { from, to } = state.selection;

    // 找出选区覆盖的"块级文本节点"（paragraph / heading）的位置区间
    const blocks: Array<{ from: number; to: number }> = [];
    state.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (node.type.name === "paragraph" || node.type.name === "heading") {
        blocks.push({ from: pos, to: pos + node.nodeSize });
        return false; // 不再深入（hardBreak 在叶子内部）
      }
      return true;
    });
    if (blocks.length === 0) {
      editor.chain().focus().toggleHeading({ level }).run();
      return;
    }

    // 收集所有需要拆的 hardBreak 绝对位置（倒序处理）
    const breakPositions: number[] = [];
    blocks.forEach((b) => {
      state.doc.nodesBetween(b.from, b.to, (node: any, pos: number) => {
        if (node.type === hardBreakType) breakPositions.push(pos);
      });
    });

    if (breakPositions.length === 0) {
      editor.chain().focus().toggleHeading({ level }).run();
      return;
    }

    // 倒序拆分：在每个 hardBreak 处 split paragraph 并删除 hardBreak。
    // tr.delete(pos, pos+1) + tr.split(pos) 会把 hardBreak 所在位置切成两个段落。
    const tr = state.tr;
    // 在未应用中间事务时，同一份 doc 上所有位置仍相对稳定；倒序保证前面位置不被影响。
    breakPositions.sort((a, b) => b - a);
    breakPositions.forEach((pos) => {
      // 删除 hardBreak（1 个位置），然后在原位置 split 到 paragraph 层
      tr.delete(pos, pos + 1);
      tr.split(pos);
    });
    editor.view.dispatch(tr);

    // split 后再触发 toggleHeading：此时光标所在段落就是单行
    editor.chain().focus().toggleHeading({ level }).run();
  } catch (e) {
    if (typeof console !== "undefined") console.warn("[toggleHeadingSmart] fallback:", e);
    editor.chain().focus().toggleHeading({ level }).run();
  }
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

/**
 * 大纲/跳转条目：直接复用共享的 NoteEditorHeading。
 * 保留 `HeadingItem` 名字供历史 `import { HeadingItem } from "./TiptapEditor"` 的引用。
 */
export type HeadingItem = NoteEditorHeading;

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

/**
 * TiptapEditor props 契约：完全继承 NoteEditorProps，保证和 MarkdownEditor 100% 对齐。
 * 若需要 Tiptap 独有的 prop，请在此处 extends 扩展，而非另起炉灶。
 */
type TiptapEditorProps = NoteEditorProps;

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

export default forwardRef<NoteEditorHandle, TiptapEditorProps>(function TiptapEditor(
  { note, onUpdate, onTagsChange, onHeadingsChange, onEditorReady, editable = true, isGuest = false },
  ref,
) {
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
  // 编辑器是否聚焦 —— 用来控制移动端浮动工具栏是否显示
  // （未聚焦时键盘其实已经收起，这里是双重保险：避免聚焦到标题栏时误显示）
  const [editorFocused, setEditorFocused] = useState(false);
  // 移动端软键盘是否弹起；用于在原生 + 键盘弹起时隐藏顶部工具栏（走底部浮动工具栏）
  const { visible: keyboardOpen } = useKeyboardVisible();
  const dragStart = useRef({ x: 0, y: 0, imgX: 0, imgY: 0 });
  const { t, i18n } = useTranslation();

  // ---------- 选区气泡菜单（划词弹出） ----------
  // 手动实现，不依赖 Tiptap 内置 BubbleMenu（v3 下有 overflow-auto 裁剪问题）
  const [bubble, setBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false, top: 0, left: 0,
  });
  // 图片选中时的快捷尺寸气泡
  const [imageBubble, setImageBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false, top: 0, left: 0,
  });

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
  // "confirm" 变体：检测到 MD 语法后询问用户是否转换，携带 action 按钮回调
  type PasteToastState =
    | { type: "converting" | "success" | "error"; message: string }
    | { type: "confirm"; message: string; actionLabel: string; onAction: () => void };
  const [pasteToast, setPasteToast] = useState<PasteToastState | null>(null);
  const pasteToastTimer = useRef<NodeJS.Timeout | null>(null);

  const showPasteToast = useCallback((type: "converting" | "success" | "error", message: string, duration = 2500) => {
    if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
    setPasteToast({ type, message });
    if (type !== "converting") {
      pasteToastTimer.current = setTimeout(() => setPasteToast(null), duration);
    }
  }, []);

  // confirm 变体专用：8 秒自动消失，点按钮或 × 立即关闭
  const showPasteConfirmToast = useCallback(
    (message: string, actionLabel: string, onAction: () => void, duration = 8000) => {
      if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
      setPasteToast({ type: "confirm", message, actionLabel, onAction });
      pasteToastTimer.current = setTimeout(() => setPasteToast(null), duration);
    },
    []
  );

  const dismissPasteToast = useCallback(() => {
    if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
    setPasteToast(null);
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

  /**
   * 本编辑器最近一次派发给 onUpdate 的 content 字符串。
   *
   * 作用：父级 EditorPane 保存成功后会把 `content` 回填到 `activeNote`，
   * 这会让本组件的 `note.content` 引用变化并触发
   * `useEffect([note.id, note.content])` 去 setContent —— 如果恰好 setContent
   * 的就是"自己刚派出去的那份"，没有意义且可能打断正在继续输入的用户。
   *
   * 守卫策略：
   *   - onUpdate 派出前把 JSON 记到这里
   *   - 同步 effect 里先比对：note.content === lastEmittedContentRef.current 就跳过
   *   - 其他来源（MD 编辑器保存、版本恢复、切换笔记）的变化不会等于这个值，
   *     走正常 setContent 路径
   */
  const lastEmittedContentRef = useRef<string | null>(null);

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
      // Image 扩展：在原扩展基础上 (1) 新增 width/height 可持久化属性；
      //             (2) 挂 ResizableImageView，提供选中后四角拖拽改宽度的能力。
      // 序列化 DOM 仍是一个普通 <img>，width/height 作为 HTML 属性，
      // 因此所有导出路径（zip/markdown/分享页/SSR）都无需改动。
      Image.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            width: {
              default: null,
              parseHTML: (element) => {
                const raw = element.getAttribute("width");
                if (!raw) return null;
                const n = parseInt(raw, 10);
                return Number.isFinite(n) && n > 0 ? n : null;
              },
              renderHTML: (attrs) => {
                if (attrs.width == null) return {};
                return { width: attrs.width };
              },
            },
            height: {
              default: null,
              parseHTML: (element) => {
                const raw = element.getAttribute("height");
                if (!raw) return null;
                const n = parseInt(raw, 10);
                return Number.isFinite(n) && n > 0 ? n : null;
              },
              renderHTML: (attrs) => {
                if (attrs.height == null) return {};
                return { height: attrs.height };
              },
            },
          };
        },
        addNodeView() {
          return ReactNodeViewRenderer(ResizableImageView);
        },
      }).configure({
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
          //    走 /api/attachments 上传接口：写磁盘 + 落 attachments 行，
          //    编辑器插入的 <img> 引用服务端 URL，避免内联 base64 把文档体积撑大。
          const items = event.clipboardData?.items;
          if (items) {
            for (let i = 0; i < items.length; i++) {
              if (items[i].type.startsWith("image/")) {
                const file = items[i].getAsFile();
                if (file) {
                  const currentNote = noteRef.current;
                  const insertAtSrc = (src: string) => {
                    const { state: editorState, dispatch } = view;
                    const node = editorState.schema.nodes.image?.create({ src });
                    if (node) {
                      const tr = editorState.tr.replaceSelectionWith(node);
                      dispatch(tr);
                    }
                  };
                  if (currentNote?.id) {
                    showPasteToast("converting", t("tiptap.imageUploading"));
                    api.attachments
                      .upload(currentNote.id, file)
                      .then(({ url }) => {
                        insertAtSrc(url);
                        showPasteToast("success", t("tiptap.imageUploadSuccess"));
                      })
                      .catch((err) => {
                        console.error("Attachment upload failed, falling back to base64:", err);
                        showPasteToast("error", t("tiptap.imageUploadFailed"));
                        // 上传失败兜底：仍用 base64 插入，保证用户不丢失截图
                        const reader = new FileReader();
                        reader.onload = (e) => {
                          const src = e.target?.result as string;
                          if (src) insertAtSrc(src);
                        };
                        reader.readAsDataURL(file);
                      });
                  } else {
                    // 没有 note 上下文（理论上不应发生）：退回 base64
                    const reader = new FileReader();
                    reader.onload = (e) => {
                      const src = e.target?.result as string;
                      if (src) insertAtSrc(src);
                    };
                    reader.readAsDataURL(file);
                  }
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

          // 4) Markdown 纯文本：不自动转换，先原样插入纯文本并弹 confirm toast，
          //    用户点击"立即转换样式"时再用原始文本替换刚插入的那段范围。
          if (text && looksLikeMarkdown(text)) {
            const { state, dispatch } = view;
            // 记录插入起点，用于后续按 from..to 范围替换
            const insertFrom = state.selection.from;
            const tr = state.tr.insertText(text);
            dispatch(tr);
            // 注意：不能用 insertFrom + text.length，因为 ProseMirror 把 \n 转成段落节点，
            // 每个节点边界占 2 个位置，实际偏移远大于字符数。
            // insertText 后光标移到末尾，直接读 view.state.selection.to 即为真实终点。
            const insertTo = view.state.selection.to;

            // 构造转换动作：把 [insertFrom, insertTo] 替换为转换后的 HTML 切片。
            // 注意 view 在此闭包中长期有效（React 卸载时编辑器会 destroy，届时 isDestroyed 为真）。
            const doConvert = () => {
              try {
                if (view.isDestroyed) return;
                const convertedHtml = markdownToSimpleHtml(text);
                const parser = ProseMirrorDOMParser.fromSchema(view.state.schema);
                const tempDiv = document.createElement("div");
                tempDiv.innerHTML = convertedHtml;
                const slice = parser.parseSlice(tempDiv);
                // 替换范围要 clamp 到当前文档长度，防止用户此后又编辑/删除了部分内容
                const docSize = view.state.doc.content.size;
                const from = Math.min(insertFrom, docSize);
                const to = Math.min(insertTo, docSize);
                const replaceTr = view.state.tr.replaceRange(from, to, slice).scrollIntoView();
                view.dispatch(replaceTr);
                showPasteToast("success", t("tiptap.markdownConvertSuccess"));
              } catch (err) {
                console.error("Markdown paste conversion failed:", err);
                showPasteToast("error", t("tiptap.markdownConvertError"));
              }
            };

            showPasteConfirmToast(
              t("tiptap.markdownDetected"),
              t("tiptap.markdownConvertNow"),
              doConvert
            );
            return true;
          }

          // 5) 只有 HTML 没有多行纯文本（如从网页复制的富文本片段）：解析插入
          //    先归一化：把 <div>/<br> 伪多行段落拆成真正的多个 <p>，
          //    避免后续块级操作（toggleHeading 等）误把整段转换。
          if (html && html.trim().length > 0) {
            const { state, dispatch } = view;
            const parser = ProseMirrorDOMParser.fromSchema(state.schema);
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = normalizePastedHtmlForBlocks(html);
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
        lastEmittedContentRef.current = json;
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
    lastEmittedContentRef.current = json;
    onUpdateRef.current({ content: json, contentText: text, title });
    try {
      toast.success(t('tiptap.saved') || 'Saved');
    } catch {}
  };

  /**
   * 对父组件暴露命令式 API：
   *   - flushSave(): 切换编辑器 / 切换笔记时立即把 pending 的 debounce 更新写出去，
   *                 防止丢字。这里**不弹 toast**（避免切换瞬间刷屏），
   *                 与 Ctrl/Cmd+S 的交互保持分离。
   *   - getSnapshot(): 同步读取编辑器当前内容。flushSave 只能触发**异步** PUT，
   *                 切换 RTE→MD 时若只靠 flushSave，MD 一 mount 读到的还是
   *                 切换前的旧 note.content（PUT 没回包），在几百毫秒内会闪烁
   *                 旧内容甚至丢失用户最近的输入。父组件可以调 getSnapshot()
   *                 拿到最新 JSON+纯文本，立即回填 activeNote 后再 setEditorMode，
   *                 MD 侧的 normalizeToMarkdown 就能直接基于最新内容初始化。
   */
  useImperativeHandle(
    ref,
    () => ({
      flushSave: () => {
        if (!editor) return;
        if (!debounceTimer.current) return;
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        const json = JSON.stringify(editor.getJSON());
        const text = editor.getText();
        const title = titleRef.current?.value || noteRef.current.title;
        lastEmittedContentRef.current = json;
        onUpdateRef.current({ content: json, contentText: text, title });
      },
      discardPending: () => {
        // 切换编辑器时调用方已经自己 PUT 规范化内容，清掉 debounce 避免竞态
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
      },
      getSnapshot: () => {
        if (!editor) return null;
        return {
          content: JSON.stringify(editor.getJSON()),
          contentText: editor.getText(),
        };
      },
      isReady: () => !!editor && !editor.isDestroyed,
    }),
    [editor],
  );

  // 切换笔记时同步编辑器内容
  const lastSyncedNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    // 切换笔记时立即清理旧的 debounce timer，防止旧笔记的保存请求泄漏
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }

    if (editor && note) {
      // 笔记切换时重置 lastEmitted 守卫（新笔记的 content 肯定要真正 setContent）
      if (lastSyncedNoteIdRef.current !== note.id) {
        lastEmittedContentRef.current = null;
        lastSyncedNoteIdRef.current = note.id;
      }

      // 自写自读守卫：如果 note.content 正是自己上次派出去的那份 JSON 字符串，
      // 说明这次 effect 是 EditorPane 保存完成后回填引起的 → 编辑器 DOM 已是
      // 最新，不需要 setContent（否则会打断继续输入 / 产生光标抖动）。
      if (
        lastEmittedContentRef.current !== null &&
        note.content === lastEmittedContentRef.current
      ) {
        // 仍然刷新字数/大纲，保证状态栏和大纲与实际内容同步
        setWordStats(computeStats(editor.getText()));
        onHeadingsChange?.(extractHeadings(editor));
        if (titleRef.current && titleRef.current.value !== note.title) {
          titleRef.current.value = note.title;
        }
        return;
      }

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
        // 外部驱动的 setContent 之后，本编辑器当前持有的 content 不再等于
        // 自己之前派出去的值（现在持有的是 parsed 后再重新 serialize 的版本），
        // 把 lastEmitted 清掉，避免后续误判为"自写"。
        lastEmittedContentRef.current = null;
      }
      setWordStats(computeStats(editor.getText()));
      onHeadingsChange?.(extractHeadings(editor));
    }
    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
  }, [note.id, note.content]);
  //   ^^^^^^^^^^^^^^^^^^^^^^
  //   依赖含 content 的完整语义（更新版）：
  //
  //   父组件 EditorPane.handleUpdate 现在会把保存成功的 content 回填到 activeNote，
  //   这样切换编辑器 (MD ↔ RTE) 时双方都能看到最新内容。但为避免 "自己刚派的
  //   JSON 又被 setContent 回来" 打断输入，本 effect 内用 lastEmittedContentRef
  //   做自写自读守卫。命中则 no-op，否则才执行真正的 setContent。
  //
  //   触发时机：
  //   1) 本编辑器打字保存：content 回填 == lastEmitted → 守卫命中 → 不重放。
  //   2) 对侧编辑器保存后切回来：content 不等于 lastEmitted → 正常 setContent。
  //   3) 版本恢复 / 切换笔记 / 外部修改：同上，走正常 setContent。

  // ---------- 标题单独同步 ----------
  //
  // 标题 input 是非受控的（`defaultValue={note.title}`），
  // 上面的主 effect 只在 [note.id, note.content] 变化时才会跑。
  // 当外部只改动 title（典型：点"AI 生成标题"按钮，后端返回新标题 → setActiveNote），
  // content 没变，主 effect 不触发，DOM 里的标题永远保持旧值——用户会以为
  //「AI 生成标题没生效」。这里加一个专用 effect 监听 note.title 即可。
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    if (el.value !== note.title) {
      el.value = note.title;
    }
  }, [note.title]);

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
  //
  // 行为分流（解决"点图片立即放大、调不出 ResizableImageView 的尺寸手柄"问题）：
  //   - 只读态（!editable）：保持原行为，单击图片即弹 Lightbox 预览，符合阅读期望。
  //   - 编辑态：
  //       * 单击  → 让 ProseMirror 选中图片节点，ResizableImageView 显示四角手柄。
  //                 这里只需"不打开预览"即可（选中由 ProseMirror 默认行为完成）。
  //       * 双击  → 打开 Lightbox 预览原图，相当于显式"我要看大图"的意图，
  //                 不会和拖动手柄改尺寸的操作互相干扰。
  //
  // 注意：handle 元素位于图片右下角等四角处，使用 pointer-events:auto 但
  //   onMouseDown 会 stopPropagation，所以拖手柄时不会冒泡到这里触发预览。
  useEffect(() => {
    if (!editor) return;

    const isEditorImage = (el: EventTarget | null): el is HTMLImageElement => {
      const node = el as HTMLElement | null;
      return !!node && node.tagName === "IMG" && !!node.closest(".ProseMirror");
    };

    const openPreview = (img: HTMLImageElement) => {
      const src = img.src;
      if (!src) return;
      setPreviewImage(src);
      setImageZoom(1);
      setImageDrag({ x: 0, y: 0 });
    };

    // 单击：仅在只读态下打开预览；编辑态保留给 ProseMirror 做节点选择。
    const handleClick = (e: MouseEvent) => {
      if (!isEditorImage(e.target)) return;
      if (editor.isEditable) return; // 编辑态：让出单击给"选中→出手柄"
      openPreview(e.target as HTMLImageElement);
    };

    // 双击：编辑态下显式"打开大图预览"。只读态此时已经走 click 了，
    // 不必重复处理（双击在只读态会被 click 先消费一次但行为一致）。
    const handleDblClick = (e: MouseEvent) => {
      if (!isEditorImage(e.target)) return;
      if (!editor.isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      openPreview(e.target as HTMLImageElement);
    };

    const editorDom = editor.view.dom;
    editorDom.addEventListener("click", handleClick);
    editorDom.addEventListener("dblclick", handleDblClick);
    return () => {
      editorDom.removeEventListener("click", handleClick);
      editorDom.removeEventListener("dblclick", handleDblClick);
    };
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

  // 跟踪编辑器聚焦状态（给移动端浮动工具栏用）
  useEffect(() => {
    if (!editor) return;
    const onFocus = () => setEditorFocused(true);
    const onBlur = () => setEditorFocused(false);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    // 初始状态
    setEditorFocused(editor.isFocused);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  // ---------- 手动选区气泡菜单定位 ----------
  // 监听 selectionUpdate / blur，计算浮动菜单坐标（fixed 定位，视口坐标）
  useEffect(() => {
    if (!editor) return;

    const updateBubble = () => {
      const { state, view } = editor;
      const { selection } = state;
      const { from, to, empty } = selection;

      // 编辑器失焦或空选区 → 关闭所有气泡
      if (!view.hasFocus() || empty) {
        setBubble(b => b.open ? { ...b, open: false } : b);
        setImageBubble(b => b.open ? { ...b, open: false } : b);
        return;
      }

      const isImage = editor.isActive("image");

      if (isImage) {
        // 图片选区 → 显示图片尺寸气泡
        setBubble(b => b.open ? { ...b, open: false } : b);
        const rect = posToDOMRect(view, from, to);
        const top = Math.max(8, rect.top - 44);
        const cx = rect.left + rect.width / 2;
        const left = Math.max(8, Math.min(cx - 140, window.innerWidth - 290));
        setImageBubble({ open: true, top, left });
      } else {
        // 文本选区 → 显示格式化气泡
        setImageBubble(b => b.open ? { ...b, open: false } : b);
        // 若文本长度为 0（全是不可见字符）也跳过
        const text = state.doc.textBetween(from, to, " ");
        if (!text.trim().length) {
          setBubble(b => b.open ? { ...b, open: false } : b);
          return;
        }
        const rect = posToDOMRect(view, from, to);
        const top = Math.max(8, rect.top - 44);
        const cx = rect.left + rect.width / 2;
        const left = Math.max(8, Math.min(cx - 110, window.innerWidth - 230));
        setBubble({ open: true, top, left });
      }
    };

    const onBlur = () => {
      // 延迟一帧关闭，避免点击气泡菜单按钮时因 blur 而菜单消失
      requestAnimationFrame(() => {
        if (!editor.view.hasFocus()) {
          setBubble(b => b.open ? { ...b, open: false } : b);
          setImageBubble(b => b.open ? { ...b, open: false } : b);
        }
      });
    };

    editor.on("selectionUpdate", updateBubble);
    editor.on("blur", onBlur);
    return () => {
      editor.off("selectionUpdate", updateBubble);
      editor.off("blur", onBlur);
    };
  }, [editor]);

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

  /**
   * 桌面端格式菜单桥（macOS 原生菜单 / 快捷键 → Tiptap）
   * ----------------------------------------------------------------
   * 监听 window "nowen:format" 自定义事件，由 `useDesktopMenuBridge`（App.tsx）
   * 在收到 Electron 主进程 "menu:format" IPC 时派发。payload 形如：
   *   { mark: "bold" | "italic" | "underline" | "strike" | "code" }
   *   { node: "heading", level: 1..6 }
   *   { node: "paragraph" }
   *
   * 为什么直接监听 window 事件（而不是通过 ref 暴露 runFormat）：
   *   - editor 是 TiptapEditor 闭包内变量，穿 ref 会污染 NoteEditorHandle 合约；
   *   - EditorPane 同一时刻只会渲染一个 TiptapEditor（MD/HTML 模式时不挂载），
   *     不存在多实例竞态；即使在 RTE 模式下也只有一个 subscription；
   *   - 当编辑器未挂载（切到 MD 模式），格式菜单本就应该无响应——
   *     没有 subscriber 自然 no-op，语义正确。
   *
   * 只在 editable 且 editor 已就绪时生效；editor 未就绪 / 只读模式下忽略，避免
   * `chain()` 在被销毁的 view 上报错。
   */
  useEffect(() => {
    if (!editor || !editable) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<FormatMenuPayload>).detail;
      if (!detail || editor.isDestroyed) return;

      const chain = editor.chain().focus();
      if (detail.mark) {
        switch (detail.mark) {
          case "bold":      chain.toggleBold().run();      break;
          case "italic":    chain.toggleItalic().run();    break;
          case "underline": chain.toggleUnderline().run(); break;
          case "strike":    chain.toggleStrike().run();    break;
          case "code":      chain.toggleCode().run();      break;
        }
        return;
      }
      if (detail.node === "heading" && detail.level) {
        const lvl = detail.level as 1 | 2 | 3 | 4 | 5 | 6;
        // 用 smart 版本：若当前段落含 <br>（hardBreak），先拆成独立段落再 toggle
        toggleHeadingSmart(editor, lvl);
        return;
      }
      if (detail.node === "paragraph") {
        chain.setParagraph().run();
      }
    };
    window.addEventListener("nowen:format", handler as EventListener);
    return () => window.removeEventListener("nowen:format", handler as EventListener);
  }, [editor, editable]);

  /**
   * 原生菜单 checked 同步（Electron / macOS）
   * ----------------------------------------------------------------
   * HIG：菜单项应反映当前上下文状态——当前选区已加粗，则"格式 → 加粗"旁显示 ✓。
   *
   * 实现思路：
   *   - 订阅 Tiptap 的 `selectionUpdate`/`transaction` 事件，采集布尔快照；
   *   - 节流 100ms：人眼 10fps 足够感知菜单勾选切换，更高频只是白白烧 IPC；
   *   - 浅比较去重：大多数键盘输入不改变格式状态，去重后 IPC 调用量降至 ~0。
   *   - 编辑器卸载 / 失焦时发 null，让主进程清空所有 checked（避免"残影"）。
   *
   * 仅在 Electron 环境下有效；Web / 移动端 window.nowenDesktop 不存在，直接短路。
   *
   * Markdown 模式下 TiptapEditor 根本没挂载，自然不会上报——符合语义：
   * 菜单 checked 反映的始终是"当前正在编辑的那个上下文"。MD 未来若需要可以
   * 复用同一通道，这里不展开。
   */
  useEffect(() => {
    if (!editor) return;

    let lastKey = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (editor.isDestroyed) return;
      const state = {
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        code: editor.isActive("code"),
        heading1: editor.isActive("heading", { level: 1 }),
        heading2: editor.isActive("heading", { level: 2 }),
        heading3: editor.isActive("heading", { level: 3 }),
        paragraph: editor.isActive("paragraph"),
      };
      // 浅去重：把布尔值串成 9-bit 字符串，相等则不发 IPC
      const key = Object.values(state).map((v) => (v ? "1" : "0")).join("");
      if (key === lastKey) return;
      lastKey = key;
      sendFormatState(state);
    };

    const schedule = () => {
      if (timer) return; // 100ms 窗口内合并多个事件
      timer = setTimeout(flush, 100);
    };

    const onBlur = () => {
      // blur 立即清空：用户切到别处时菜单不应保留旧勾选
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastKey = "";
      sendFormatState(null);
    };

    editor.on("selectionUpdate", schedule);
    editor.on("transaction", schedule);
    editor.on("focus", schedule);
    editor.on("blur", onBlur);

    // 挂载时推一次初始状态
    schedule();

    return () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      editor.off("selectionUpdate", schedule);
      editor.off("transaction", schedule);
      editor.off("focus", schedule);
      editor.off("blur", onBlur);
      // 卸载清空，避免切到 MD 模式后菜单仍显示 Tiptap 的旧状态
      sendFormatState(null);
    };
  }, [editor]);

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
      const currentNote = noteRef.current;
      const insertAtSrc = (src: string) => {
        editor.chain().focus().setImage({ src }).run();
      };
      if (currentNote?.id) {
        // 走 /api/attachments：写磁盘 + 记录 attachments 表，编辑器只引用 URL
        toast.info(t("tiptap.imageUploading") || "Uploading image...");
        api.attachments
          .upload(currentNote.id, file)
          .then(({ url }) => {
            insertAtSrc(url);
            toast.success(t("tiptap.imageUploadSuccess") || "Image uploaded");
          })
          .catch((err) => {
            console.error("Attachment upload failed, falling back to base64:", err);
            toast.error(t("tiptap.imageUploadFailed") || "Image upload failed");
            // 兜底：失败时退回 base64，保证用户仍可插图
            const reader = new FileReader();
            reader.onload = (e) => {
              const src = e.target?.result as string;
              if (src) insertAtSrc(src);
            };
            reader.readAsDataURL(file);
          });
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          const src = e.target?.result as string;
          if (src) insertAtSrc(src);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }, [editor, t]);

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

  /**
   * 把一段可能是 Markdown 的文本注入到编辑器的 [from, to] 范围。
   * - 若检测到 Markdown 语法：直接转换为富文本 HTML 后插入，并弹 success toast 告知用户。
   * - 否则：作为纯文本插入。
   *
   * 注意：不走"先插纯文本再替换"的路径，因为 ProseMirror insertText 后
   * 文档位置偏移（\n → 段落节点，每个节点边界占 2 个位置）与 text.length 不一致，
   * 会导致 replaceRange 范围计算错误、内容大量丢失。
   */
  const insertWithMarkdownDetect = useCallback((text: string, from: number, to: number) => {
    if (!editor) return;
    const view = editor.view;

    if (looksLikeMarkdown(text)) {
      // 直接转换为富文本 HTML 后插入，一步到位
      try {
        const convertedHtml = markdownToSimpleHtml(text);
        const parser = ProseMirrorDOMParser.fromSchema(view.state.schema);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = convertedHtml;
        const slice = parser.parseSlice(tempDiv);
        const docSize = view.state.doc.content.size;
        const safeFrom = Math.min(from, docSize);
        const safeTo = Math.min(to, docSize);
        const tr = view.state.tr.replaceRange(safeFrom, safeTo, slice).scrollIntoView();
        view.dispatch(tr);
        editor.chain().focus().run();
        showPasteToast("success", t("tiptap.markdownConvertSuccess"));
      } catch (err) {
        console.error("AI Markdown conversion failed:", err);
        // 降级：纯文本插入
        const tr = view.state.tr.insertText(text, from, to);
        view.dispatch(tr);
        editor.chain().focus().run();
      }
    } else {
      // 非 Markdown：纯文本插入
      const tr = view.state.tr.insertText(text, from, to);
      view.dispatch(tr);
      editor.chain().focus().run();
    }
  }, [editor, showPasteToast, t]);

  const handleAIInsert = useCallback((text: string) => {
    if (!editor) return;
    const { to } = editor.state.selection;
    insertWithMarkdownDetect(text, to, to);
  }, [editor, insertWithMarkdownDetect]);

  const handleAIReplace = useCallback((text: string) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    insertWithMarkdownDetect(text, from, to);
  }, [editor, insertWithMarkdownDetect]);

  if (!editor) return null;

  const iconSize = 15;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar
          键盘弹起时（仅原生）隐藏，改由底部 MobileFloatingToolbar 提供常用命令。
          CSS 变量 --keyboard-height 由 useKeyboardLayout 维护；此处通过 state 读取，
          避免纯 CSS 方案下 display:none 切换时 sticky/flex 的尺寸突变导致光标跳动。 */}
      <div
        className={cn(
          "flex items-center gap-0.5 px-4 py-2 border-b border-app-border bg-app-surface/50 md:flex-wrap overflow-x-auto hide-scrollbar touch-pan-x transition-colors",
          keyboardOpen && "hidden",
        )}
      >
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title={t('tiptap.undo')}>
          <Undo size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title={t('tiptap.redo')}>
          <Redo size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 1)}
          isActive={editor.isActive("heading", { level: 1 })}
          title={t('tiptap.heading1')}
        >
          <Heading1 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 2)}
          isActive={editor.isActive("heading", { level: 2 })}
          title={t('tiptap.heading2')}
        >
          <Heading2 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 3)}
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

      {/* 选区气泡菜单：文本格式化（手动实现，fixed 定位，避免被 overflow-auto 裁剪） */}
      {editor && editable && bubble.open && (
        <div
          className="fixed z-50 flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
          style={{ top: bubble.top, left: bubble.left }}
          onMouseDown={(e) => e.preventDefault()} // 阻止点击按钮时 editor blur
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
        </div>
      )}

      {/* 选区气泡菜单：图片快捷尺寸 */}
      {editor && editable && imageBubble.open && (
        <div
          className="fixed z-50 flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
          style={{ top: imageBubble.top, left: imageBubble.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {[
            { key: "25", label: t("tiptap.imageSize25"), ratio: 0.25 },
            { key: "50", label: t("tiptap.imageSize50"), ratio: 0.5 },
            { key: "75", label: t("tiptap.imageSize75"), ratio: 0.75 },
            { key: "100", label: t("tiptap.imageSize100"), ratio: 1 },
          ].map((s) => (
            <ToolbarButton
              key={s.key}
              title={s.label}
              onClick={() => {
                const root = editor.view.dom as HTMLElement;
                const contentWidth = root.clientWidth || 640;
                const target = Math.round(contentWidth * s.ratio);
                editor
                  .chain()
                  .focus()
                  .updateAttributes("image", { width: target })
                  .run();
              }}
            >
              <span className="text-xs px-1">{s.label}</span>
            </ToolbarButton>
          ))}
          <div className="w-px h-4 bg-app-border mx-0.5" />
          <ToolbarButton
            title={t("tiptap.imageSizeOriginalTitle")}
            onClick={() => {
              editor
                .chain()
                .focus()
                .updateAttributes("image", { width: null, height: null })
                .run();
            }}
          >
            <span className="text-xs px-1">{t("tiptap.imageSizeOriginal")}</span>
          </ToolbarButton>
        </div>
      )}

      {/* Editor content
          paddingBottom 同时吃掉键盘高度和底部浮动工具栏高度，保证最后一行文字
          不被键盘或底部浮动工具栏遮挡（`--mobile-toolbar-h` 由 MobileFloatingToolbar
          按显示状态维护，未显示时为 0）。详见 useKeyboardLayout 注释。 */}
      <div
        className="flex-1 overflow-auto px-4 md:px-8 pb-12"
        style={{ paddingBottom: "calc(3rem + var(--keyboard-height, 0px) + var(--mobile-toolbar-h, 0px))" }}
      >
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
              pasteToast.type === "error" && "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400",
              pasteToast.type === "confirm" && "bg-sky-500/10 border-sky-500/20 text-sky-600 dark:text-sky-400"
            )}
          >
            {pasteToast.type === "converting" && (
              <FileType size={16} className="animate-pulse" />
            )}
            {pasteToast.type === "success" && <Check size={16} />}
            {pasteToast.type === "error" && <AlertCircle size={16} />}
            {pasteToast.type === "confirm" && <Info size={16} />}
            <span>{pasteToast.message}</span>
            {pasteToast.type === "confirm" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const action = pasteToast.onAction;
                    dismissPasteToast();
                    action();
                  }}
                  className="ml-1 font-semibold underline-offset-2 hover:underline focus:outline-none"
                >
                  {pasteToast.actionLabel}
                </button>
                <button
                  type="button"
                  onClick={dismissPasteToast}
                  aria-label="close"
                  className="ml-1 p-0.5 rounded hover:bg-sky-500/10 focus:outline-none"
                >
                  <X size={14} />
                </button>
              </>
            )}
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

      {/*
        移动端浮动工具栏（吸附键盘正上方）
        - 仅在原生 App + 键盘弹起 + 编辑器聚焦时显示
        - 按钮阻止默认行为避免失焦收键盘
        - 只放最常用 10 个命令：撤销/H1/H2/加粗/斜体/下划线/无序列表/任务列表/代码块/插图
      */}
      {editable && (
        <MobileFloatingToolbar
          visible={editorFocused}
          items={[
            {
              key: "undo",
              icon: <Undo size={18} />,
              title: t("tiptap.undo"),
              disabled: !editor.can().undo(),
              onClick: () => editor.chain().focus().undo().run(),
            },
            {
              key: "h1",
              icon: <Heading1 size={18} />,
              title: t("tiptap.heading1"),
              isActive: editor.isActive("heading", { level: 1 }),
              onClick: () => toggleHeadingSmart(editor, 1),
            },
            {
              key: "h2",
              icon: <Heading2 size={18} />,
              title: t("tiptap.heading2"),
              isActive: editor.isActive("heading", { level: 2 }),
              onClick: () => toggleHeadingSmart(editor, 2),
            },
            {
              key: "bold",
              icon: <Bold size={18} />,
              title: t("tiptap.bold"),
              isActive: editor.isActive("bold"),
              onClick: () => editor.chain().focus().toggleBold().run(),
            },
            {
              key: "italic",
              icon: <Italic size={18} />,
              title: t("tiptap.italic"),
              isActive: editor.isActive("italic"),
              onClick: () => editor.chain().focus().toggleItalic().run(),
            },
            {
              key: "underline",
              icon: <UnderlineIcon size={18} />,
              title: t("tiptap.underline"),
              isActive: editor.isActive("underline"),
              onClick: () => editor.chain().focus().toggleUnderline().run(),
            },
            {
              key: "bullet",
              icon: <List size={18} />,
              title: t("tiptap.bulletList"),
              isActive: editor.isActive("bulletList"),
              onClick: () => editor.chain().focus().toggleBulletList().run(),
            },
            {
              key: "task",
              icon: <CheckSquare size={18} />,
              title: t("tiptap.taskList"),
              isActive: editor.isActive("taskList"),
              onClick: () => editor.chain().focus().toggleTaskList().run(),
            },
            {
              key: "code",
              icon: <FileCode size={18} />,
              title: t("tiptap.codeBlock"),
              isActive: editor.isActive("codeBlock"),
              onClick: toggleCodeBlockStrict,
            },
            {
              key: "image",
              icon: <ImagePlus size={18} />,
              title: t("tiptap.insertImage"),
              onClick: handleImageUpload,
            },
          ] as MobileToolbarItem[]}
        />
      )}
    </div>
  );
});

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
 * 解析笔记内容为 Tiptap 可用的 doc 结构
 *
 * 输入可能是：
 *   1) Tiptap ProseMirror JSON 字符串（老笔记 / Tiptap 保存的）
 *   2) HTML 字符串（极少，历史导入路径）
 *   3) Markdown 字符串（MD 编辑器保存的 → 切回富文本时）
 *   4) 纯文本 / 空
 *
 * 关键点：
 *   - MD 分支必须先转 HTML 再交给 Tiptap，否则标题/列表/代码块等结构
 *     全部塌缩成一段纯文本 → 用户切回富文本后修改/保存时实际丢失了结构。
 *   - MD → HTML 优先用 `contentFormat.markdownToHtml`（基于 @lezer/markdown + GFM），
 *     覆盖表格、任务列表、删除线、setext 标题、嵌套列表、块级 HTML 等；
 *     失败时才降级到 `markdownToSimpleHtml`（逐行扫描，功能更弱但更宽松）。
 *     此前一律走 simpleHtml → GFM 表格 / 删除线等切到 RTE 后会丢失结构。
 *   - MD 识别与 contentFormat.detectFormat 保持一致：JSON 合法 + 含 Tiptap
 *     文档特征才认 tiptap-json，否则一律按 MD 处理（原先兜底只保留纯文本，
 *     是"切到富文本内容丢失"的直接原因）。
 */
function parseContent(content: string): any {
  if (!content || content === "{}") {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  if (typeof content !== "string") return content;

  const trimmed = content.trim();

  // 1) Tiptap JSON：宽松尝试 parse，成功且长得像 doc 才接受
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed.type === "doc" ||
          (typeof parsed.type === "string" && Array.isArray(parsed.content)))
      ) {
        return parsed;
      }
      // 是合法 JSON 但不是 Tiptap doc → 当 MD / 纯文本继续往下走
    } catch {
      /* 不是合法 JSON，继续下一分支 */
    }
  }

  // 2) HTML 字符串：Tiptap 直接能吃
  if (/^<\w/.test(trimmed)) {
    return content;
  }

  // 3) Markdown / 纯文本 → 转 HTML 再交给 Tiptap
  //
  //   首选 contentFormat.markdownToHtml：与 MarkdownEditor 同源的 @lezer/markdown + GFM
  //   解析器，覆盖标题 / 列表 / 任务列表 / 表格 / 引用 / 代码块 / 水平线 / 链接 / 图片 /
  //   删除线 / 内嵌 HTML 等全部语法，且格式识别与 detectFormat 保持一致。
  //
  //   降级到 importService.markdownToSimpleHtml：只覆盖少数基本语法，且对复杂嵌套
  //   结构容易塌缩。当 mdToFullHtml 抛错（理论上不会）或返回空时才走它。
  try {
    // detectFormat 能把 "{ foo" 这种以 { 开头但不是 JSON 的内容识别为 md；
    // empty/html 也会在这里被分类。html 已经在上面处理过，empty 就直接返回空 doc。
    const fmt = detectContentFormat(content);
    if (fmt === "empty") {
      return { type: "doc", content: [{ type: "paragraph" }] };
    }
    // md / html 两种都尝试用完整 parser（html 走 markdownToHtml 时会被当作块级 HTML
    // 原样传递，兼容）。Tiptap 随后会 parseHTML。
    const html = mdToFullHtml(content);
    if (html && html.trim()) return html;
  } catch (err) {
    console.warn("[TiptapEditor] markdownToHtml(full) failed, falling back to simpleHtml:", err);
  }

  try {
    const html = markdownToSimpleHtml(content);
    if (html && html.trim()) return html;
  } catch (err) {
    console.warn("[TiptapEditor] markdownToSimpleHtml failed, fallback to text:", err);
  }

  // 兜底：纯文本段落
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: content }] }],
  };
}
