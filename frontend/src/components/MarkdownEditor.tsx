import React, { forwardRef, useCallback, useMemo, useRef } from "react";
import LargeMarkdownSafeEditor from "@/components/LargeMarkdownSafeEditor";
import MarkdownEditorImpl from "@/components/MarkdownEditorImpl";
import type {
  NoteEditorHandle,
  NoteEditorHeading,
  NoteEditorProps,
} from "@/components/editors/types";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import { shouldUseLargeMarkdownSafeMode } from "@/lib/largeMarkdownSafety";
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
 * Normal notes use the full CodeMirror + live-preview implementation. Pathological
 * documents are routed to an uncontrolled native textarea before the expensive Markdown
 * language parser, syntax highlighter and ReactMarkdown tree are mounted. This keeps the
 * renderer recoverable for multi-megabyte imports while preserving the shared editor
 * contract (save, snapshot, tags, outline and collaboration).
 */
const MarkdownEditor = forwardRef<NoteEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(props, forwardedRef) {
    const innerRef = useRef<NoteEditorHandle | null>(null);
    const { note, onHeadingsChange } = props;

    const safeMode = useMemo(
      () => shouldUseLargeMarkdownSafeMode(note.content || note.contentText),
      [note.content, note.contentText],
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
      const markdown =
        innerRef.current?.getSnapshot?.()?.content ??
        normalizeToMarkdown(note.content, note.contentText);
      onHeadingsChange(mergeMarkdownEditorHeadings(headings, markdown));
    }, [note.content, note.contentText, onHeadingsChange]);

    if (safeMode) {
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
