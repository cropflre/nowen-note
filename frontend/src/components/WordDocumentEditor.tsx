import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableCell, TableHeader } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Contrast,
  Download,
  FileType2,
  Highlighter,
  Image as ImageIcon,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Palette,
  Printer,
  Redo2,
  RemoveFormatting,
  Scissors,
  Settings2,
  Strikethrough,
  Table2,
  Underline as UnderlineIcon,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type {
  NoteEditorHandle,
  NoteEditorHeading,
  NoteEditorProps,
} from "@/components/editors/types";
import { TableRowWithHeight } from "@/components/extensions/TableRowResizable";
import {
  DEFAULT_WORD_PAGE_SETUP,
  normalizeWordPageSetup,
  resolvePaperDimensionsPt,
  type WordOrientation,
  type WordPageSetupAttrs,
  type WordPaperSize,
} from "@/components/extensions/WordDocumentExtensions";
import {
  COLOR_PRESETS,
  HIGHLIGHT_PRESETS,
  TextStyleKit,
} from "@/components/FontSizeExtension";
import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { IndentExtension } from "@/lib/codeBlockIndent";
import { detectFormat, markdownToTiptapJSON } from "@/lib/contentFormat";
import { stabilizeNoteContentForPersistence } from "@/lib/noteContentPersistence";
import { getRichTextExtensions } from "@/lib/richTextExtensions";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";
import {
  shouldEmitTitleUpdate,
  shouldSkipTitleChange,
  shouldSyncTitleValue,
} from "@/lib/titleIme";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import "./WordDocumentEditor.css";

const PT_TO_PX = 96 / 72;
const SAVE_DEBOUNCE_MS = 650;
const ZOOM_STEPS = [0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2];
const HIGH_CONTRAST_LS_KEY = "nowen.word_editor.high_contrast";

const FONT_FAMILIES = [
  { label: "字体", value: "" },
  { label: "微软雅黑", value: "Microsoft YaHei" },
  { label: "宋体", value: "SimSun" },
  { label: "黑体", value: "SimHei" },
  { label: "楷体", value: "KaiTi" },
  { label: "思源黑体", value: "Noto Sans SC" },
  { label: "Times New Roman", value: "Times New Roman" },
  { label: "Arial", value: "Arial" },
  { label: "Consolas", value: "Consolas" },
];

const WORD_FONT_SIZES = [
  { label: "字号", value: "" },
  { label: "六号 (10)", value: "10px" },
  { label: "小五 (12)", value: "12px" },
  { label: "五号 (14)", value: "14px" },
  { label: "小四 (16)", value: "16px" },
  { label: "四号 (19)", value: "19px" },
  { label: "小三 (20)", value: "20px" },
  { label: "三号 (22)", value: "22px" },
  { label: "二号 (29)", value: "29px" },
  { label: "一号 (35)", value: "35px" },
];

const LINE_HEIGHT_OPTIONS = [
  { label: "行距", value: "" },
  { label: "1.0 倍", value: "1" },
  { label: "1.15 倍", value: "1.15" },
  { label: "1.5 倍", value: "1.5" },
  { label: "1.75 倍", value: "1.75" },
  { label: "2.0 倍", value: "2" },
];

const MARGIN_PRESETS = [
  { label: "标准（2.54cm）", top: 72, right: 72, bottom: 72, left: 72 },
  { label: "适中", top: 72, right: 54, bottom: 72, left: 54 },
  { label: "窄边距（省纸）", top: 36, right: 36, bottom: 36, left: 36 },
  { label: "宽边距", top: 72, right: 96, bottom: 72, left: 96 },
];

function parseInitialWordContent(raw: string | null | undefined): Record<string, unknown> {
  const fallback = {
    type: "doc",
    content: [
      { type: "wordPageSetup", attrs: { ...DEFAULT_WORD_PAGE_SETUP } },
      { type: "paragraph" },
    ],
  };
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return fallback;
  try {
    const parsed = detectFormat(raw) === "md" ? markdownToTiptapJSON(raw) : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "doc") {
      return fallback;
    }
    const repaired = repairTiptapJson(parsed) as { type?: string; content?: Array<Record<string, unknown>> };
    const content = Array.isArray(repaired?.content) ? [...repaired.content] : [];
    const hasSetup = content.some((n) => n?.type === "wordPageSetup");
    if (!hasSetup) {
      content.unshift({ type: "wordPageSetup", attrs: { ...DEFAULT_WORD_PAGE_SETUP } });
    }
    if (!content.some((n) => n?.type !== "wordPageSetup")) {
      content.push({ type: "paragraph" });
    }
    return { type: "doc", content };
  } catch {
    return {
      type: "doc",
      content: [
        { type: "wordPageSetup", attrs: { ...DEFAULT_WORD_PAGE_SETUP } },
        { type: "paragraph", content: [{ type: "text", text: raw }] },
      ],
    };
  }
}

function extractPageSetupFromDoc(doc: { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> } | null | undefined): WordPageSetupAttrs {
  const setupNode = doc?.content?.find((node) => node?.type === "wordPageSetup");
  return normalizeWordPageSetup(setupNode?.attrs);
}

function countStats(text: string, docJson: { content?: Array<{ type?: string }> } | null | undefined): {
  chars: number;
  paragraphs: number;
  pages: number;
} {
  const clean = text.replace(/\s+/g, "");
  const nodes = Array.isArray(docJson?.content) ? docJson.content : [];
  let paragraphs = 0;
  let explicitBreaks = 0;
  for (const n of nodes) {
    if (n?.type === "pageBreak") explicitBreaks += 1;
    else if (n?.type !== "wordPageSetup") paragraphs += 1;
  }
  const estimatedByChars = Math.max(1, Math.ceil(clean.length / 800));
  return {
    chars: clean.length,
    paragraphs,
    pages: Math.max(explicitBreaks + 1, estimatedByChars),
  };
}

function clampZoom(value: number): number {
  return Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], value));
}

function stepZoom(cur: number, dir: 1 | -1): number {
  const idx = ZOOM_STEPS.findIndex((z) => z >= cur - 1e-4);
  const base = idx < 0 ? ZOOM_STEPS.length - 1 : idx;
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, base + dir));
  return ZOOM_STEPS[next];
}

const WordDocumentEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function WordDocumentEditor(
  {
    note,
    onUpdate,
    onLocalUpdate,
    onHeadingsChange,
    onEditorReady,
    editable = true,
    isGuest = false,
  },
  ref,
) {
  const initialDoc = useMemo(() => parseInitialWordContent(note.content), []);
  const [title, setTitle] = useState(note.title || "");
  const [pageSetup, setPageSetup] = useState<WordPageSetupAttrs>(() =>
    extractPageSetupFromDoc(initialDoc as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> }),
  );
  const [showPageSetup, setShowPageSetup] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const [zoom, setZoom] = useState<number>(1);
  const [highContrast, setHighContrast] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIGH_CONTRAST_LS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [busyAction, setBusyAction] = useState<"import" | "export" | "image" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [stats, setStats] = useState({ chars: 0, paragraphs: 0, pages: 1 });
  const [, setSelectionTick] = useState(0);

  const noteIdRef = useRef(note.id);
  const titleRef = useRef(note.title || "");
  const lastEmittedTitleRef = useRef(note.title || "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPendingSaveRef = useRef(false);
  const saveGenerationRef = useRef(0);
  const ackedGenerationRef = useRef(0);
  const lastLoadedVersionRef = useRef<number>(note.version ?? 0);
  const lastLoadedContentRef = useRef<string>(note.content || "");
  const isApplyingExternalRef = useRef(false);
  const isTitleComposingRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const pageSetupButtonRef = useRef<HTMLButtonElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);

  const announce = useCallback((message: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 20);
  }, []);

  const extensions = useMemo(
    () => [
      ...getRichTextExtensions(),
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          protocols: ["http", "https", "mailto", "note"],
          HTMLAttributes: {
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          },
        },
      }),
      Placeholder.configure({
        placeholder: "在这里开始输入 Word 文档内容…（支持 Ctrl+Enter 插入分页符）",
      }),
      Image.configure({ inline: true, allowBase64: true }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRowWithHeight,
      TableHeader,
      TableCell,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      IndentExtension,
      ...TextStyleKit,
    ],
    [],
  );

  const emitHeadings = useCallback(
    (doc: ProseMirrorNode) => {
      if (!onHeadingsChange || !doc) return;
      const headings: NoteEditorHeading[] = [];
      let idx = 0;
      doc.descendants((node, pos) => {
        if (node.type?.name === "heading") {
          const text = String(node.textContent || "").trim();
          if (text) {
            headings.push({
              id: `word-h-${idx++}`,
              level: Number(node.attrs?.level || 1),
              text,
              pos,
            });
          }
        }
      });
      onHeadingsChange(headings);
    },
    [onHeadingsChange],
  );

  const editor = useEditor({
    extensions,
    content: initialDoc,
    editable,
    editorProps: {
      attributes: {
        class: "nowen-word-prosemirror",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Word 文档正文编辑区",
        spellcheck: "true",
      },
    },
    onSelectionUpdate: () => {
      setSelectionTick((v) => v + 1);
    },
    onUpdate: ({ editor: ed }) => {
      if (isApplyingExternalRef.current) return;
      const json = ed.getJSON();
      const plain = ed.getText({ blockSeparator: "\n" });
      setPageSetup(extractPageSetupFromDoc(json as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> }));
      setStats(countStats(plain, json as { content?: Array<{ type?: string }> }));
      emitHeadings(ed.state.doc);

      const serialized = stabilizeNoteContentForPersistence(JSON.stringify(json));
      onLocalUpdate?.({
        content: serialized,
        contentText: plain,
        title: titleRef.current,
        _noteId: noteIdRef.current,
      });
      scheduleSave();
    },
  });

  const buildSnapshot = useCallback(() => {
    if (!editor || editor.isDestroyed) return null;
    const json = editor.getJSON();
    const content = stabilizeNoteContentForPersistence(JSON.stringify(json));
    const contentText = editor.getText({ blockSeparator: "\n" });
    return {
      content,
      contentText,
      title: titleRef.current,
    };
  }, [editor]);

  const flushSaveNow = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!hasPendingSaveRef.current) return;
    hasPendingSaveRef.current = false;
    const snap = buildSnapshot();
    if (!snap) return;
    saveGenerationRef.current += 1;
    const gen = saveGenerationRef.current;
    onUpdate({
      content: snap.content,
      contentText: snap.contentText,
      title: snap.title,
      _noteId: noteIdRef.current,
      _saveGeneration: gen,
    });
  }, [buildSnapshot, onUpdate]);

  const scheduleSave = useCallback(() => {
    if (!editable) return;
    hasPendingSaveRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      flushSaveNow();
    }, SAVE_DEBOUNCE_MS);
  }, [editable, flushSaveNow]);

  // 同步 editable 状态
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // 注册滚动跳转（大纲点击）
  useEffect(() => {
    if (!editor || editor.isDestroyed || !onEditorReady) return;
    onEditorReady((pos: number) => {
      if (editor.isDestroyed) return;
      try {
        const clamped = Math.max(1, Math.min(pos, editor.state.doc.content.size));
        editor.chain().focus().setTextSelection(clamped).scrollIntoView().run();
      } catch {
        editor.commands.focus();
      }
    });
  }, [editor, onEditorReady]);

  // 初始化统计与大纲
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const json = editor.getJSON();
    const plain = editor.getText({ blockSeparator: "\n" });
    setStats(countStats(plain, json as { content?: Array<{ type?: string }> }));
    emitHeadings(editor.state.doc);
  }, [editor, emitHeadings]);

  // 切换笔记或接收远端更新
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const isNoteSwitch = noteIdRef.current !== note.id;
    if (isNoteSwitch) {
      flushSaveNow();
      noteIdRef.current = note.id;
      titleRef.current = note.title || "";
      setTitle(note.title || "");
      hasPendingSaveRef.current = false;
      saveGenerationRef.current = 0;
      ackedGenerationRef.current = 0;
      lastLoadedVersionRef.current = note.version ?? 0;
      lastLoadedContentRef.current = note.content || "";
      const nextDoc = parseInitialWordContent(note.content);
      isApplyingExternalRef.current = true;
      try {
        editor.commands.setContent(nextDoc, { emitUpdate: false });
        setPageSetup(extractPageSetupFromDoc(nextDoc as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> }));
        setStats(countStats(editor.getText({ blockSeparator: "\n" }), nextDoc as { content?: Array<{ type?: string }> }));
        emitHeadings(editor.state.doc);
      } finally {
        isApplyingExternalRef.current = false;
      }
      return;
    }

    if (
      !hasPendingSaveRef.current &&
      shouldSyncTitleValue({
        inputValue: titleRef.current,
        noteTitle: note.title || "",
        isComposing: isTitleComposingRef.current,
      })
    ) {
      titleRef.current = note.title || "";
      lastEmittedTitleRef.current = note.title || "";
      setTitle(note.title || "");
    }

    const incomingContent = note.content || "";
    const incomingVersion = note.version ?? 0;
    const hasUnconfirmedLocal =
      hasPendingSaveRef.current || saveGenerationRef.current > ackedGenerationRef.current;
    if (
      !hasUnconfirmedLocal &&
      incomingContent !== lastLoadedContentRef.current &&
      incomingVersion >= lastLoadedVersionRef.current
    ) {
      lastLoadedVersionRef.current = incomingVersion;
      lastLoadedContentRef.current = incomingContent;
      const nextDoc = parseInitialWordContent(incomingContent);
      isApplyingExternalRef.current = true;
      try {
        editor.commands.setContent(nextDoc, { emitUpdate: false });
        setPageSetup(extractPageSetupFromDoc(nextDoc as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> }));
        setStats(countStats(editor.getText({ blockSeparator: "\n" }), nextDoc as { content?: Array<{ type?: string }> }));
        emitHeadings(editor.state.doc);
      } finally {
        isApplyingExternalRef.current = false;
      }
    }
  }, [editor, emitHeadings, flushSaveNow, note.content, note.id, note.title, note.version]);

  // 卸载前刷出未保存修改
  useEffect(() => {
    return () => {
      flushSaveNow();
    };
  }, [flushSaveNow]);

  // 持久化无障碍高对比开关
  useEffect(() => {
    try {
      localStorage.setItem(HIGH_CONTRAST_LS_KEY, highContrast ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [highContrast]);

  useImperativeHandle(
    ref,
    () => ({
      flushSave: flushSaveNow,
      discardPending: () => {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        hasPendingSaveRef.current = false;
      },
      getSnapshot: buildSnapshot,
      acknowledgeSave: (ack) => {
        if (ack.noteId !== noteIdRef.current) return;
        ackedGenerationRef.current = Math.max(ackedGenerationRef.current, ack.saveGeneration);
        lastLoadedVersionRef.current = Math.max(lastLoadedVersionRef.current, ack.version);
        if (!ack.preserveLocalEditor) {
          lastLoadedContentRef.current = ack.content;
        }
      },
      isReady: () => Boolean(editor && !editor.isDestroyed),
      insertMarkdownAtCursor: (markdown: string) => {
        if (!editor || editor.isDestroyed || !editable) return false;
        const parsed: JSONContent = markdownToTiptapJSON(markdown);
        const nodes = Array.isArray(parsed?.content) ? parsed.content : [];
        if (nodes.length === 0) return false;
        return editor.chain().focus().insertContent(nodes).run();
      },
      appendMarkdown: (markdown: string) => {
        if (!editor || editor.isDestroyed || !editable) return false;
        const parsed: JSONContent = markdownToTiptapJSON(markdown);
        const nodes = Array.isArray(parsed?.content) ? parsed.content : [];
        if (nodes.length === 0) return false;
        const endPos = editor.state.doc.content.size;
        return editor.chain().focus().insertContentAt(endPos, nodes).run();
      },
    }),
    [buildSnapshot, editable, editor, flushSaveNow],
  );

  // 更新文档顶部 wordPageSetup 节点（单次可撤销事务，自动落库）
  const updatePageSetup = useCallback(
    (patch: Partial<WordPageSetupAttrs>, feedback?: string) => {
      if (!editor || editor.isDestroyed || !editable) return;
      const next = normalizeWordPageSetup({ ...pageSetup, ...patch });
      setPageSetup(next);

      const { state, view } = editor;
      const tr = state.tr;
      let foundPos: number | null = null;
      state.doc.forEach((child, offset) => {
        if (foundPos === null && child.type.name === "wordPageSetup") {
          foundPos = offset;
        }
      });
      if (foundPos !== null) {
        tr.setNodeMarkup(foundPos, undefined, next);
      } else {
        const nodeType = state.schema.nodes.wordPageSetup;
        if (nodeType) {
          tr.insert(0, nodeType.create(next));
        }
      }
      view.dispatch(tr);
      if (feedback) announce(feedback);
    },
    [announce, editable, editor, pageSetup],
  );

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setTitle(next);
    titleRef.current = next;
    const nativeEvent = e.nativeEvent as InputEvent | undefined;
    if (shouldSkipTitleChange({ eventIsComposing: nativeEvent?.isComposing, isComposing: isTitleComposingRef.current })) {
      return;
    }
    if (shouldEmitTitleUpdate({ title: next, noteTitle: note.title || "", lastEmittedTitle: lastEmittedTitleRef.current })) {
      lastEmittedTitleRef.current = next;
      scheduleSave();
    }
  };

  const handleImportDocx = useCallback(async () => {
    if (!editor || editor.isDestroyed || !editable || busyAction) return;
    const { pickDocxFile } = await import("@/lib/wordNoteService");
    const file = await pickDocxFile();
    if (!file) return;

    setBusyAction("import");
    announce(`正在导入 ${file.name}`);
    let blobUrlsToRelease: string[] = [];
    try {
      const { parseDocx, irToTiptap } = await import("@/office");
      const ir = await parseDocx(file);
      blobUrlsToRelease = ir.resources?.blobUrls ?? [];

      const { doc, warnings } = await irToTiptap(ir, {
        resolveImageSrc: async (blobUrl, alt) => {
          if (!blobUrl.startsWith("blob:")) return blobUrl;
          try {
            const resp = await fetch(blobUrl);
            const blob = await resp.blob();
            const ext = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("gif") ? "gif" : "png";
            const imgFile = new File([blob], `${(alt || "word-image").replace(/[^\w.-]+/g, "_")}.${ext}`, {
              type: blob.type || "image/png",
            });
            const uploaded = await api.attachments.upload(noteIdRef.current, imgFile);
            return uploaded.url;
          } catch {
            return null;
          }
        },
      });

      const ok = await confirm({
        title: `导入 ${file.name}`,
        description:
          (warnings.length > 0
            ? `以下高级排版无法完整转换，将做简化保留：\n${warnings.map((w) => `· ${w}`).join("\n")}\n\n`
            : "") + "导入后会替换当前 Word 文档的正文与页面设置，确定继续吗？",
        confirmText: "替换并导入",
        danger: warnings.length > 0,
      });
      if (!ok) {
        announce("已取消导入");
        return;
      }

      const repaired = repairTiptapJson(doc);
      editor.commands.setContent(repaired as JSONContent, { emitUpdate: true });
      const derivedTitle = file.name.replace(/\.docx$/i, "").trim();
      if (derivedTitle && (!titleRef.current.trim() || titleRef.current.includes("未命名") || titleRef.current.includes("无标题"))) {
        setTitle(derivedTitle);
        titleRef.current = derivedTitle;
      }
      flushSaveNow();
      toast.success(`已导入 ${file.name}`);
      announce(`已成功导入 ${file.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Word 文档导入失败";
      toast.error(message);
      announce(`导入失败：${message}`);
    } finally {
      for (const u of blobUrlsToRelease) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      }
      setBusyAction(null);
    }
  }, [announce, busyAction, editable, editor, flushSaveNow]);

  const handleExportDocx = useCallback(async () => {
    if (!editor || editor.isDestroyed || busyAction) return;
    setBusyAction("export");
    announce("正在导出 Word 文档");
    try {
      const [{ tiptapToIr, createDocx }, { downloadDocxBlob }] = await Promise.all([
        import("@/office"),
        import("@/lib/wordNoteService"),
      ]);
      const docTitle = titleRef.current.trim() || "未命名 Word 文档";
      const ir = await tiptapToIr(editor.getJSON() as Parameters<typeof tiptapToIr>[0], { title: docTitle });
      const blob = await createDocx(ir, { title: docTitle });
      await downloadDocxBlob(blob, `${docTitle}.docx`);
      toast.success("Word 文档已导出");
      announce("Word 文档导出完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : "导出 Word 文档失败";
      toast.error(message);
      announce(`导出失败：${message}`);
    } finally {
      setBusyAction(null);
    }
  }, [announce, busyAction, editor]);

  const handlePrint = useCallback(() => {
    announce("正在打开打印对话框");
    window.print();
  }, [announce]);

  const handleInsertImageFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !editor || editor.isDestroyed || !editable) return;
      setBusyAction("image");
      try {
        const uploaded = await api.attachments.upload(noteIdRef.current, file);
        editor.chain().focus().setImage({ src: uploaded.url, alt: file.name }).run();
        toast.success("图片已插入");
        announce(`已插入图片 ${file.name}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "图片上传失败");
      } finally {
        setBusyAction(null);
        if (imageInputRef.current) imageInputRef.current.value = "";
      }
    },
    [announce, editable, editor],
  );

  // 全局无障碍快捷键（Alt+P 页面设置，Alt+I 导入，Alt+E 导出，Esc 关闭面板并回正文）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (showPageSetup || showColorPicker || showHighlightPicker)) {
        event.preventDefault();
        setShowPageSetup(false);
        setShowColorPicker(false);
        setShowHighlightPicker(false);
        editor?.commands.focus();
        announce("已返回正文编辑区");
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "p") {
          event.preventDefault();
          setShowPageSetup((v) => !v);
        } else if (key === "i" && editable) {
          event.preventDefault();
          void handleImportDocx();
        } else if (key === "e") {
          event.preventDefault();
          void handleExportDocx();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [announce, editable, editor, handleExportDocx, handleImportDocx, showColorPicker, showHighlightPicker, showPageSetup]);

  const effectiveZoom = highContrast ? Math.max(zoom, 1.2) : zoom;
  const paperDims = resolvePaperDimensionsPt(pageSetup.paperSize, pageSetup.orientation);
  const paperWidthPx = Math.round(paperDims.w * PT_TO_PX * effectiveZoom);
  const paperMinHeightPx = Math.round(paperDims.h * PT_TO_PX * effectiveZoom);

  const currentHeadingValue = editor?.isActive("heading", { level: 1 })
    ? "1"
    : editor?.isActive("heading", { level: 2 })
      ? "2"
      : editor?.isActive("heading", { level: 3 })
        ? "3"
        : editor?.isActive("heading", { level: 4 })
          ? "4"
          : "0";
  const currentTextStyle = editor?.getAttributes("textStyle") ?? {};
  const currentParagraphAttrs = editor?.getAttributes("paragraph") ?? {};
  const currentHeadingAttrs = editor?.getAttributes("heading") ?? {};
  const currentLineHeight = String(currentParagraphAttrs.lineHeight || currentHeadingAttrs.lineHeight || "");
  const isFirstLineIndented = currentParagraphAttrs.firstLineIndent === 2;
  const inTable = Boolean(editor?.isActive("table"));

  return (
    <div
      className="nowen-word-editor-shell relative"
      data-word-editor="true"
      data-high-contrast={highContrast ? "true" : "false"}
    >
      {/* 键盘与读屏快捷跳转 */}
      <a
        href="#nowen-word-body-anchor"
        className="nowen-word-skip-link"
        onClick={(e) => {
          e.preventDefault();
          editor?.commands.focus();
          announce("已跳转到正文编辑区");
        }}
      >
        跳到文档正文编辑区
      </a>

      {/* 屏幕阅读器状态播报 */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {/* Word 顶部双行紧凑工具栏 */}
      <div
        className="nowen-word-toolbar"
        role="toolbar"
        aria-label="Word 文档编辑工具栏"
      >
        {/* 第一行：文档、页面、插入与右侧撤销/无障碍（左右均衡，消除留白） */}
        <div className="nowen-word-toolbar-row nowen-word-toolbar-row--primary">
          <div className="nowen-word-toolbar-group" role="group" aria-label="文档与插入操作">
            <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
              <FileType2 size={13} aria-hidden="true" />
              Word
            </span>
            {!isGuest && editable && (
              <button
                type="button"
                className="nowen-word-btn"
                onClick={() => void handleImportDocx()}
                disabled={busyAction !== null}
                title="导入 .docx 文件替换当前正文（快捷键 Alt+I）"
                aria-label="导入 Word 文件"
              >
                {busyAction === "import" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                <span>导入</span>
              </button>
            )}
            <button
              type="button"
              className="nowen-word-btn"
              onClick={() => void handleExportDocx()}
              disabled={busyAction !== null}
              title="导出为标准 .docx 文件（快捷键 Alt+E）"
              aria-label="导出为 Word 文件"
            >
              {busyAction === "export" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              <span>导出</span>
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              onClick={handlePrint}
              title="打印文档或另存为 PDF"
              aria-label="打印或导出 PDF"
            >
              <Printer size={13} />
              <span>打印</span>
            </button>
            <button
              ref={pageSetupButtonRef}
              type="button"
              className="nowen-word-btn"
              aria-expanded={showPageSetup}
              aria-pressed={showPageSetup}
              onClick={() => setShowPageSetup((v) => !v)}
              title="纸张尺寸、页边距与页眉页脚（快捷键 Alt+P）"
              aria-label="页面设置"
            >
              <Settings2 size={13} />
              <span>页面</span>
            </button>

            {editable && (
              <>
                <span className="nowen-word-toolbar-divider" aria-hidden="true" />
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  aria-hidden="true"
                  onChange={(e) => void handleInsertImageFile(e.target.files?.[0])}
                />
                {!isGuest && (
                  <button
                    type="button"
                    className="nowen-word-btn"
                    disabled={busyAction !== null}
                    onClick={() => imageInputRef.current?.click()}
                    title="插入本地图片"
                    aria-label="插入图片"
                  >
                    {busyAction === "image" ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />}
                    <span>图片</span>
                  </button>
                )}
                <button
                  type="button"
                  className="nowen-word-btn"
                  onClick={() => {
                    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
                    announce("已插入 3 行 3 列表格");
                  }}
                  title="插入 3×3 表格"
                  aria-label="插入表格"
                >
                  <Table2 size={13} />
                  <span>表格</span>
                </button>
                <button
                  type="button"
                  className="nowen-word-btn"
                  onClick={() => {
                    editor?.chain().focus().insertPageBreak().run();
                    announce("已插入分页符");
                  }}
                  title="插入分页符 (Ctrl+Enter)"
                  aria-label="插入分页符"
                >
                  <Scissors size={13} />
                  <span>分页</span>
                </button>
              </>
            )}
          </div>

          <div className="nowen-word-toolbar-group" role="group" aria-label="历史与无障碍辅助">
            {editable && (
              <>
                <button
                  type="button"
                  className="nowen-word-btn"
                  onClick={() => editor?.chain().focus().undo().run()}
                  disabled={!editor?.can().undo()}
                  title="撤销 (Ctrl+Z)"
                  aria-label="撤销"
                >
                  <Undo2 size={14} />
                </button>
                <button
                  type="button"
                  className="nowen-word-btn"
                  onClick={() => editor?.chain().focus().redo().run()}
                  disabled={!editor?.can().redo()}
                  title="重做 (Ctrl+Y)"
                  aria-label="重做"
                >
                  <Redo2 size={14} />
                </button>
                <span className="nowen-word-toolbar-divider" aria-hidden="true" />
              </>
            )}
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={highContrast}
              onClick={() => {
                setHighContrast((prev) => {
                  const next = !prev;
                  announce(next ? "已开启高对比大字辅助模式" : "已关闭高对比大字辅助模式");
                  return next;
                });
              }}
              title="开启高对比边框与大号按钮，便于清晰阅读与键盘定位"
              aria-label="无障碍高对比大字模式"
            >
              <Contrast size={13} />
              <span>无障碍</span>
            </button>
          </div>
        </div>

        {/* 第二行：文字样式与段落排版（紧凑流式排列） */}
        {editable && (
          <div className="nowen-word-toolbar-row" role="group" aria-label="文字格式与段落排版">
            <select
              className="nowen-word-select nowen-word-select--heading"
              aria-label="段落样式"
              title="选择正文或标题级别"
              value={currentHeadingValue}
              onChange={(e) => {
                const lvl = Number(e.target.value);
                if (!editor) return;
                if (lvl === 0) editor.chain().focus().setParagraph().run();
                else editor.chain().focus().toggleHeading({ level: lvl as 1 | 2 | 3 | 4 }).run();
              }}
            >
              <option value="0">正文</option>
              <option value="1">标题 1</option>
              <option value="2">标题 2</option>
              <option value="3">标题 3</option>
              <option value="4">标题 4</option>
            </select>

            <select
              className="nowen-word-select nowen-word-select--font"
              aria-label="字体"
              title="设置选中文字字体"
              value={String(currentTextStyle.fontFamily || "")}
              onChange={(e) => {
                if (!editor) return;
                const val = e.target.value;
                if (!val) editor.chain().focus().unsetFontFamily?.().run();
                else editor.chain().focus().setFontFamily?.(val).run();
              }}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value}>{f.label}</option>
              ))}
            </select>

            <select
              className="nowen-word-select nowen-word-select--size"
              aria-label="字号"
              title="设置选中文字字号"
              value={String(currentTextStyle.fontSize || "")}
              onChange={(e) => {
                if (!editor) return;
                const val = e.target.value;
                if (!val) editor.chain().focus().unsetFontSize().run();
                else editor.chain().focus().setFontSize(val).run();
              }}
            >
              {WORD_FONT_SIZES.map((s) => (
                <option key={s.label} value={s.value}>{s.label}</option>
              ))}
            </select>

            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("bold"))}
              onClick={() => editor?.chain().focus().toggleBold().run()}
              title="加粗 (Ctrl+B)"
              aria-label="加粗"
            >
              <Bold size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("italic"))}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              title="斜体 (Ctrl+I)"
              aria-label="斜体"
            >
              <Italic size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("underline"))}
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
              title="下划线 (Ctrl+U)"
              aria-label="下划线"
            >
              <UnderlineIcon size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("strike"))}
              onClick={() => editor?.chain().focus().toggleStrike().run()}
              title="删除线"
              aria-label="删除线"
            >
              <Strikethrough size={14} />
            </button>

            {/* 文字颜色 */}
            <div className="relative">
              <button
                type="button"
                className="nowen-word-btn"
                aria-expanded={showColorPicker}
                aria-label="文字颜色"
                title="设置文字颜色"
                onClick={() => {
                  setShowColorPicker((v) => !v);
                  setShowHighlightPicker(false);
                }}
              >
                <Palette size={14} />
              </button>
              {showColorPicker && (
                <div
                  role="dialog"
                  aria-label="选择文字颜色"
                  className="absolute left-0 top-8 z-30 w-48 rounded-lg border border-app-border bg-app-elevated p-2 shadow-lg"
                >
                  <div className="grid grid-cols-6 gap-1.5">
                    {COLOR_PRESETS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`文字颜色 ${color}`}
                        className="h-6 w-6 rounded border border-app-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                        style={{ backgroundColor: color }}
                        onClick={() => {
                          editor?.chain().focus().setColor(color).run();
                          setShowColorPicker(false);
                        }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-2 w-full rounded border border-app-border py-1 text-xs text-tx-secondary hover:bg-app-hover"
                    onClick={() => {
                      editor?.chain().focus().unsetColor().run();
                      setShowColorPicker(false);
                    }}
                  >
                    恢复默认颜色
                  </button>
                </div>
              )}
            </div>

            {/* 高亮底色 */}
            <div className="relative">
              <button
                type="button"
                className="nowen-word-btn"
                aria-expanded={showHighlightPicker}
                aria-label="文字高亮底色"
                title="设置文字高亮底色"
                onClick={() => {
                  setShowHighlightPicker((v) => !v);
                  setShowColorPicker(false);
                }}
              >
                <Highlighter size={14} />
              </button>
              {showHighlightPicker && (
                <div
                  role="dialog"
                  aria-label="选择文字高亮底色"
                  className="absolute left-0 top-8 z-30 w-48 rounded-lg border border-app-border bg-app-elevated p-2 shadow-lg"
                >
                  <div className="grid grid-cols-6 gap-1.5">
                    {HIGHLIGHT_PRESETS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`高亮色 ${color}`}
                        className="h-6 w-6 rounded border border-app-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                        style={{ backgroundColor: color }}
                        onClick={() => {
                          editor?.chain().focus().setHighlight({ color }).run();
                          setShowHighlightPicker(false);
                        }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-2 w-full rounded border border-app-border py-1 text-xs text-tx-secondary hover:bg-app-hover"
                    onClick={() => {
                      editor?.chain().focus().unsetHighlight().run();
                      setShowHighlightPicker(false);
                    }}
                  >
                    清除高亮
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className="nowen-word-btn"
              onClick={() => editor?.chain().focus().unsetAllMarks().run()}
              title="清除文字格式"
              aria-label="清除文字格式"
            >
              <RemoveFormatting size={14} />
            </button>

            <span className="nowen-word-toolbar-divider" aria-hidden="true" />

            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive({ textAlign: "left" }))}
              onClick={() => editor?.chain().focus().setTextAlign("left").run()}
              title="左对齐"
              aria-label="左对齐"
            >
              <AlignLeft size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive({ textAlign: "center" }))}
              onClick={() => editor?.chain().focus().setTextAlign("center").run()}
              title="居中对齐"
              aria-label="居中对齐"
            >
              <AlignCenter size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive({ textAlign: "right" }))}
              onClick={() => editor?.chain().focus().setTextAlign("right").run()}
              title="右对齐"
              aria-label="右对齐"
            >
              <AlignRight size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive({ textAlign: "justify" }))}
              onClick={() => editor?.chain().focus().setTextAlign("justify").run()}
              title="两端对齐"
              aria-label="两端对齐"
            >
              <AlignJustify size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={isFirstLineIndented}
              onClick={() => editor?.chain().focus().toggleFirstLineIndent().run()}
              title="中文首行缩进 2 字符"
              aria-label="首行缩进两字符"
            >
              <IndentIncrease size={14} />
            </button>

            <select
              className="nowen-word-select nowen-word-select--line"
              aria-label="段落行距"
              title="设置当前段落行距"
              value={currentLineHeight}
              onChange={(e) => {
                const val = e.target.value || null;
                editor?.chain().focus().setParagraphLineHeight(val).run();
              }}
            >
              {LINE_HEIGHT_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("bulletList"))}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              title="无序列表"
              aria-label="无序列表"
            >
              <List size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("orderedList"))}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              title="有序列表"
              aria-label="有序列表"
            >
              <ListOrdered size={14} />
            </button>
            <button
              type="button"
              className="nowen-word-btn"
              aria-pressed={Boolean(editor?.isActive("taskList"))}
              onClick={() => editor?.chain().focus().toggleTaskList().run()}
              title="待办清单"
              aria-label="待办清单"
            >
              <CheckSquare size={14} />
            </button>
          </div>
        )}
      </div>

      {/* 表格上下文快捷操作条（光标位于表格内时出现） */}
      {editable && inTable && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-app-border bg-app-elevated px-3 py-1.5 text-xs"
          role="toolbar"
          aria-label="表格快捷操作"
        >
          <span className="font-medium text-tx-secondary mr-1">表格编辑：</span>
          <button type="button" className="nowen-word-btn" onClick={() => editor?.chain().focus().addRowAfter().run()}>
            下方加行
          </button>
          <button type="button" className="nowen-word-btn" onClick={() => editor?.chain().focus().addColumnAfter().run()}>
            右侧加列
          </button>
          <button type="button" className="nowen-word-btn" onClick={() => editor?.chain().focus().deleteRow().run()}>
            删除当前行
          </button>
          <button type="button" className="nowen-word-btn" onClick={() => editor?.chain().focus().deleteColumn().run()}>
            删除当前列
          </button>
          <button type="button" className="nowen-word-btn" onClick={() => editor?.chain().focus().mergeCells().run()}>
            合并单元格
          </button>
          <button type="button" className="nowen-word-btn" onClick={() => editor?.chain().focus().splitCell().run()}>
            拆分单元格
          </button>
          <button
            type="button"
            className="nowen-word-btn text-red-600 dark:text-red-400"
            onClick={() => editor?.chain().focus().deleteTable().run()}
          >
            删除表格
          </button>
        </div>
      )}

      {/* 可折叠页面设置面板 */}
      {showPageSetup && (
        <section
          aria-label="页面设置面板"
          className="border-b border-app-border bg-app-elevated px-4 py-3 text-xs"
        >
          <div className="mx-auto grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="font-medium text-tx-secondary">纸张尺寸</span>
              <select
                className="nowen-word-select"
                disabled={!editable}
                value={pageSetup.paperSize}
                onChange={(e) =>
                  updatePageSetup(
                    { paperSize: e.target.value as WordPaperSize },
                    `纸张已切换为 ${e.target.value}`,
                  )
                }
              >
                <option value="A4">A4（210 × 297 mm）</option>
                <option value="A5">A5（148 × 210 mm）</option>
                <option value="Letter">Letter（美标信纸）</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-medium text-tx-secondary">纸张方向</span>
              <select
                className="nowen-word-select"
                disabled={!editable}
                value={pageSetup.orientation}
                onChange={(e) => {
                  const orientation = e.target.value as WordOrientation;
                  updatePageSetup(
                    { orientation },
                    `纸张方向已切换为${orientation === "landscape" ? "横向" : "纵向"}`,
                  );
                }}
              >
                <option value="portrait">纵向（竖排）</option>
                <option value="landscape">横向（横排）</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="font-medium text-tx-secondary">页边距预设</span>
              <div className="flex flex-wrap gap-1.5">
                {MARGIN_PRESETS.map((preset) => {
                  const active =
                    pageSetup.marginTop === preset.top &&
                    pageSetup.marginLeft === preset.left &&
                    pageSetup.marginRight === preset.right;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      disabled={!editable}
                      aria-pressed={active}
                      className="nowen-word-btn border border-app-border"
                      onClick={() =>
                        updatePageSetup(
                          {
                            marginTop: preset.top,
                            marginRight: preset.right,
                            marginBottom: preset.bottom,
                            marginLeft: preset.left,
                          },
                          `页边距已设为${preset.label}`,
                        )
                      }
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="font-medium text-tx-secondary">页眉文字（导出 DOCX 与打印时显示）</span>
              <input
                type="text"
                disabled={!editable}
                className="nowen-word-input h-8 rounded-md border border-app-border bg-app-bg px-2.5 text-xs text-tx-primary"
                placeholder="例如：项目技术方案 · 内部资料"
                value={pageSetup.headerText}
                onChange={(e) => updatePageSetup({ headerText: e.target.value })}
              />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="font-medium text-tx-secondary">页脚文字（导出 DOCX 与打印时显示）</span>
              <input
                type="text"
                disabled={!editable}
                className="nowen-word-input h-8 rounded-md border border-app-border bg-app-bg px-2.5 text-xs text-tx-primary"
                placeholder="例如：由 Nowen Note 生成"
                value={pageSetup.footerText}
                onChange={(e) => updatePageSetup({ footerText: e.target.value })}
              />
            </label>
          </div>
          <div className="mx-auto mt-2 flex max-w-4xl justify-end">
            <button
              type="button"
              className="nowen-word-btn border border-app-border"
              onClick={() => {
                setShowPageSetup(false);
                pageSetupButtonRef.current?.focus();
              }}
            >
              完成页面设置（Esc）
            </button>
          </div>
        </section>
      )}

      {/* Word 纸张编辑画布 */}
      <div className="nowen-word-canvas" id="nowen-word-body-anchor">
        <div
          ref={paperRef}
          className="nowen-word-paper nowen-word-print-target"
          style={{
            width: `${paperWidthPx}px`,
            minHeight: `${paperMinHeightPx}px`,
            paddingTop: `${Math.round(pageSetup.marginTop * PT_TO_PX * effectiveZoom)}px`,
            paddingRight: `${Math.round(pageSetup.marginRight * PT_TO_PX * effectiveZoom)}px`,
            paddingBottom: `${Math.round(pageSetup.marginBottom * PT_TO_PX * effectiveZoom)}px`,
            paddingLeft: `${Math.round(pageSetup.marginLeft * PT_TO_PX * effectiveZoom)}px`,
            fontSize: `${Math.round(15 * effectiveZoom)}px`,
          }}
        >
          {pageSetup.headerText && (
            <div className="nowen-word-header-bar" aria-label={`页眉：${pageSetup.headerText}`}>
              {pageSetup.headerText}
            </div>
          )}

          {/* 文档标题 */}
          <input
            type="text"
            value={title}
            readOnly={!editable}
            aria-label="Word 文档标题"
            placeholder="请输入 Word 文档标题"
            className={cn(
              "nowen-word-input mb-4 w-full border-0 border-b border-gray-200 bg-transparent pb-2 text-2xl font-bold text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none",
            )}
            onCompositionStart={() => {
              isTitleComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isTitleComposingRef.current = false;
              const next = (e.target as HTMLInputElement).value;
              setTitle(next);
              titleRef.current = next;
              scheduleSave();
            }}
            onChange={handleTitleChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isTitleComposingRef.current) {
                e.preventDefault();
                editor?.commands.focus("start");
              }
            }}
          />

          <EditorContent editor={editor} className="flex flex-1 flex-col" />

          {pageSetup.footerText && (
            <div className="nowen-word-footer-bar" aria-label={`页脚：${pageSetup.footerText}`}>
              {pageSetup.footerText}
            </div>
          )}
        </div>
      </div>

      {/* 底部状态栏（字数、纸张与缩放） */}
      <footer className="nowen-word-statusbar" aria-label="Word 文档状态栏">
        <div className="flex flex-wrap items-center gap-3">
          <span>{pageSetup.paperSize} {pageSetup.orientation === "landscape" ? "横向" : "纵向"}</span>
          <span aria-label={`字数 ${stats.chars}`}>字数：{stats.chars}</span>
          <span>段落：{stats.paragraphs}</span>
          <span>预计页数：{stats.pages}</span>
          {!editable && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600">只读模式</span>}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="视图缩放控制">
          <button
            type="button"
            className="nowen-word-btn"
            disabled={zoom <= ZOOM_STEPS[0]}
            onClick={() => {
              const next = clampZoom(stepZoom(zoom, -1));
              setZoom(next);
              announce(`缩放已调整为 ${Math.round(next * 100)}%`);
            }}
            aria-label="缩小视图"
            title="缩小视图"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            className="nowen-word-btn min-w-[52px] tabular-nums"
            onClick={() => {
              setZoom(1);
              announce("缩放已重置为 100%");
            }}
            aria-label={`当前缩放 ${Math.round(effectiveZoom * 100)}%，点击重置`}
            title="重置为 100%"
          >
            {Math.round(effectiveZoom * 100)}%
          </button>
          <button
            type="button"
            className="nowen-word-btn"
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => {
              const next = clampZoom(stepZoom(zoom, 1));
              setZoom(next);
              announce(`缩放已调整为 ${Math.round(next * 100)}%`);
            }}
            aria-label="放大视图"
            title="放大视图"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </footer>
    </div>
  );
});

export default WordDocumentEditor;
