/**
 * MarkdownEditor —— CodeMirror 6 驱动的 Markdown 笔记编辑器（MD 迁移 · 阶段 1 骨架）
 * ----------------------------------------------------------------------------------
 * 设计目标：
 *   - props 与 TiptapEditor 完全一致，`EditorPane` 未来可一键替换
 *   - 打开笔记时通过 `normalizeToMarkdown` 兼容历史 Tiptap JSON
 *   - 保存时写 Markdown 纯文本 + 用 `markdownToPlainText` 生成 contentText
 *   - 大纲 (`onHeadingsChange`) 走 @lezer/markdown 的 syntax tree 遍历
 *   - 500ms debounce，Ctrl/Cmd+S 触发 flushSave
 *   - 切换笔记 (note.id) 时重建 doc；同一笔记的 note.content 变化（版本恢复）也会重建
 *   - 暗色/亮色主题跟随 `<html class="dark">` 切换
 *
 * 本阶段只实现"最小可运行"版本：
 *   - 标题输入框 + 标签栏
 *   - CM6 编辑器 + MD 语法高亮 + 代码块嵌入语言
 *   - 行内软换行 / Tab 缩进 / 查找 / 撤销重做
 *   - 字数统计
 *   - `extractHeadings` + `scrollTo`
 *
 * 后续阶段会陆续加上：工具栏、斜杠命令、图片粘贴、Bubble 选区格式化、AI 助手入口、
 * 装饰渲染（标题字号、任务框图标化等）。
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { EditorState, Compartment, StateEffect } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  searchKeymap,
  highlightSelectionMatches,
} from "@codemirror/search";
import {
  bracketMatching,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  syntaxTree,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { tags as t } from "@lezer/highlight";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import { useTranslation } from "react-i18next";
import {
  Bold,
  CheckSquare,
  FileCode,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo,
  Sparkles,
  Strikethrough,
  Table2,
  Image as ImagePlus,
  Undo,
  Code as CodeIcon,
} from "lucide-react";

import { Note, Tag } from "@/types";
import TagInput from "@/components/TagInput";
import AIWritingAssistant from "@/components/AIWritingAssistant";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { normalizeToMarkdown, markdownToPlainText } from "@/lib/contentFormat";
import type { NoteEditorHandle, NoteEditorHeading, NoteEditorProps } from "@/components/editors/types";
import {
  toggleWrap,
  toggleHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  toggleCodeBlock,
  toggleInlineCode,
  insertHorizontalRule,
  insertTable,
  insertLink,
  insertImage,
  replaceSelection,
} from "@/lib/markdownCommands";
import {
  MarkdownSlashMenu,
  MdSlashItem,
  SlashState,
  createSlashPlugin,
  emptySlashState,
  getDefaultMdSlashItems,
} from "@/components/MarkdownSlashMenu";
import { redo, undo } from "@codemirror/commands";

// ---------------------------------------------------------------------------
// 公共类型：沿用 editors/types.ts 的 NoteEditorProps，保证与 TiptapEditor 对齐
// ---------------------------------------------------------------------------

/** 为兼容旧的 `import { HeadingItem } from "@/components/MarkdownEditor"` 引用保留别名 */
export type HeadingItem = NoteEditorHeading;

interface MarkdownEditorProps extends NoteEditorProps {
  /** AI 助手入口：外部可覆盖；若不传则使用内置的 AIWritingAssistant 行内浮层 */
  onAIAssistant?: () => void;
}

// ---------------------------------------------------------------------------
// 工具栏：小按钮 + 分隔符
// ---------------------------------------------------------------------------

interface ToolbarButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}

function ToolbarButton({ onClick, disabled, children, title }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "p-1.5 rounded-md transition-colors",
        "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        disabled && "opacity-30 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-app-border mx-1" />;
}

// ---------------------------------------------------------------------------
// 主题定义
// ---------------------------------------------------------------------------

/**
 * 自定义高亮样式：
 *   - 标题放大加粗
 *   - 强调
 *   - 链接下划线
 *   - 代码块等宽字体
 *
 * 颜色刻意不写死，继承当前主题 CSS 变量（--tx-primary / accent-primary 等），
 * 由下面的 EditorView.theme 接管视觉细节，保持和项目整体风格一致。
 */
const nowenMdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", lineHeight: "1.4" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "700", lineHeight: "1.4" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "600", lineHeight: "1.4" },
  { tag: t.heading4, fontSize: "1.05em", fontWeight: "600" },
  { tag: t.heading5, fontWeight: "600" },
  { tag: t.heading6, fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--color-accent-primary, #3b82f6)", textDecoration: "underline" },
  { tag: t.url, color: "var(--color-accent-primary, #3b82f6)" },
  { tag: t.monospace, fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Monaco, Consolas, monospace" },
  { tag: t.quote, fontStyle: "italic", color: "var(--color-tx-secondary, #64748b)" },
  { tag: t.processingInstruction, color: "var(--color-tx-tertiary, #94a3b8)" },
  { tag: t.list, color: "var(--color-accent-primary, #3b82f6)" },
]);

/** 编辑器 DOM 基础主题（字体 / 尺寸 / 颜色） */
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "15px",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif",
    lineHeight: "1.7",
    padding: "8px 0",
  },
  ".cm-content": {
    padding: "12px 0",
    caretColor: "var(--color-accent-primary, #3b82f6)",
    color: "var(--color-tx-primary, #0f172a)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "rgba(59, 130, 246, 0.2)",
    },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--color-tx-tertiary, #94a3b8)",
  },
  ".cm-cursor": {
    borderLeftWidth: "2px",
  },
  ".cm-placeholder": {
    color: "var(--color-tx-tertiary, #94a3b8)",
    fontStyle: "italic",
  },
});

// ---------------------------------------------------------------------------
// 主题切换：监听 <html class="dark"> 变化，在 oneDark 和空主题（亮色）之间切换
// ---------------------------------------------------------------------------

function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

// ---------------------------------------------------------------------------
// 大纲提取：遍历 lezer-markdown 的 syntax tree，取出 ATXHeading1..6
// ---------------------------------------------------------------------------

function extractHeadings(view: EditorView): NoteEditorHeading[] {
  const headings: NoteEditorHeading[] = [];
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;

  tree.iterate({
    enter(node) {
      // ATXHeading1..ATXHeading6 / SetextHeading1 / SetextHeading2
      const m = node.name.match(/^ATXHeading(\d)$/);
      const setext = node.name.match(/^SetextHeading(\d)$/);
      if (!m && !setext) return;
      const level = parseInt((m ? m[1] : setext![1]) as string, 10);
      if (level < 1 || level > 3) return; // 与 Tiptap 保持一致：只取 h1..h3
      const rawLine = doc.lineAt(node.from).text;
      // 去掉行首 "### " 或者 setext 下划线
      const text = rawLine
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\s+#{1,6}\s*$/, "")
        .trim();
      if (!text) return;
      headings.push({
        id: `h-${node.from}`,
        level,
        text,
        pos: node.from,
      });
    },
  });

  return headings;
}

// ---------------------------------------------------------------------------
// 字数统计（与 TiptapEditor 一致：chars / charsNoSpace / words）
// ---------------------------------------------------------------------------

function computeStats(text: string) {
  const plain = markdownToPlainText(text);
  const chars = plain.length;
  const charsNoSpace = plain.replace(/\s+/g, "").length;
  // 英文按空白切词，中文按字符切（与 Tiptap 行为对齐）
  const englishWords = (plain.match(/[A-Za-z0-9_']+/g) || []).length;
  const cjkChars = (plain.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = englishWords + cjkChars;
  return { chars, charsNoSpace, words };
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export default forwardRef<NoteEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  note,
  onUpdate,
  onTagsChange,
  onHeadingsChange,
  onEditorReady,
  editable = true,
  isGuest = false,
  onAIAssistant,
  yDoc,
  awareness,
}, ref) {
  const { t: tr } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  /** Phase 3: 是否启用 CRDT 协同模式（y-codemirror.next 托管文档） */
  const collabEnabled = !!(yDoc && awareness);
  const collabEnabledRef = useRef(collabEnabled);
  collabEnabledRef.current = collabEnabled;

  // 用 ref 追最新 note / callbacks，避免在 CM6 listener 里拿到过期闭包
  const noteRef = useRef(note);
  noteRef.current = note;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onHeadingsChangeRef = useRef(onHeadingsChange);
  onHeadingsChangeRef.current = onHeadingsChange;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSettingContent = useRef(false);

  /**
   * 本编辑器最近一次派发给 onUpdate 的 markdown 字符串。
   *
   * 作用与 TiptapEditor 里的同名 ref 一致：EditorPane 保存成功后会把 content
   * 回填到 activeNote，这会让本组件的 note.content 变化并触发重建文档的 effect。
   * 如果回填的值就是"自己刚派出去的那份"，再去 dispatch changes 覆盖，
   * 既没有意义，还会打断正在继续输入的用户（光标跳首、选区丢失）。
   *
   * 命中守卫 → no-op；其他来源（Tiptap 编辑器保存、版本恢复）不会命中，走正常
   * 路径，保证切换编辑器后能看到对侧的最新内容。
   */
  const lastEmittedContentRef = useRef<string | null>(null);

  // 主题切换用的 Compartment
  const themeCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());

  const [wordStats, setWordStats] = useState({ chars: 0, charsNoSpace: 0, words: 0 });
  const [slashState, setSlashState] = useState<SlashState>(emptySlashState);

  // ---------- 选区气泡菜单（划词弹出）----------
  /**
   * 对齐 Tiptap 的 BubbleMenu：用户选中非空文本时，在选区上方弹出浮动工具栏
   * （加粗 / 斜体 / 删除线 / 行内代码 / AI 助手）。
   *
   * 实现要点：
   *   - 在 CM6 updateListener 里监听 `selectionSet`，根据 `sel.empty` 切换可见
   *   - 坐标用 `view.coordsAtPos(from/to)` 取首尾，菜单放在选区上方居中
   *   - 仅在 `view.hasFocus` 时弹出，避免点外部工具栏时抢焦点后仍残留
   *   - 访客 (isGuest) 模式下仍显示格式化按钮，但隐藏 AI 入口
   */
  const [bubble, setBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false,
    top: 0,
    left: 0,
  });

  // ---------- AI 助手：行内浮层 ----------
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSelectedText, setAiSelectedText] = useState("");
  const [aiFullText, setAiFullText] = useState("");
  const [aiPosition, setAiPosition] = useState<{ top: number; left: number }>({ top: 100, left: 100 });

  /** 打开 AI 浮层：若外部提供 onAIAssistant 则转给外部 */
  const openAIAssistant = useCallback(() => {
    if (isGuest) return;
    if (onAIAssistant) {
      onAIAssistant();
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    const doc = view.state.doc;
    const selected = doc.sliceString(sel.from, sel.to);
    const full = doc.toString();
    setAiSelectedText(selected || full.slice(0, 500));
    setAiFullText(full);
    // 坐标：优先选区起点，落到屏幕内
    const coords = view.coordsAtPos(sel.from);
    if (coords) {
      setAiPosition({
        top: Math.min(coords.top + 24, window.innerHeight - 500),
        left: Math.min(coords.left, window.innerWidth - 420),
      });
    }
    setAiOpen(true);
  }, [isGuest, onAIAssistant]);

  /** AI 将生成内容插入到当前选区尾部 */
  const handleAIInsert = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { to } = view.state.selection.main;
    view.dispatch({
      changes: { from: to, to, insert: text },
    });
    queueMicrotask(() => view.focus());
  }, []);

  /** AI 将生成内容替换当前选区 */
  const handleAIReplace = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    replaceSelection(view, text);
  }, []);

  // slash 菜单项（依赖 tr / openAIAssistant / 图片上传回调）
  const slashItems: MdSlashItem[] = useMemo(
    () =>
      getDefaultMdSlashItems(tr as unknown as (key: string) => string, {
        onImageUpload: () => {
          triggerImagePicker();
        },
        onAIAssistant: isGuest ? undefined : openAIAssistant,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, isGuest, openAIAssistant],
  );

  // ---------- 图片上传（点工具栏/斜杠/拖拽/粘贴） ----------

  /** 共用：把 File 读成 data URL 后插入图片语法 */
  const insertImageFromFile = useCallback((file: File) => {
    const view = viewRef.current;
    if (!view) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      if (typeof src === "string") {
        insertImage(view, src, file.name.replace(/\.[^.]+$/, ""));
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const triggerImagePicker = useCallback(() => {
    const view = viewRef.current;
    if (!view || !editable) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) insertImageFromFile(file);
    };
    input.click();
  }, [editable, insertImageFromFile]);

  // ---------- 保存逻辑 ----------

  const emitSave = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const md = view.state.doc.toString();
    const plain = markdownToPlainText(md);
    const title = titleRef.current?.value || noteRef.current.title;
    lastEmittedContentRef.current = md;
    // P0-#2 修复：CRDT 模式下 content 完全由服务端 Y.Doc 托管持久化，
    // 若这里再发 content 会与 yjs 的 debounce 回写产生"后者覆盖前者"的竞态。
    // 仅发送 meta（title），避免双写冲突。
    if (collabEnabledRef.current) {
      onUpdateRef.current({ title });
    } else {
      onUpdateRef.current({ content: md, contentText: plain, title });
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      emitSave();
    }, 500);
  }, [emitSave]);

  const flushSave = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    emitSave();
    try {
      toast.success(tr("tiptap.saved") || "Saved");
    } catch {
      /* toast 不可用也没关系 */
    }
  }, [emitSave, tr]);

  /**
   * 对父组件暴露命令式 API：
   *   - flushSave(): 切换编辑器 / 切换笔记时立即把 pending 的 debounce 更新写出去，
   *                 防止丢字。这里故意 **不弹 toast**，避免切换瞬间刷屏。
   */
  useImperativeHandle(
    ref,
    () => ({
      flushSave: () => {
        if (!debounceTimer.current) return;
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        emitSave();
      },
      discardPending: () => {
        // 切换编辑器时调用方已自行 PUT，清掉 debounce 避免后续覆盖
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
      },
      /**
       * 同步读取 CM6 当前文档内容，用于"切换 MD→RTE"时父组件直接回填
       * activeNote.content，避免 RTE mount 时读到旧值。CRDT 模式下 yDoc 才是
       * 权威来源，但这里的 markdown 字符串也与 yDoc 保持最终一致，仍可作为
       * RTE 初始化的可靠快照。
       */
      getSnapshot: () => {
        const view = viewRef.current;
        if (!view) return null;
        const md = view.state.doc.toString();
        return {
          content: md,
          contentText: markdownToPlainText(md),
        };
      },
      isReady: () => !!viewRef.current,
    }),
    [emitSave],
  );

  // ---------- 初次挂载：创建 EditorView ----------

  useEffect(() => {
    if (!hostRef.current) return;
    if (viewRef.current) return; // 防御重复挂载

    // Phase 3：CRDT 模式下，初始 doc 来自 yDoc.getText("content")（可能为空字符串，服务端 sync 后会填充）
    // 注意：此时 yDoc 可能还没 synced，doc 里是空的——yCollab 扩展会在 applyUpdate 后自动反映到 CM。
    //
    // 安全准则：CRDT 分支下**不**用 normalizeToMarkdown(note.content) 兜底，否则会产生
    // "客户端本地种子 → CM diff 回 yText → 客户端发 update；同时服务端也 seed 到 yText →
    // sync 回来 applyUpdate" 的双向种子竞态，结果是 yText 中内容重复/错乱。
    //
    // RTE→MD 切换的内容迁移在 EditorPane.toggleEditorMode 里前置完成：
    // 切换前先把 Tiptap JSON 规范化为 markdown 写回服务端 notes.content，
    // CRDT 冷启动时服务端 inferMarkdownSeed 走 markdown 分支，一次性把结构化 MD
    // 注入 yText，y:sync 回来就能看到正确内容。
    let initialDoc: string;
    if (collabEnabled && yDoc) {
      initialDoc = yDoc.getText("content").toString();
      // yText 还空就留空，等 y:sync
      if (!initialDoc) initialDoc = "";
    } else {
      initialDoc = normalizeToMarkdown(note.content, note.contentText);
    }

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          flushSave();
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (isSettingContent.current) return; // 程序化替换文档时不触发保存

      const text = update.state.doc.toString();
      setWordStats(computeStats(text));
      onHeadingsChangeRef.current?.(extractHeadings(update.view));
      scheduleSave();
    });

    /**
     * 选区气泡菜单 listener：
     *   - 只要选区边界或焦点发生变化就重新计算位置
     *   - 空选区 / 失焦 / 离开视口 → 关闭
     *   - 非空选区 → 放到选区顶部上方 8px，水平居中；靠近视口边界时做 clamp
     */
    const bubbleListener = EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged && !update.focusChanged && !update.geometryChanged) {
        return;
      }
      const view = update.view;
      const sel = update.state.selection.main;
      if (sel.empty || !view.hasFocus) {
        setBubble((b) => (b.open ? { ...b, open: false } : b));
        return;
      }
      const startCoords = view.coordsAtPos(sel.from);
      const endCoords = view.coordsAtPos(sel.to);
      if (!startCoords || !endCoords) {
        setBubble((b) => (b.open ? { ...b, open: false } : b));
        return;
      }
      // 用选区中点做水平居中；用上边界做垂直锚点
      const cx = (startCoords.left + endCoords.right) / 2;
      const top = Math.max(8, startCoords.top - 44); // 菜单约 40px 高，再留 4px 间距
      const left = Math.max(8, Math.min(cx - 110, window.innerWidth - 230)); // 菜单约 220px 宽
      setBubble({ open: true, top, left });
    });


    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        // Phase 3: CRDT 协同扩展（若启用）
        // yCollab 必须放在靠前的位置，让它先处理 doc 变更
        // P3-#14：显式配置 UndoManager 让撤销粒度按词语合并（350ms window）
        ...(collabEnabled && yDoc && awareness
          ? [yCollab(yDoc.getText("content"), awareness, {
              undoManager: new Y.UndoManager(yDoc.getText("content"), { captureTimeout: 350 }),
            })]
          : []),

        // 基础编辑能力
        lineNumbers({
          // 默认隐藏行号，但保留 gutter，便于未来装饰
          formatNumber: () => "",
        }),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        placeholder(tr("tiptap.placeholder") || "开始写点什么..."),

        // MD 语法 + 代码块嵌套高亮
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: true,
        }),
        syntaxHighlighting(nowenMdHighlight),

        // 主题 + 可编辑开关（用 Compartment 动态切换）
        baseTheme,
        themeCompartmentRef.current.of(isDarkMode() ? oneDark : []),
        editableCompartmentRef.current.of(EditorView.editable.of(editable)),

        // 快捷键（先于默认 keymap 注册，保证 Mod-s 不被 chrome 吞）
        saveKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),

        // 变更监听
        updateListener,
        bubbleListener,

        // 斜杠菜单 plugin
        createSlashPlugin((s) => setSlashState(s)),

        // 图片粘贴 / 拖拽
        EditorView.domEventHandlers({
          paste(event) {
            if (!editable) return false;
            const items = event.clipboardData?.items;
            if (!items) return false;
            for (const item of items) {
              if (item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                  event.preventDefault();
                  insertImageFromFile(file);
                  return true;
                }
              }
            }
            return false;
          },
          drop(event) {
            if (!editable) return false;
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return false;
            const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
            if (imageFiles.length === 0) return false;
            event.preventDefault();
            for (const f of imageFiles) {
              insertImageFromFile(f);
            }
            return true;
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;

    // 初始统计 + 大纲
    setWordStats(computeStats(initialDoc));
    onHeadingsChangeRef.current?.(extractHeadings(view));

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 切换笔记 / 外部恢复版本：同步文档内容 ----------

  const lastSyncedNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // 切换时先清理旧 debounce，避免把旧笔记内容写入新笔记
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }

    // Phase 3: CRDT 模式下文档由 yCollab 托管，不要手动 dispatch setContent，
    // 否则会产生本地 update 覆盖远端状态。只保留统计/大纲刷新。
    if (collabEnabledRef.current) {
      if (lastSyncedNoteIdRef.current !== note.id) {
        lastSyncedNoteIdRef.current = note.id;
      }
      setWordStats(computeStats(view.state.doc.toString()));
      onHeadingsChangeRef.current?.(extractHeadings(view));
      if (titleRef.current && titleRef.current.value !== note.title) {
        titleRef.current.value = note.title;
      }
      return;
    }

    // 切换笔记时重置自写守卫（新笔记的 content 肯定要真正应用）
    if (lastSyncedNoteIdRef.current !== note.id) {
      lastEmittedContentRef.current = null;
      lastSyncedNoteIdRef.current = note.id;
    }

    // 自写自读守卫：父级 EditorPane 保存成功会把 content 回填到 activeNote，
    // 如果回填的就是"自己上一次派出去的那份 markdown"，不需要 dispatch 覆盖文档
    // （会打断继续输入 / 清除选区）。
    //
    // 注意：比较对象是 note.content（不是 normalize 后的 markdown），因为本编辑器
    // 派发保存时用的就是裸的 markdown 字符串；对侧 Tiptap 保存的是 JSON，
    // 不会等于我们这里的 markdown，天然不会命中守卫，切过来就能拿到最新内容。
    if (
      lastEmittedContentRef.current !== null &&
      note.content === lastEmittedContentRef.current
    ) {
      setWordStats(computeStats(view.state.doc.toString()));
      onHeadingsChangeRef.current?.(extractHeadings(view));
      if (titleRef.current && titleRef.current.value !== note.title) {
        titleRef.current.value = note.title;
      }
      return;
    }

    const nextDoc = normalizeToMarkdown(note.content, note.contentText);
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== nextDoc) {
      isSettingContent.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextDoc },
        // 把光标放到文档开头，避免旧光标位置越界
        selection: { anchor: 0 },
      });
      // 事务下一微任务里解锁（与 Tiptap 侧等价逻辑）
      queueMicrotask(() => {
        isSettingContent.current = false;
      });
      // 外部驱动的重建 doc 之后，当前持有的 content 已不再等于自己之前派出去的值，
      // 清掉 lastEmitted 避免误判为"自写"。
      lastEmittedContentRef.current = null;
    }

    setWordStats(computeStats(nextDoc));
    onHeadingsChangeRef.current?.(extractHeadings(view));

    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
    // 依赖 content 不依赖 version：与 TiptapEditor 保持一致的语义。
    // 现在 EditorPane 会回填 content，所以 effect 会更频繁触发，
    // 上面的 lastEmittedContentRef 守卫负责避免"自己写完又被 setContent 回来"。
  }, [note.id, note.content]);

  // ---------- 标题单独同步 ----------
  //
  // 为什么单拎出来：标题 input 是非受控的（`defaultValue={note.title}`），
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

  // ---------- editable 开关同步 ----------

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure(
        EditorView.editable.of(editable)
      ),
    });
  }, [editable]);

  // ---------- 主题跟随 <html class="dark"> 切换 ----------

  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;

    const applyTheme = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartmentRef.current.reconfigure(
          isDarkMode() ? oneDark : []
        ),
      });
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          applyTheme();
          break;
        }
      }
    });
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });

    return () => observer.disconnect();
  }, []);

  // ---------- 暴露 scrollTo 给父组件（大纲跳转） ----------

  useEffect(() => {
    if (!onEditorReady) return;
    const scrollTo = (pos: number) => {
      const view = viewRef.current;
      if (!view) return;
      const size = view.state.doc.length;
      const clamped = Math.max(0, Math.min(size, pos));
      view.dispatch({
        selection: { anchor: clamped },
        effects: EditorView.scrollIntoView(clamped, { y: "start", yMargin: 40 }),
      });
      view.focus();
    };
    onEditorReady(scrollTo);
  }, [onEditorReady]);

  // ---------- 标题变化触发保存 ----------

  const handleTitleChange = useCallback(
    (_e: React.ChangeEvent<HTMLInputElement>) => {
      scheduleSave();
    },
    [scheduleSave]
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        viewRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flushSave();
      }
    },
    [flushSave]
  );

  // ---------- 标签变化 ----------

  const noteTags = useMemo(() => note.tags || [], [note.tags]);

  // ---------- 工具栏命令：统一从 viewRef 取 view ----------

  const withView = useCallback((fn: (v: EditorView) => void) => {
    const v = viewRef.current;
    if (!v) return;
    fn(v);
  }, []);

  const iconSize = 15;

  // ---------- 渲染 ----------

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      {editable && (
        <div className="flex items-center gap-0.5 px-4 py-2 border-b border-app-border bg-app-surface/50 md:flex-wrap overflow-x-auto hide-scrollbar touch-pan-x transition-colors">
          <ToolbarButton
            onClick={() => withView((v) => undo(v))}
            title={tr("tiptap.undo") || "撤销"}
          >
            <Undo size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => redo(v))}
            title={tr("tiptap.redo") || "重做"}
          >
            <Redo size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleHeading(v, 1))}
            title={tr("tiptap.heading1") || "一级标题"}
          >
            <Heading1 size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleHeading(v, 2))}
            title={tr("tiptap.heading2") || "二级标题"}
          >
            <Heading2 size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleHeading(v, 3))}
            title={tr("tiptap.heading3") || "三级标题"}
          >
            <Heading3 size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "**"))}
            title={tr("tiptap.bold") || "加粗"}
          >
            <Bold size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "*"))}
            title={tr("tiptap.italic") || "斜体"}
          >
            <Italic size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "~~"))}
            title={tr("tiptap.strikethrough") || "删除线"}
          >
            <Strikethrough size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleInlineCode(v))}
            title={tr("tiptap.inlineCode") || "行内代码"}
          >
            <CodeIcon size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleBulletList(v))}
            title={tr("tiptap.bulletList") || "无序列表"}
          >
            <List size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleOrderedList(v))}
            title={tr("tiptap.orderedList") || "有序列表"}
          >
            <ListOrdered size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleTaskList(v))}
            title={tr("tiptap.taskList") || "任务列表"}
          >
            <CheckSquare size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleBlockquote(v))}
            title={tr("tiptap.blockquote") || "引用"}
          >
            <Quote size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleCodeBlock(v))}
            title={tr("tiptap.codeBlock") || "代码块"}
          >
            <FileCode size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => insertHorizontalRule(v))}
            title={tr("tiptap.horizontalRule") || "分割线"}
          >
            <Minus size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => insertLink(v))}
            title={tr("tiptap.insertLink") || "插入链接"}
          >
            <LinkIcon size={iconSize} />
          </ToolbarButton>
          <ToolbarButton onClick={triggerImagePicker} title={tr("tiptap.insertImage") || "插入图片"}>
            <ImagePlus size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => insertTable(v))}
            title={tr("tiptap.insertTable") || "插入表格"}
          >
            <Table2 size={iconSize} />
          </ToolbarButton>

          {!isGuest && <ToolbarDivider />}
          {!isGuest && (
            <ToolbarButton onClick={openAIAssistant} title={tr("tiptap.aiAssistant") || "AI 助手"}>
              <Sparkles size={iconSize} className="text-violet-500" />
            </ToolbarButton>
          )}
        </div>
      )}

      {/* 标题栏 */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-2">
        <input
          ref={titleRef}
          defaultValue={note.title}
          placeholder={tr("tiptap.titlePlaceholder") || "无标题"}
          onChange={handleTitleChange}
          onKeyDown={handleTitleKeyDown}
          readOnly={!editable}
          className="w-full bg-transparent outline-none text-2xl md:text-3xl font-bold text-tx-primary placeholder:text-tx-tertiary/60"
        />
        {!isGuest && (
          <div className="mt-2">
            <TagInput
              noteId={note.id}
              noteTags={noteTags}
              onTagsChange={onTagsChange}
            />
          </div>
        )}
      </div>

      {/* 编辑器主体 */}
      <div className="flex-1 overflow-auto px-4 md:px-8">
        <div
          ref={hostRef}
          className="nowen-md-editor h-full"
          // 让 CM6 内部滚动容器能获得正确高度
          style={{ minHeight: "100%" }}
        />
      </div>

      {/* 状态栏：字数统计（与 TiptapEditor 对齐） */}
      <div className="px-4 md:px-8 py-1.5 border-t border-app-border/60 text-[11px] text-tx-tertiary flex items-center gap-3 select-none">
        <span>
          {tr("tiptap.chars", { count: wordStats.chars }) || `${wordStats.chars} 字符`}
        </span>
        <span className="opacity-60">·</span>
        <span>
          {tr("tiptap.words", { count: wordStats.words }) || `${wordStats.words} 词`}
        </span>
        <span className="ml-auto opacity-60">Markdown</span>
      </div>

      {/* 斜杠菜单浮层 */}
      <MarkdownSlashMenu
        state={slashState}
        items={slashItems}
        view={viewRef.current}
        onClose={() => setSlashState(emptySlashState)}
      />

      {/*
        划词气泡菜单（对齐 Tiptap 的 BubbleMenu）
        - 只在有非空选区 + 编辑器聚焦时出现
        - 用 fixed 定位 + 视口坐标，避免被溢出容器裁剪
        - onMouseDown 阻止默认行为，防止点按钮时 CM 失焦导致选区丢失
      */}
      {editable && bubble.open && (
        <div
          className="fixed z-40 flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
          style={{ top: bubble.top, left: bubble.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "**"))}
            title={tr("tiptap.bold") || "加粗"}
          >
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "*"))}
            title={tr("tiptap.italic") || "斜体"}
          >
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "~~"))}
            title={tr("tiptap.strikethrough") || "删除线"}
          >
            <Strikethrough size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleInlineCode(v))}
            title={tr("tiptap.inlineCode") || "行内代码"}
          >
            <CodeIcon size={14} />
          </ToolbarButton>
          {!isGuest && (
            <>
              <div className="w-px h-4 bg-app-border mx-0.5" />
              <ToolbarButton
                onClick={openAIAssistant}
                title={tr("tiptap.aiAssistant") || "AI 助手"}
              >
                <Sparkles size={14} className="text-violet-500" />
              </ToolbarButton>
            </>
          )}
        </div>
      )}


      {/* AI 写作助手行内浮层（仅非访客 & 未传入 onAIAssistant 覆盖时可用） */}
      {!isGuest && aiOpen && (
        <AIWritingAssistant
          selectedText={aiSelectedText}
          fullText={aiFullText}
          onInsert={handleAIInsert}
          onReplace={handleAIReplace}
          onClose={() => setAiOpen(false)}
          position={aiPosition}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// 开发辅助：防止 Vite HMR 时残留 view
// ---------------------------------------------------------------------------
// （占位，未来若需要可在 import.meta.hot 回调里清理 viewRef）
void StateEffect;
