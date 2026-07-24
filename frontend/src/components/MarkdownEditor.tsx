import React, { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
import LargeMarkdownSafeEditor from "@/components/LargeMarkdownSafeEditor";
import LargeRichTextSafeViewer from "@/components/LargeRichTextSafeViewer";
import MarkdownEditorImpl from "@/components/MarkdownEditorImpl";
import type {
  NoteEditorHandle,
  NoteEditorHeading,
  NoteEditorProps,
  NoteEditorUpdatePayload,
} from "@/components/editors/types";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import { shouldUseLargeMarkdownOptimizedMode } from "@/lib/largeMarkdownSafety";
import { isLargeRichTextSafeNote } from "@/lib/largeRichTextSafeMode";
import { mergeMarkdownEditorHeadings } from "@/lib/markdownEditorOutline";
import { createBlockPatchOperationId, patchMarkdownBlocks } from "@/lib/blockPatchApi";
import { planMarkdownBlockPatch } from "@/lib/markdownBlockPatchPlanner";
import {
  shouldFallbackTiptapBlockPatchToWholeSave,
  shouldRetryTiptapBlockPatch,
} from "@/lib/tiptapBlockPatchRuntime";
import { useAppActions } from "@/store/AppContext";

type AppActions = ReturnType<typeof useAppActions>;

function MarkdownPatchAppActionsBridge({ target }: { target: React.MutableRefObject<AppActions | null> }) {
  const actions = useAppActions();
  useEffect(() => {
    target.current = actions;
    return () => { if (target.current === actions) target.current = null; };
  }, [actions, target]);
  return null;
}

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
    const appActionsRef = useRef<AppActions | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const lifecycleRef = useRef(0);
    const inflightRef = useRef(false);
    const queuedPayloadRef = useRef<NoteEditorUpdatePayload | null>(null);
    const drainAfterVersionRef = useRef<number | null>(null);
    const processPayloadRef = useRef<(payload: NoteEditorUpdatePayload) => void>(() => undefined);
    const { note, onHeadingsChange } = props;
    const richTextSafeMode = isLargeRichTextSafeNote(note);

    // Historical Tiptap JSON is commonly serialized as one compact line. Classify the normalized
    // Markdown instead of the raw storage string, otherwise an ordinary rich-text note would be
    // mistaken for a pathological long-line Markdown document. Emergency rich text must skip the
    // conversion completely so the pre-mount safety boundary remains intact.
    const normalizedMarkdown = useMemo(
      () => richTextSafeMode ? "" : normalizeToMarkdown(note.content, note.contentText),
      [note.content, note.contentText, richTextSafeMode],
    );
    const optimizedMode = useMemo(
      () => !richTextSafeMode && shouldUseLargeMarkdownOptimizedMode(normalizedMarkdown),
      [normalizedMarkdown, richTextSafeMode],
    );
    const blockPatchEnabled = note.contentFormat === "markdown"
      && props.editable !== false
      && props.isGuest !== true
      && !props.yDoc;

    useEffect(() => {
      lifecycleRef.current += 1;
      inflightRef.current = false;
      queuedPayloadRef.current = null;
      drainAfterVersionRef.current = null;
    }, [note.id]);

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

    const processPayload = useCallback((payload: NoteEditorUpdatePayload) => {
      const currentProps = propsRef.current;
      const currentNote = currentProps.note;
      if (inflightRef.current) {
        queuedPayloadRef.current = payload;
        return;
      }
      const actions = appActionsRef.current;
      if (!blockPatchEnabled || !actions || typeof payload.content !== "string" || payload.title !== currentNote.title) {
        currentProps.onUpdate(payload);
        return;
      }
      const plan = planMarkdownBlockPatch(currentNote.content, payload.content);
      if (!plan) {
        currentProps.onUpdate(payload);
        return;
      }
      const lifecycle = lifecycleRef.current;
      const operationId = createBlockPatchOperationId();
      inflightRef.current = true;
      actions.setSyncStatus("saving");
      const request = { expectedNoteVersion: currentNote.version, operationId, operations: plan.operations };
      void (async () => {
        try {
          let result;
          try {
            result = await patchMarkdownBlocks(currentNote.id, request);
          } catch (error) {
            if (!shouldRetryTiptapBlockPatch(error)) throw error;
            result = await patchMarkdownBlocks(currentNote.id, request);
          }
          if (lifecycleRef.current !== lifecycle || propsRef.current.note.id !== currentNote.id) return;
          const latest = propsRef.current.note;
          const updated = {
            ...latest,
            title: result.title || latest.title,
            content: result.content,
            contentText: result.contentText,
            contentFormat: result.contentFormat || latest.contentFormat,
            notebookId: result.notebookId ?? latest.notebookId,
            version: result.version,
            updatedAt: result.updatedAt,
          };
          actions.setActiveNote(updated);
          actions.updateNoteInList({
            id: updated.id,
            title: updated.title,
            contentText: updated.contentText,
            updatedAt: updated.updatedAt,
            version: updated.version,
            notebookId: updated.notebookId,
          } as any);
          actions.updateNoteTab({
            id: updated.id,
            title: updated.title,
            updatedAt: updated.updatedAt,
            contentFormat: updated.contentFormat,
            isLocked: updated.isLocked,
            isTrashed: updated.isTrashed,
            notebookId: updated.notebookId,
          });
          actions.setSyncStatus("saved");
          actions.setLastSynced(new Date().toISOString());
          inflightRef.current = false;
          if (queuedPayloadRef.current) drainAfterVersionRef.current = result.version;
        } catch (error) {
          if (lifecycleRef.current !== lifecycle || propsRef.current.note.id !== currentNote.id) return;
          inflightRef.current = false;
          const latestPayload = queuedPayloadRef.current || payload;
          queuedPayloadRef.current = null;
          drainAfterVersionRef.current = null;
          if (shouldFallbackTiptapBlockPatchToWholeSave(error)) {
            propsRef.current.onUpdate(latestPayload);
          } else {
            actions.setSyncStatus("error");
            console.warn("[markdown-block-patch] confirmed save unavailable; local content preserved", error);
          }
        }
      })();
    }, [blockPatchEnabled]);
    processPayloadRef.current = processPayload;

    useEffect(() => {
      const targetVersion = drainAfterVersionRef.current;
      if (targetVersion == null || note.version < targetVersion || inflightRef.current) return;
      const queued = queuedPayloadRef.current;
      drainAfterVersionRef.current = null;
      queuedPayloadRef.current = null;
      if (queued) processPayloadRef.current(queued);
    }, [note.content, note.version]);

    const runtimeProps = { ...props, onUpdate: processPayload };

    if (richTextSafeMode) {
      return (
        <>
          {blockPatchEnabled && <MarkdownPatchAppActionsBridge target={appActionsRef} />}
          <LargeRichTextSafeViewer
            {...runtimeProps}
            ref={assignRef}
            onHeadingsChange={onHeadingsChange}
          />
        </>
      );
    }

    if (optimizedMode) {
      return (
        <>
          {blockPatchEnabled && <MarkdownPatchAppActionsBridge target={appActionsRef} />}
          <LargeMarkdownSafeEditor
            {...runtimeProps}
            ref={assignRef}
            onHeadingsChange={onHeadingsChange}
          />
        </>
      );
    }

    return (
      <>
        {blockPatchEnabled && <MarkdownPatchAppActionsBridge target={appActionsRef} />}
        <MarkdownEditorImpl
          {...runtimeProps}
          ref={assignRef}
          onHeadingsChange={onHeadingsChange ? handleHeadingsChange : undefined}
        />
      </>
    );
  },
);

MarkdownEditor.displayName = "MarkdownEditor";

export default MarkdownEditor;
