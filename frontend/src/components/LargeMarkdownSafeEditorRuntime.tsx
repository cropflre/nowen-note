import React, {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

import LargeMarkdownSafeEditor from "./LargeMarkdownSafeEditor";
import type {
  NoteEditorHandle,
  NoteEditorProps,
} from "@/components/editors/types";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import {
  applyCodeMirrorChangesToYText,
  yTextDeltaToCodeMirrorChanges,
} from "@/lib/markdownYTextSync";
import { acquireIncrementalMarkdownYTextSync } from "@/lib/markdownYTextSyncRuntimeState";

interface LargeMarkdownSafeEditorRuntimeProps extends NoteEditorProps {
  onAIAssistant?: () => void;
}

/**
 * Incremental collaboration shell for the worker-backed large Markdown editor.
 *
 * The original component remains the UI and emergency-save boundary. This shell retrieves its
 * CodeMirror instance from the mounted DOM, appends one update listener, and mirrors ChangeSets to
 * the authoritative Y.Text immediately. Remote Y.Text deltas are replayed as CodeMirror ranges so
 * neither direction replaces or compares the entire document during normal collaboration.
 */
const LargeMarkdownSafeEditorRuntime = forwardRef<
  NoteEditorHandle,
  LargeMarkdownSafeEditorRuntimeProps
>(function LargeMarkdownSafeEditorRuntime(props, forwardedRef) {
  const { note, yDoc } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const realYDocRef = useRef<Y.Doc | null | undefined>(yDoc);
  const applyingRemoteRef = useRef(false);
  const localOriginRef = useRef<object>({});

  realYDocRef.current = yDoc;

  const normalizedContent = useMemo(
    () => normalizeToMarkdown(note.content, note.contentText),
    [note.content, note.contentText],
  );

  const initialCollaborativeContent = useMemo(() => {
    if (!yDoc) return normalizedContent;
    return yDoc.getText("content").toString() || normalizedContent;
  }, [normalizedContent, yDoc]);

  // Keep the original component in its collaboration presentation path, but isolate its legacy
  // observer from the authoritative Y.Doc. Runtime mapping below owns actual synchronization.
  const shadowYDoc = useMemo(() => {
    if (!yDoc) return null;
    const shadow = new Y.Doc();
    if (initialCollaborativeContent) {
      shadow.getText("content").insert(0, initialCollaborativeContent);
    }
    return shadow;
  }, [initialCollaborativeContent, note.id, yDoc]);

  const runtimeNote = useMemo(() => {
    if (!yDoc) return note;
    return {
      ...note,
      content: initialCollaborativeContent,
      contentText: note.contentText || initialCollaborativeContent,
    };
  }, [initialCollaborativeContent, note, yDoc]);

  useEffect(() => () => {
    shadowYDoc?.destroy();
  }, [shadowYDoc]);

  useEffect(() => {
    if (!yDoc) return;

    const releaseIncrementalLease = acquireIncrementalMarkdownYTextSync();
    const yText = yDoc.getText("content");
    const localOrigin = localOriginRef.current;
    const syncCompartment = new Compartment();
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let editorView: EditorView | null = null;

    if (yText.length === 0 && initialCollaborativeContent) {
      yDoc.transact(() => {
        yText.insert(0, initialCollaborativeContent);
      }, localOrigin);
    }

    const applyAuthoritativeSnapshot = (view: EditorView) => {
      const authoritative = yText.toString();
      if (view.state.doc.toString() === authoritative) return;
      applyingRemoteRef.current = true;
      try {
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: authoritative,
          },
        });
      } finally {
        applyingRemoteRef.current = false;
      }
    };

    const attachToEditor = () => {
      if (disposed) return;
      const editorElement = rootRef.current?.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      if (!view) {
        retryTimer = globalThis.setTimeout(attachToEditor, 16);
        return;
      }

      editorView = view;
      const incrementalListener = EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingRemoteRef.current) return;
        const activeYDoc = realYDocRef.current;
        if (!activeYDoc) return;
        applyCodeMirrorChangesToYText({
          changes: update.changes,
          yDoc: activeYDoc,
          yText: activeYDoc.getText("content"),
          origin: localOrigin,
        });
      });

      view.dispatch({
        effects: StateEffect.appendConfig.of(
          syncCompartment.of(incrementalListener),
        ),
      });
      applyAuthoritativeSnapshot(view);
    };

    const handleRemoteUpdate = (event: Y.YTextEvent) => {
      if (event.transaction.origin === localOrigin) return;
      const view = editorView;
      if (!view) return;

      const changes = yTextDeltaToCodeMirrorChanges(event.delta);
      applyingRemoteRef.current = true;
      try {
        if (changes === null) {
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: yText.toString(),
            },
          });
        } else if (changes.length > 0) {
          view.dispatch({ changes });
        }
      } finally {
        applyingRemoteRef.current = false;
      }
    };

    yText.observe(handleRemoteUpdate);
    attachToEditor();

    return () => {
      disposed = true;
      releaseIncrementalLease();
      yText.unobserve(handleRemoteUpdate);
      if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
      if (editorView) {
        try {
          editorView.dispatch({ effects: syncCompartment.reconfigure([]) });
        } catch {
          // The child editor may already be destroyed during note/editor switches.
        }
      }
    };
  }, [initialCollaborativeContent, note.id, yDoc]);

  if (!yDoc) {
    return <LargeMarkdownSafeEditor {...props} ref={forwardedRef} />;
  }

  return (
    <div ref={rootRef} className="h-full min-h-0">
      <LargeMarkdownSafeEditor
        key={`${note.id}:${yDoc.clientID}`}
        {...props}
        ref={forwardedRef}
        note={runtimeNote}
        yDoc={shadowYDoc}
        awareness={null}
      />
    </div>
  );
});

LargeMarkdownSafeEditorRuntime.displayName = "LargeMarkdownSafeEditorRuntime";

export default LargeMarkdownSafeEditorRuntime;
