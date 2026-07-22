import React, { forwardRef, useCallback, useMemo, useRef } from "react";
import LargeMarkdownSafeEditor from "@/components/LargeMarkdownSafeEditor";
import LargeRichTextSafeViewer from "@/components/LargeRichTextSafeViewer";
import MarkdownEditorImpl from "@/components/MarkdownEditorImpl";
import type {
  NoteEditorHandle,
  NoteEditorHeading,
  NoteEditorProps,
} from "@/components/editors/types";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import { shouldUseLargeMarkdownOptimizedMode } from "@/lib/largeMarkdownSafety";
import { isLargeRichTextSafeNote } from "@/lib/largeRichTextSafeMode";
import { mergeMarkdownEditorHeadings } from "@/lib/markdownEditorOutline";

export {
  normalizeFormatHeadingLevel,
} from "@/components/MarkdownEditorImpl";
export type { HeadingItem } from "@/components/MarkdownEditorImpl";

interface MarkdownEditorProps extends NoteEditorProps {
  onAIAssistant?: () => void;
}

/**
 * Public Markdown editor adapter.
 *
 * Small notes use the complete editor with live preview. Medium and large Markdown documents use
 * the worker-backed CodeMirror viewport editor. Extreme rich-text payloads routed through this
 * adapter continue to use the emergency read-only viewer before Tiptap/Y.js are mounted.
 */
const MarkdownEditor = forwardRef<NoteEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(props, forwardedRef) {
    const innerRef = useRef<NoteEditorHandle | null>(null);
    const { note, onHeadingsChange } = props;
    const richTextSafeMode = isLargeRichTextSafeNote(note);

    // Historical Tiptap JSON is commonly serialized as one compact line. Classify the normalized
    // Markdown instead of the raw storage string, otherwise an ordinary rich-text note would be
    // mistaken for a pathological long-line Markdown document.
    const normalizedMarkdown = useMemo(
      () => normalizeToMarkdown(note.content, note.contentText),
      [note.content, note.contentText],
    );
    const optimizedMode = useMemo(
      () => shouldUseLargeMarkdownOptimizedMode(normalizedMarkdown),
      [normalizedMarkdown],
    );

    const assignRef = useCallback((handle: NoteEditorHandle | null) => {
      innerRef.current = handle;
      if (typeof forwardedRef === "function") {
        forwardedRef(handle);
      } else if (forwardedRef) {
        forwardedRef.current = handle;
      }
    }, [forwardedRef]);

    const handleHeadingsChange = useCallback((headings: NoteEditorHeading[]) => {
      if (!onHeadingsChange) return;
      const markdown = innerRef.current?.getSnapshot?.()?.content ?? normalizedMarkdown;
      onHeadingsChange(mergeMarkdownEditorHeadings(headings, markdown));
    }, [normalizedMarkdown, onHeadingsChange]);

    if (richTextSafeMode) {
      return (
        <LargeRichTextSafeViewer
          {...props}
          ref={assignRef}
          onHeadingsChange={onHeadingsChange}
        />
      );
    }

    if (optimizedMode) {
      return (
        <LargeMarkdownSafeEditor
          {...props}
          ref={assignRef}
          onHeadingsChange={onHeadingsChange}
        />
      );
    }

    return (
      <MarkdownEditorImpl
        {...props}
        ref={assignRef}
        onHeadingsChange={onHeadingsChange ? handleHeadingsChange : undefined}
      />
    );
  },
);

MarkdownEditor.displayName = "MarkdownEditor";

export default MarkdownEditor;
