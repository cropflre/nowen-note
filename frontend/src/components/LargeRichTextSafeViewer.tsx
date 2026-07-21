import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { AlertTriangle, FileText, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import type {
  NoteEditorHandle,
  NoteEditorProps,
} from "@/components/editors/types";
import { formatLargeMarkdownSize } from "@/lib/largeMarkdownSafety";
import {
  getLargeDocumentOriginalFormat,
  type RuntimeLargeRichTextSafeNote,
} from "@/lib/largeRichTextSafeMode";
import { cn } from "@/lib/utils";

interface LargeRichTextSafeViewerProps extends NoteEditorProps {
  onAIAssistant?: () => void;
}

/**
 * Read-only emergency viewer for pathological Tiptap/HTML notes.
 *
 * Converting a multi-megabyte ProseMirror JSON document on the renderer thread defeats the
 * purpose of safe mode. This component therefore shows the already indexed `contentText`
 * and keeps the original `content` snapshot untouched. Users can still read, search,
 * select and copy the note without mounting Tiptap, image node views, Markdown parsers or
 * Y.js collaboration.
 */
const LargeRichTextSafeViewer = forwardRef<
  NoteEditorHandle,
  LargeRichTextSafeViewerProps
>(function LargeRichTextSafeViewer(
  {
    note,
    onHeadingsChange,
    onEditorReady,
    searchQuery,
  },
  forwardedRef,
) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const safeNote = note as RuntimeLargeRichTextSafeNote;
  const displayText = useMemo(
    () => note.contentText || t("markdown.largeDocument.noPlainText", {
      defaultValue: "该大文档没有可用的纯文本索引。原始内容已受到保护，请导出后在外部工具中查看。",
    }),
    [note.contentText, t],
  );

  useImperativeHandle(forwardedRef, () => ({
    flushSave: () => {},
    discardPending: () => {},
    getSnapshot: () => ({
      // Return the untouched server payload so EditorPane safety checks never mistake the
      // plain-text viewer for editable source and overwrite the rich document.
      content: note.content,
      contentText: note.contentText,
    }),
    isReady: () => !!textareaRef.current,
    appendMarkdown: () => false,
  }), [note.content, note.contentText]);

  useEffect(() => {
    onHeadingsChange?.([]);
  }, [note.id, onHeadingsChange]);

  useEffect(() => {
    onEditorReady?.((position: number) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const clamped = Math.max(0, Math.min(textarea.value.length, position));
      textarea.focus();
      textarea.setSelectionRange(clamped, clamped);
    });
  }, [onEditorReady]);

  useEffect(() => {
    const query = searchQuery?.trim();
    const textarea = textareaRef.current;
    if (!query || !textarea) return;

    const index = textarea.value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (index < 0) return;
    textarea.focus();
    textarea.setSelectionRange(index, index + query.length);
  }, [note.id, searchQuery]);

  const originalFormat =
    getLargeDocumentOriginalFormat(safeNote) || "tiptap-json";

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      <div className="border-b border-amber-300/60 bg-amber-500/10 px-4 py-3 text-amber-800 dark:border-amber-500/30 dark:text-amber-200 md:px-8">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
              <span>
                {t("markdown.largeDocument.richTextSafeMode", {
                  defaultValue: "大文档只读安全模式",
                })}
              </span>
              <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium">
                {formatLargeMarkdownSize(note.content.length)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 opacity-90">
              {t("markdown.largeDocument.richTextSafeModeDesc", {
                defaultValue:
                  "该笔记体积过大，已停止富文本解析、图片节点渲染和协同全量同步。当前展示纯文本索引，原始内容不会被修改。",
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 pb-2 pt-4 md:px-8 md:pt-6">
        <input
          value={note.title}
          readOnly
          spellCheck={false}
          className="w-full bg-transparent text-2xl font-bold text-tx-primary outline-none md:text-3xl"
          aria-label={t("tiptap.titlePlaceholder", { defaultValue: "标题" })}
        />
        {!!note.tags?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {note.tags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-full border border-app-border bg-app-surface px-2 py-0.5 text-[11px] text-tx-secondary"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pb-2 md:px-8">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-tx-tertiary">
          <span className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-2 py-1">
            <FileText size={12} />
            {originalFormat}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
            <ShieldCheck size={12} />
            {t("markdown.largeDocument.originalProtected", {
              defaultValue: "原文只读保护",
            })}
          </span>
        </div>

        <textarea
          ref={textareaRef}
          defaultValue={displayText}
          readOnly
          wrap="off"
          spellCheck={false}
          className={cn(
            "min-h-0 flex-1 resize-none overflow-auto rounded-xl border border-app-border bg-app-surface p-4 font-mono text-[13px] leading-6 text-tx-primary outline-none",
            "focus:border-accent-primary/60 focus:ring-2 focus:ring-accent-primary/15",
          )}
          aria-label={t("markdown.largeDocument.plainTextViewer", {
            defaultValue: "大文档纯文本只读视图",
          })}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-app-border/60 px-4 py-1.5 text-[11px] text-tx-tertiary md:px-8">
        <span>
          {displayText.length.toLocaleString()}{" "}
          {t("tiptap.chars", { defaultValue: "字符" })}
        </span>
        <span className="opacity-60">·</span>
        <span>
          {t("markdown.largeDocument.richFeaturesDisabled", {
            defaultValue: "富文本与协同已停用",
          })}
        </span>
        <span className="ml-auto opacity-60">
          {t("markdown.largeDocument.copyAvailable", {
            defaultValue: "支持搜索、选择和复制",
          })}
        </span>
      </div>
    </div>
  );
});

LargeRichTextSafeViewer.displayName = "LargeRichTextSafeViewer";

export default LargeRichTextSafeViewer;
