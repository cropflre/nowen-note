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
import { formatEditorByteSize } from "@/lib/editorComplexityProfile";
import {
  getEditorRuntimeDecisionForNote,
  getLargeDocumentOriginalFormat,
  type RuntimeLargeRichTextSafeNote,
} from "@/lib/largeRichTextSafeMode";
import type { EditorComplexityReason } from "@/lib/editorRuntimePolicy";
import { cn } from "@/lib/utils";

interface LargeRichTextSafeViewerProps extends NoteEditorProps {
  onAIAssistant?: () => void;
}

const REASON_KEYS: Record<EditorComplexityReason, string> = {
  "serialized-size": "markdown.largeDocument.reasons.serializedSize",
  "line-count": "markdown.largeDocument.reasons.lineCount",
  "long-line": "markdown.largeDocument.reasons.longLine",
  "node-count": "markdown.largeDocument.reasons.nodeCount",
  "media-count": "markdown.largeDocument.reasons.mediaCount",
  "code-block-count": "markdown.largeDocument.reasons.codeBlockCount",
  "initialization-timeout": "markdown.largeDocument.reasons.initializationTimeout",
  "runtime-long-task": "markdown.largeDocument.reasons.runtimeLongTask",
};

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
  const { t, i18n } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const safeNote = note as RuntimeLargeRichTextSafeNote;
  const decision = useMemo(() => getEditorRuntimeDecisionForNote(safeNote), [safeNote]);
  const profile = decision?.profile;
  const locale = i18n.resolvedLanguage || i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const displayText = useMemo(
    () => note.contentText || t("markdown.largeDocument.noPlainText"),
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
              <span>{t("markdown.largeDocument.richTextSafeMode")}</span>
              <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium">
                {formatEditorByteSize(profile?.bytes ?? note.content.length)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 opacity-90">
              {t("markdown.largeDocument.richTextSafeModeDesc")}
            </p>
            {profile && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                <span className="rounded border border-amber-400/30 px-1.5 py-0.5">
                  {t("markdown.largeDocument.charactersCount", {
                    value: numberFormatter.format(profile.characters),
                  })}
                </span>
                <span className="rounded border border-amber-400/30 px-1.5 py-0.5">
                  {t("markdown.largeDocument.approximateNodes", {
                    value: numberFormatter.format(profile.approximateNodes),
                  })}
                </span>
                {decision?.reasons.map((reason) => (
                  <span key={reason} className="rounded border border-amber-400/30 px-1.5 py-0.5">
                    {t(REASON_KEYS[reason])}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 pb-2 pt-4 md:px-8 md:pt-6">
        <input
          value={note.title}
          readOnly
          spellCheck={false}
          className="w-full bg-transparent text-2xl font-bold text-tx-primary outline-none md:text-3xl"
          aria-label={t("tiptap.titlePlaceholder")}
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
            {t("markdown.largeDocument.originalProtected")}
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
          aria-label={t("markdown.largeDocument.plainTextViewer")}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-app-border/60 px-4 py-1.5 text-[11px] text-tx-tertiary md:px-8">
        <span>
          {t("markdown.largeDocument.charactersCount", {
            value: numberFormatter.format(displayText.length),
          })}
        </span>
        <span className="opacity-60">·</span>
        <span>{t("markdown.largeDocument.richFeaturesDisabled")}</span>
        <span className="ml-auto opacity-60">
          {t("markdown.largeDocument.copyAvailable")}
        </span>
      </div>
    </div>
  );
});

LargeRichTextSafeViewer.displayName = "LargeRichTextSafeViewer";

export default LargeRichTextSafeViewer;
