import React, { forwardRef, useEffect, useSyncExternalStore } from "react";

import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";
import {
  getActiveEditorRuntimeDecision,
  subscribeEditorRuntime,
} from "@/lib/editorRuntimeStore";
import BaseTiptapEditor from "./TiptapEditor";

type RuntimeTiptapEditorProps = NoteEditorProps & {
  presentationMode?: boolean;
};

/**
 * Keep the full editor for normal documents while removing nonessential whole-document outline
 * scans once the runtime policy has entered an optimized mode. Saving remains owned by the base
 * editor; its plain-text serializer is separately routed through an immutable Fragment cache.
 */
const TiptapEditorRuntime = forwardRef<NoteEditorHandle, RuntimeTiptapEditorProps>(
  function TiptapEditorRuntime(props, ref) {
    const decision = useSyncExternalStore(
      subscribeEditorRuntime,
      getActiveEditorRuntimeDecision,
      getActiveEditorRuntimeDecision,
    );
    const publishRealtimeOutline = decision.capabilities.wholeDocumentAnalysis;

    useEffect(() => {
      if (!publishRealtimeOutline) props.onHeadingsChange?.([]);
    }, [props.note.id, props.onHeadingsChange, publishRealtimeOutline]);

    return (
      <BaseTiptapEditor
        {...props}
        ref={ref}
        onHeadingsChange={publishRealtimeOutline ? props.onHeadingsChange : undefined}
      />
    );
  },
);

TiptapEditorRuntime.displayName = "TiptapEditorRuntime";

export default TiptapEditorRuntime;
