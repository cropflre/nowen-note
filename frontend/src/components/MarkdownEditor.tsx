/**
 * MarkdownEditor ���� CodeMirror 6 ������ Markdown �ʼǱ༭����MD Ǩ�� �� �׶� 1 �Ǽܣ�
 * ----------------------------------------------------------------------------------
 * ���Ŀ�꣺
 *   - props �� TiptapEditor ��ȫһ�£�`EditorPane` δ����һ���滻
 *   - �򿪱ʼ�ʱͨ�� `normalizeToMarkdown` ������ʷ Tiptap JSON
 *   - ����ʱд Markdown ���ı� + �� `markdownToPlainText` ���� contentText
 *   - ��� (`onHeadingsChange`) �� @lezer/markdown �� syntax tree ����
 *   - 500ms debounce��Ctrl/Cmd+S ���� flushSave
 *   - �л��ʼ� (note.id) ʱ�ؽ� doc��ͬһ�ʼǵ� note.content �仯���汾�ָ���Ҳ���ؽ�
 *   - ��ɫ/��ɫ������� `<html class="dark">` �л�
 *
 * ���׶�ֻʵ��"��С������"�汾��
 *   - ��������� + ��ǩ��
 *   - CM6 �༭�� + MD �﷨���� + �����Ƕ������
 *   - ���������� / Tab ���� / ���� / ��������
 *   - ����ͳ��
 *   - `extractHeadings` + `scrollTo`
 *
 * �����׶λ�½�����ϣ���������б�����ͼƬճ����Bubble ѡ����ʽ����AI ������ڡ�
 * װ����Ⱦ�������ֺš������ͼ�껯�ȣ���
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
  Paperclip,
  Undo,
  Code as CodeIcon,
  Copy, ArrowUp,
  Phone,
  ExternalLink,
} from "lucide-react";

import { Note, Tag } from "@/types";
import TagInput from "@/components/TagInput";
import AIWritingAssistant from "@/components/AIWritingAssistant";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { findTextAction, type TextAction } from "@/lib/textActions";
import { cn } from "@/lib/utils";
import { normalizeToMarkdown, markdownToPlainText } from "@/lib/contentFormat";
import { api } from "@/lib/api";
import type { NoteEditorHandle, NoteEditorHeading, NoteEditorProps } from "@/components/editors/types";
import type { FormatMenuPayload } from "@/lib/desktopBridge";
import {
  toggleWrap,
  toggleHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  toggleCodeBlock,
  toggleInlineCode,
  toggleLinePrefix,
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
// �������ͣ����� editors/types.ts �� NoteEditorProps����֤�� TiptapEditor ����
// ---------------------------------------------------------------------------

/** Ϊ���ݾɵ� `import { HeadingItem } from "@/components/MarkdownEditor"` ���ñ������� */
export type HeadingItem = NoteEditorHeading;

interface MarkdownEditorProps extends NoteEditorProps {
  /** AI ������ڣ��ⲿ�ɸ��ǣ���������ʹ�����õ� AIWritingAssistant ���ڸ��� */
  onAIAssistant?: () => void;
}

// ---------------------------------------------------------------------------
// ��������С��ť + �ָ���
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
// ���ⶨ��
// ---------------------------------------------------------------------------

/**
 * �Զ��������ʽ��
 *   - ����Ŵ�Ӵ�
 *   - ǿ��
 *   - �����»���
 *   - �����ȿ�����
 *
 * ��ɫ���ⲻд�����̳е�ǰ���� CSS ������--tx-primary / accent-primary �ȣ���
 * ������� EditorView.theme �ӹ��Ӿ�ϸ�ڣ����ֺ���Ŀ������һ�¡�
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

/** �༭�� DOM �������⣨���� / �ߴ� / ��ɫ�� */
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
// �����л������� <html class="dark"> �仯���� oneDark �Ϳ����⣨��ɫ��֮���л�
// ---------------------------------------------------------------------------

function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

// ---------------------------------------------------------------------------
// �����ȡ������ lezer-markdown �� syntax tree��ȡ�� ATXHeading1..6
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
      if (level < 1 || level > 3) return; // �� Tiptap ����һ�£�ֻȡ h1..h3
      const rawLine = doc.lineAt(node.from).text;
      // ȥ������ "### " ���� setext �»���
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
// ����ͳ�ƣ��� TiptapEditor һ�£�chars / charsNoSpace / words��
// ---------------------------------------------------------------------------

function computeStats(text: string) {
  const plain = markdownToPlainText(text);
  const chars = plain.length;
  const charsNoSpace = plain.replace(/\s+/g, "").length;
  // Ӣ�İ��հ��дʣ����İ��ַ��У��� Tiptap ��Ϊ���룩
  const englishWords = (plain.match(/[A-Za-z0-9_']+/g) || []).length;
  const cjkChars = (plain.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = englishWords + cjkChars;
  return { chars, charsNoSpace, words };
}

// ---------------------------------------------------------------------------
// ���
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

  /** Phase 3: �Ƿ����� CRDT Эͬģʽ��y-codemirror.next �й��ĵ��� */
  const collabEnabled = !!(yDoc && awareness);
  const collabEnabledRef = useRef(collabEnabled);
  collabEnabledRef.current = collabEnabled;

  // �� ref ׷���� note / callbacks�������� CM6 listener ���õ����ڱհ�
  const noteRef = useRef(note);
  noteRef.current = note;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onHeadingsChangeRef = useRef(onHeadingsChange);
  onHeadingsChangeRef.current = onHeadingsChange;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSettingContent = useRef(false);

  /**
   * ���༭�����һ���ɷ��� onUpdate �� markdown �ַ�����
   *
   * ������ TiptapEditor ���ͬ�� ref һ�£�EditorPane ����ɹ����� content
   * ��� activeNote������ñ������ note.content �仯�������ؽ��ĵ��� effect��
   * ��������ֵ����"�Լ����ɳ�ȥ���Ƿ�"����ȥ dispatch changes ���ǣ�
   * ��û�����壬���������ڼ���������û���������ס�ѡ����ʧ����
   *
   * �������� �� no-op��������Դ��Tiptap �༭�����桢�汾�ָ����������У�������
   * ·������֤�л��༭�����ܿ����Բ���������ݡ�
   */
  const lastEmittedContentRef = useRef<string | null>(null);

  // �����л��õ� Compartment
  const themeCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());

  // ���һ�δ��� pointer ʱ���������"ѡ�����ݴ������� Android ϵͳ���Ʋ˵�"�߼�
  const lastTouchAtRef = useRef<number>(0);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === "touch") lastTouchAtRef.current = Date.now();
    };
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("pointerup", onPointer, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointerup", onPointer);
    };
  }, []);

  const [wordStats, setWordStats] = useState({ chars: 0, charsNoSpace: 0, words: 0 });
  const [slashState, setSlashState] = useState<SlashState>(emptySlashState);
  // �༭���Ƿ�۽� ���� ���������ƶ��˸����������Ƿ���ʾ

  // �ƶ����������Ƿ���������ԭ�� + ���̵���ʱ���ض������������ߵײ�������������


  // ---------- ѡ�����ݲ˵������ʵ�����----------
  /**
   * ���� Tiptap �� BubbleMenu���û�ѡ�зǿ��ı�ʱ����ѡ���Ϸ���������������
   * ���Ӵ� / б�� / ɾ���� / ���ڴ��� / AI ���֣���
   *
   * ʵ��Ҫ�㣺
   *   - �� CM6 updateListener ����� `selectionSet`������ `sel.empty` �л��ɼ�
   *   - ������ `view.coordsAtPos(from/to)` ȡ��β���˵�����ѡ���Ϸ�����
   *   - ���� `view.hasFocus` ʱ������������ⲿ������ʱ��������Բ���
   *   - �ÿ� (isGuest) ģʽ������ʾ��ʽ����ť�������� AI ���
   */
  const [selectedTextAction, setSelectedTextAction] = useState<TextAction | null>(null);
  const [bubble, setBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false,
    top: 0,
    left: 0,
  });

  // ---------- AI ���֣����ڸ��� ----------
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSelectedText, setAiSelectedText] = useState("");
  const [aiFullText, setAiFullText] = useState("");
  const [aiPosition, setAiPosition] = useState<{ top: number; left: number }>({ top: 100, left: 100 });

  /** �� AI ���㣺���ⲿ�ṩ onAIAssistant ��ת���ⲿ */
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
    // ���꣺����ѡ����㣬�䵽��Ļ��
    const coords = view.coordsAtPos(sel.from);
    if (coords) {
      setAiPosition({
        top: Math.min(coords.top + 24, window.innerHeight - 500),
        left: Math.min(coords.left, window.innerWidth - 420),
      });
    }
    setAiOpen(true);
  }, [isGuest, onAIAssistant]);

  /** AI ���������ݲ��뵽��ǰѡ��β�� */
  const handleAIInsert = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { to } = view.state.selection.main;
    view.dispatch({
      changes: { from: to, to, insert: text },
    });
    queueMicrotask(() => view.focus());
  }, []);

  /** AI �����������滻��ǰѡ�� */
  const handleAIReplace = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    replaceSelection(view, text);
  }, []);

  const copySelectionText = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const ok = await copyText(view.state.doc.sliceString(sel.from, sel.to));
    if (ok) toast.success(tr('tiptap.copySelectionText'));
    else toast.info(tr('tiptap.copySelectionFail'));
    queueMicrotask(() => view.focus());
  }, [tr]);

  const selectAllText = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    queueMicrotask(() => view.focus());
  }, []);

  // slash �˵������ tr / openAIAssistant / ͼƬ�ϴ��ص���
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

  // ---------- ͼƬ�ϴ����㹤����/б��/��ק/ճ���� ----------

  /** ���ã��ϴ��ļ��� /api/attachments ����� Markdown ͼƬ�﷨ */
  const insertImageFromFile = useCallback((file: File) => {
    const view = viewRef.current;
    if (!view) return;
    const currentNote = noteRef.current;
    const alt = file.name.replace(/\.[^.]+$/, "");
    if (currentNote?.id) {
      // �� noteId���߷�����ϴ����������·������ TiptapEditor һ�£�
      api.attachments
        .upload(currentNote.id, file)
        .then(({ url }) => {
          const v = viewRef.current;
          if (v) insertImage(v, url, alt);
        })
        .catch((err) => {
          console.error("Attachment upload failed, falling back to base64:", err);
          // �ϴ�ʧ�ܶ��ף����� base64 ���룬��֤�û�����ʧͼƬ
          const reader = new FileReader();
          reader.onload = () => {
            const src = reader.result;
            const v = viewRef.current;
            if (typeof src === "string" && v) insertImage(v, src, alt);
          };
          reader.readAsDataURL(file);
        });
    } else {
      // û�� note �����ģ������ϲ�Ӧ���������˻� base64
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result;
        if (typeof src === "string") insertImage(view, src, alt);
      };
      reader.readAsDataURL(file);
    }
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

  /**
   * �����ʽ�����ϴ� �� �� Markdown ��ǰ��괦���룺
   *   - ͼƬ���� insertImageFromFile һ�������� `![alt](url)`
   *   - ��ͼƬ������ `[?? �ļ��� (��С)](url)` ���� �� markdown ���ӣ��﷨��������
   *     ��Ⱦ������������������� Content-Disposition �������ء�
   *
   * �ϴ���·�� TiptapEditor ��ȫһ�£�api.attachments.upload���������ͬһ������
   */
  const insertAttachmentFromFile = useCallback((file: File) => {
    const view = viewRef.current;
    if (!view) return;
    const currentNote = noteRef.current;
    if (!currentNote?.id) {
      toast.error(tr("tiptap.attachmentUploadFailed") || "Attachment upload failed");
      return;
    }
    toast.info(tr("tiptap.attachmentUploading") || "Uploading attachment...");
    api.attachments
      .upload(currentNote.id, file)
      .then((res) => {
        const v = viewRef.current;
        if (!v) return;
        if (res.category === "image") {
          insertImage(v, res.url, file.name.replace(/\.[^.]+$/, ""));
        } else {
          // �����ļ������ ] �ƻ� markdown ���ӣ�����Сת��
          const label = (res.filename || "attachment")
            .replace(/\]/g, "\\]")
            .replace(/\|/g, "\\|");
          const sizeLabel = formatBytesMd(res.size);
          replaceSelection(v, `[?? ${label}${sizeLabel ? ` (${sizeLabel})` : ""}](${res.url})`);
        }
        toast.success(tr("tiptap.attachmentUploaded") || "Attachment uploaded");
      })
      .catch((err: any) => {
        console.error("Attachment upload failed:", err);
        const msg = String(err?.message || "");
        if (/���|max\s+\d+\s*MB/i.test(msg)) {
          toast.error(tr("tiptap.attachmentTooLarge") || "File too large");
        } else {
          toast.error(tr("tiptap.attachmentUploadFailed") || "Attachment upload failed");
        }
      });
  }, [tr]);

  const triggerAttachmentPicker = useCallback(() => {
    const view = viewRef.current;
    if (!view || !editable) return;
    const input = document.createElement("input");
    input.type = "file";
    // ���� accept�������ʽ
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) insertAttachmentFromFile(file);
    };
    input.click();
  }, [editable, insertAttachmentFromFile]);


  // ---------- �����߼� ----------

  const emitSave = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const md = view.state.doc.toString();
    const plain = markdownToPlainText(md);
    const title = titleRef.current?.value || noteRef.current.title;
    lastEmittedContentRef.current = md;
    // P0-#2 �޸���CRDT ģʽ�� content ��ȫ�ɷ���� Y.Doc �йܳ־û���
    // �������ٷ� content ���� yjs �� debounce ��д����"���߸���ǰ��"�ľ�̬��
    // ������ meta��title��������˫д��ͻ��
    if (collabEnabledRef.current) {
      onUpdateRef.current({ title, _noteId: noteRef.current.id });
    } else {
      onUpdateRef.current({ content: md, contentText: plain, title, _noteId: noteRef.current.id });
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
      /* toast ������Ҳû��ϵ */
    }
  }, [emitSave, tr]);

  /**
   * �Ը������¶����ʽ API��
   *   - flushSave(): �л��༭�� / �л��ʼ�ʱ������ pending �� debounce ����д��ȥ��
   *                 ��ֹ���֡�������� **���� toast**�������л�˲��ˢ����
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
        // �л��༭��ʱ���÷������� PUT����� debounce �����������
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
      },
      /**
       * ͬ����ȡ CM6 ��ǰ�ĵ����ݣ�����"�л� MD��RTE"ʱ�����ֱ�ӻ���
       * activeNote.content������ RTE mount ʱ������ֵ��CRDT ģʽ�� yDoc ����
       * Ȩ����Դ��������� markdown �ַ���Ҳ�� yDoc ��������һ�£��Կ���Ϊ
       * RTE ��ʼ���Ŀɿ����ա�
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
      appendMarkdown: (md: string) => {
        const view = viewRef.current;
        if (!view) return false;
        try {
          view.dispatch({ changes: { from: view.state.doc.length, insert: md } });
          return true;
        } catch { return false; }
      },
    }),
    [emitSave],
  );

  // ---------- ���ι��أ����� EditorView ----------

  useEffect(() => {
    if (!hostRef.current) return;
    if (viewRef.current) return; // �����ظ�����

    // Phase 3��CRDT ģʽ�£���ʼ doc ���� yDoc.getText("content")������Ϊ���ַ���������� sync �����䣩
    // ע�⣺��ʱ yDoc ���ܻ�û synced��doc ���ǿյġ���yCollab ��չ���� applyUpdate ���Զ���ӳ�� CM��
    //
    // ��ȫ׼��CRDT ��֧��**��**�� normalizeToMarkdown(note.content) ���ף���������
    // "�ͻ��˱������� �� CM diff �� yText �� �ͻ��˷� update��ͬʱ�����Ҳ seed �� yText ��
    // sync ���� applyUpdate" ��˫�����Ӿ�̬������� yText �������ظ�/���ҡ�
    //
    // RTE��MD �л�������Ǩ���� EditorPane.toggleEditorMode ��ǰ����ɣ�
    // �л�ǰ�Ȱ� Tiptap JSON �淶��Ϊ markdown д�ط���� notes.content��
    // CRDT ������ʱ����� inferMarkdownSeed �� markdown ��֧��һ���԰ѽṹ�� MD
    // ע�� yText��y:sync �������ܿ�����ȷ���ݡ�
    let initialDoc: string;
    if (collabEnabled && yDoc) {
      initialDoc = yDoc.getText("content").toString();
      // yText ���վ����գ��� y:sync
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
      if (isSettingContent.current) return; // �����滻�ĵ�ʱ����������

      const text = update.state.doc.toString();
      setWordStats(computeStats(text));
      onHeadingsChangeRef.current?.(extractHeadings(update.view));
      scheduleSave();
    });

    /**
     * ѡ�����ݲ˵� listener��
     *   - ֻҪѡ���߽�򽹵㷢���仯�����¼���λ��
     *   - ��ѡ�� / ʧ�� / �뿪�ӿ� �� �ر�
     *   - �ǿ�ѡ�� �� �ŵ�ѡ�������Ϸ� 8px��ˮƽ���У������ӿڱ߽�ʱ�� clamp
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
      // ˮƽλ�ã�ѡ���е�
      const cx = (startCoords.left + endCoords.right) / 2;
      // ��ֱ���ò��ԣ��� Tiptap һ�£���
      //   ���/����  �� ѡ���Ϸ�
      //   ���ڴ��� �� ѡ���·������� Android ϵͳԭ�����Ʋ˵���
      const isTouch = Date.now() - lastTouchAtRef.current < 800;
      const bubbleH = 40;
      let top: number;
      if (isTouch) {
        const below = endCoords.bottom + 8;
        const overflowsBottom = below + bubbleH > window.innerHeight - 16;
        top = overflowsBottom ? Math.max(8, startCoords.top - bubbleH - 8) : below;
      } else {
        top = Math.max(8, startCoords.top - 44); // �˵�Լ 40px �ߣ����� 4px ���
      }
      const left = Math.max(8, Math.min(cx - 110, window.innerWidth - 230)); // �˵�Լ 220px ��
      setSelectedTextAction(findTextAction(view.state.doc.sliceString(sel.from, sel.to)));
      setBubble({ open: true, top, left });
    });

    /**
     * �۽�״̬ͬ�� listener��Ԥ���ⲿ�ӿڣ�
     * v2026-05-18��ԭΪ�ƶ��˸���������ʹ�á��ָ�Ϊ��һ����
     * sticky ��������������Ҫ���������� listener ���������Ҫ
     * ʱ�ظ����롣���� state ����Զ���ᴥ�� re-render��
     */
    const focusListener = EditorView.updateListener.of((_update) => {
      // ��ʵ�֣�Ԥ����չ�㡣
    });




    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        // Phase 3: CRDT Эͬ��չ�������ã�
        // yCollab ������ڿ�ǰ��λ�ã������ȴ��� doc ���
        // P3-#14����ʽ���� UndoManager �ó������Ȱ�����ϲ���350ms window��
        ...(collabEnabled && yDoc && awareness
          ? [yCollab(yDoc.getText("content"), awareness, {
              undoManager: new Y.UndoManager(yDoc.getText("content"), { captureTimeout: 350 }),
            })]
          : []),

        // �����༭����
        lineNumbers({
          // Ĭ�������кţ������� gutter������δ��װ��
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
        placeholder(tr("tiptap.placeholder") || "��ʼд��ʲô..."),

        // MD �﷨ + �����Ƕ�׸���
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: true,
        }),
        syntaxHighlighting(nowenMdHighlight),

        // ���� + �ɱ༭���أ��� Compartment ��̬�л���
        baseTheme,
        themeCompartmentRef.current.of(isDarkMode() ? oneDark : []),
        editableCompartmentRef.current.of(EditorView.editable.of(editable)),

        // ��ݼ�������Ĭ�� keymap ע�ᣬ��֤ Mod-s ���� chrome �̣�
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

        // �������
        updateListener,
        bubbleListener,
        focusListener,

        // б�ܲ˵� plugin
        createSlashPlugin((s) => setSlashState(s)),

        // ͼƬ / ���� ճ�� & ��ק���� TiptapEditor ��Ϊ����
        EditorView.domEventHandlers({
          paste(event) {
            if (!editable) return false;
            // 1) ����ͼƬ����ͼճ����
            const items = event.clipboardData?.items;
            if (items) {
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
            }
            // 2) ��ͼƬ�ļ�����Դ���������Ƶ��ļ����� ����
            const files = Array.from(event.clipboardData?.files || []);
            if (files.length > 0) {
              event.preventDefault();
              for (const f of files) insertAttachmentFromFile(f);
              return true;
            }
            return false;
          },
          drop(event) {
            if (!editable) return false;
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return false;
            event.preventDefault();
            for (const f of Array.from(files)) {
              if (f.type.startsWith("image/")) {
                insertImageFromFile(f);
              } else {
                insertAttachmentFromFile(f);
              }
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

    // ��ʼͳ�� + ���
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

  // ---------- �л��ʼ� / �ⲿ�ָ��汾��ͬ���ĵ����� ----------

  const lastSyncedNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // �л�ʱ�������� debounce������Ѿɱʼ�����д���±ʼ�
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }

    // Phase 3: CRDT ģʽ���ĵ��� yCollab �йܣ���Ҫ�ֶ� dispatch setContent��
    // ������������ update ����Զ��״̬��ֻ����ͳ��/���ˢ�¡�
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

    // �л��ʼ�ʱ������д�������±ʼǵ� content �϶�Ҫ����Ӧ�ã�
    if (lastSyncedNoteIdRef.current !== note.id) {
      lastEmittedContentRef.current = null;
      lastSyncedNoteIdRef.current = note.id;
    }

    // ��д�Զ����������� EditorPane ����ɹ���� content ��� activeNote��
    // �������ľ���"�Լ���һ���ɳ�ȥ���Ƿ� markdown"������Ҫ dispatch �����ĵ�
    // �����ϼ������� / ���ѡ������
    //
    // ע�⣺�Ƚ϶����� note.content������ normalize ��� markdown������Ϊ���༭��
    // �ɷ�����ʱ�õľ������ markdown �ַ������Բ� Tiptap ������� JSON��
    // ���������������� markdown����Ȼ���������������й��������õ��������ݡ�
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
        // �ѹ��ŵ��ĵ���ͷ������ɹ��λ��Խ��
        selection: { anchor: 0 },
      });
      // ������һ΢������������� Tiptap ��ȼ��߼���
      queueMicrotask(() => {
        isSettingContent.current = false;
      });
      // �ⲿ�������ؽ� doc ֮�󣬵�ǰ���е� content �Ѳ��ٵ����Լ�֮ǰ�ɳ�ȥ��ֵ��
      // ��� lastEmitted ��������Ϊ"��д"��
      lastEmittedContentRef.current = null;
    }

    setWordStats(computeStats(nextDoc));
    onHeadingsChangeRef.current?.(extractHeadings(view));

    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
    // ���� content ������ version���� TiptapEditor ����һ�µ����塣
    // ���� EditorPane ����� content������ effect ���Ƶ��������
    // ����� lastEmittedContentRef �����������"�Լ�д���ֱ� setContent ����"��
  }, [note.id, note.content]);

  // ---------- ���ⵥ��ͬ�� ----------
  //
  // Ϊʲô������������� input �Ƿ��ܿصģ�`defaultValue={note.title}`����
  // ������� effect ֻ�� [note.id, note.content] �仯ʱ�Ż��ܡ�
  // ���ⲿֻ�Ķ� title�����ͣ���"AI ���ɱ���"��ť����˷����±��� �� setActiveNote����
  // content û�䣬�� effect ��������DOM ��ı�����Զ���־�ֵ�����û�����Ϊ
  //��AI ���ɱ���û��Ч���������һ��ר�� effect ���� note.title ���ɡ�
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    if (el.value !== note.title) {
      el.value = note.title;
    }
  }, [note.title]);

  // ---------- editable ����ͬ�� ----------

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure(
        EditorView.editable.of(editable)
      ),
    });
  }, [editable]);

  // ---------- ������� <html class="dark"> �л� ----------

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

  // ---------- ��¶ scrollTo ��������������ת�� ----------

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

  /**
   * ����˸�ʽ�˵��ţ�macOS ԭ���˵� / ��ݼ� �� CodeMirror��
   * ----------------------------------------------------------------
   * �� TiptapEditor ����ͬһ�� "nowen:format" �¼���Լ���� useDesktopMenuBridge
   * ���յ� Electron ������ "menu:format" IPC ʱ�ɷ�����
   *
   * Markdown ? ����ӳ�䣺
   *   bold      �� toggleWrap("**")
   *   italic    �� toggleWrap("*")
   *   strike    �� toggleWrap("~~")
   *   code      �� toggleInlineCode
   *   underline �� toggleWrap("<u>", "</u>")   // MD û��ԭ���»��ߣ��� HTML ��ǩ��
   *                                             ��Ⱦ�ࣨԤ�� / contentFormat����֧��
   *   heading lv�� toggleHeading(v, lv)
   *   paragraph �� toggleHeading(v, 0)          // ������ toggleHeading ������룺0 = ȥ����
   *
   * ������view δ���� / !editable ʱ���ԣ������������� view �� dispatch��
   */
  useEffect(() => {
    if (!editable) return;
    const handler = (ev: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const detail = (ev as CustomEvent<FormatMenuPayload>).detail;
      if (!detail) return;

      if (detail.mark) {
        switch (detail.mark) {
          case "bold":      toggleWrap(view, "**");   break;
          case "italic":    toggleWrap(view, "*");    break;
          case "strike":    toggleWrap(view, "~~");   break;
          case "code":      toggleInlineCode(view);   break;
          // MD ��ԭ���»����﷨���� HTML ���ס�toggleWrap �ĵ� 3 �����ڷǶԳư�����
          case "underline": toggleWrap(view, "<u>", "</u>"); break;
        }
        view.focus();
        return;
      }
      if (detail.node === "heading" && detail.level) {
        // MarkdownEditor ��֧�� h1..h3���� extractHeadings ��ٶ��룩��
        // �����ļ����� h3 ���ף��Ⱦ�Ĭ���Ը������û�Ԥ�ڡ�
        const lv = (detail.level <= 3 ? detail.level : 3) as 1 | 2 | 3;
        toggleHeading(view, lv);
        view.focus();
        return;
      }
      if (detail.node === "paragraph") {
        // "ת����" = ��ȥ���� #{1,6} \s+���������κ���ǰ׺��
        // toggleLinePrefix("", [/^#{1,6}\s+/]) ǡ��ʵ��������壺
        //   - ƥ�䵽����ǰ׺ �� �滻Ϊ ""��ɾ������
        //   - ����������    �� ���� "" ǰ׺��no-op����
        toggleLinePrefix(view, "", [/^#{1,6}\s+/]);
        view.focus();
      }
    };
    window.addEventListener("nowen:format", handler as EventListener);
    return () => window.removeEventListener("nowen:format", handler as EventListener);
  }, [editable]);

  // ---------- ����仯�������� ----------

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

  // ---------- ��ǩ�仯 ----------

  const noteTags = useMemo(() => note.tags || [], [note.tags]);

  // ---------- ���������ͳһ�� viewRef ȡ view ----------

  const withView = useCallback((fn: (v: EditorView) => void) => {
    const v = viewRef.current;
    if (!v) return;
    fn(v);
  }, []);

  const iconSize = 15;

  // ---------- ��Ⱦ ----------

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar
          v2026-05-18���� TiptapEditor ���롪��ȡ�������̵�����������������
          ��������Ϊʼ�ձ�����һ������������ sticky ���������ˣ�
          ��֤�ƶ�������ʱ���ܿ���������ʽ��ť���������������ĸ����������� */}
      {editable && (
        <div
          className={cn(
            "sticky top-0 z-20 flex items-center gap-0.5 px-4 py-2 border-b border-app-border bg-app-surface/95 backdrop-blur supports-[backdrop-filter]:bg-app-surface/70 md:flex-wrap overflow-x-auto hide-scrollbar touch-pan-x transition-colors",
          )}
        >
          <ToolbarButton
            onClick={() => withView((v) => undo(v))}
            title={tr("tiptap.undo") || "����"}
          >
            <Undo size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => redo(v))}
            title={tr("tiptap.redo") || "����"}
          >
            <Redo size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleHeading(v, 1))}
            title={tr("tiptap.heading1") || "һ������"}
          >
            <Heading1 size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleHeading(v, 2))}
            title={tr("tiptap.heading2") || "��������"}
          >
            <Heading2 size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleHeading(v, 3))}
            title={tr("tiptap.heading3") || "��������"}
          >
            <Heading3 size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "**"))}
            title={tr("tiptap.bold") || "�Ӵ�"}
          >
            <Bold size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "*"))}
            title={tr("tiptap.italic") || "б��"}
          >
            <Italic size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "~~"))}
            title={tr("tiptap.strikethrough") || "ɾ����"}
          >
            <Strikethrough size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleInlineCode(v))}
            title={tr("tiptap.inlineCode") || "���ڴ���"}
          >
            <CodeIcon size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleBulletList(v))}
            title={tr("tiptap.bulletList") || "�����б�"}
          >
            <List size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleOrderedList(v))}
            title={tr("tiptap.orderedList") || "�����б�"}
          >
            <ListOrdered size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleTaskList(v))}
            title={tr("tiptap.taskList") || "�����б�"}
          >
            <CheckSquare size={iconSize} />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            onClick={() => withView((v) => toggleBlockquote(v))}
            title={tr("tiptap.blockquote") || "����"}
          >
            <Quote size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleCodeBlock(v))}
            title={tr("tiptap.codeBlock") || "�����"}
          >
            <FileCode size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => insertHorizontalRule(v))}
            title={tr("tiptap.horizontalRule") || "�ָ���"}
          >
            <Minus size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => insertLink(v))}
            title={tr("tiptap.insertLink") || "��������"}
          >
            <LinkIcon size={iconSize} />
          </ToolbarButton>
          <ToolbarButton onClick={triggerImagePicker} title={tr("tiptap.insertImage") || "����ͼƬ"}>
            <ImagePlus size={iconSize} />
          </ToolbarButton>
          <ToolbarButton onClick={triggerAttachmentPicker} title={tr("tiptap.insertAttachment") || "���븽��"}>
            <Paperclip size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => insertTable(v))}
            title={tr("tiptap.insertTable") || "�������"}
          >
            <Table2 size={iconSize} />
          </ToolbarButton>

          {!isGuest && <ToolbarDivider />}
          {!isGuest && (
            <ToolbarButton onClick={openAIAssistant} title={tr("tiptap.aiAssistant") || "AI ����"}>
              <Sparkles size={iconSize} className="text-violet-500" />
            </ToolbarButton>
          )}
        </div>
      )}

      {/* ������ */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-2">
        <input
          ref={titleRef}
          defaultValue={note.title}
          placeholder={tr("tiptap.titlePlaceholder") || "�ޱ���"}
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

      {/* �༭������
          paddingBottom ֻ�Լ��̸߶ȣ������걻���뷨��ס��
          v2026-05-18 ���Ƴ��ƶ��������������ɶ��� sticky ��������ͳһ
          �е���ʽ����� */}
      <div
        className="flex-1 overflow-auto px-4 md:px-8"
        style={{ paddingBottom: "var(--keyboard-height, 0px)" }}
      >
        <div
          ref={hostRef}
          className="nowen-md-editor h-full"
          // �� CM6 �ڲ����������ܻ����ȷ�߶�
          style={{ minHeight: "100%" }}
        />
      </div>

      {/* ״̬��������ͳ�ƣ��� TiptapEditor ���룩 */}
      <div className="px-4 md:px-8 py-1.5 border-t border-app-border/60 text-[11px] text-tx-tertiary flex items-center gap-3 select-none">
        <span>
          {tr("tiptap.chars", { count: wordStats.chars }) || `${wordStats.chars} �ַ�`}
        </span>
        <span className="opacity-60">��</span>
        <span>
          {tr("tiptap.words", { count: wordStats.words }) || `${wordStats.words} ��`}
        </span>
        <span className="ml-auto opacity-60">Markdown</span>
      </div>

      {/* б�ܲ˵����� */}
      <MarkdownSlashMenu
        state={slashState}
        items={slashItems}
        view={viewRef.current}
        onClose={() => setSlashState(emptySlashState)}
      />

      {/*
        �������ݲ˵������� Tiptap �� BubbleMenu��
        - ֻ���зǿ�ѡ�� + �༭���۽�ʱ����
        - �� fixed ��λ + �ӿ����꣬���ⱻ��������ü�
        - onMouseDown ��ֹĬ����Ϊ����ֹ�㰴ťʱ CM ʧ������ѡ����ʧ
      */}
      {editable && bubble.open && (
        <div
          className="fixed z-40 flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1 overflow-x-auto max-w-[calc(100vw-16px)]"
          style={{ top: bubble.top, left: bubble.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
                    <ToolbarButton
            onClick={() => void copySelectionText()}
            title={tr('tiptap.copySelectionText')}
          >
            <Copy size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void selectAllText()}
            title={tr('tiptap.selectAllText')}
          >
            <ArrowUp size={14} />
          </ToolbarButton>
          {selectedTextAction?.type === "phone" && (
            <ToolbarButton
              onClick={() => {
                if (confirm(tr('tiptap.dialConfirm', { phone: selectedTextAction.value }) || '\u62e8\u6253\u7535\u8bdd\uff1f ' + selectedTextAction.value)) {
                  window.location.href = selectedTextAction.href;
                }
              }}
              title={selectedTextAction.value}
            >
              <Phone size={14} />
            </ToolbarButton>
          )}
          {selectedTextAction?.type === "url" && (
            <ToolbarButton
              onClick={() => window.open(selectedTextAction.href, '_blank', 'noopener')}
              title={selectedTextAction.value}
            >
              <ExternalLink size={14} />
            </ToolbarButton>
          )}
<ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "**"))}
            title={tr("tiptap.bold") || "�Ӵ�"}
          >
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "*"))}
            title={tr("tiptap.italic") || "б��"}
          >
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleWrap(v, "~~"))}
            title={tr("tiptap.strikethrough") || "ɾ����"}
          >
            <Strikethrough size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => withView((v) => toggleInlineCode(v))}
            title={tr("tiptap.inlineCode") || "���ڴ���"}
          >
            <CodeIcon size={14} />
          </ToolbarButton>
          {!isGuest && (
            <>
              <div className="w-px h-4 bg-app-border mx-0.5" />
              <ToolbarButton
                onClick={openAIAssistant}
                title={tr("tiptap.aiAssistant") || "AI ����"}
              >
                <Sparkles size={14} className="text-violet-500" />
              </ToolbarButton>
            </>
          )}
        </div>
      )}


      {/* AI д���������ڸ��㣨���Ƿÿ� & δ���� onAIAssistant ����ʱ���ã� */}
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

      {/*
        �ƶ��˸����������������������Ϸ���
      {/* �ƶ��˹�������Ǩ�Ƶ��� Toolbar ֮�󣬲ο��·������Ⱦ�� */}
    </div>
  );
});

// ---------------------------------------------------------------------------
// ������������ֹ Vite HMR ʱ���� view
// ---------------------------------------------------------------------------
// ��ռλ��δ������Ҫ���� import.meta.hot �ص������� viewRef��

// ---------------------------------------------------------------------------
// ���ߣ�����ɶ����ֽڴ�С���� TiptapEditor һ�£��������һ�ݱ������� import��
// ---------------------------------------------------------------------------
function formatBytesMd(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}
void StateEffect;
