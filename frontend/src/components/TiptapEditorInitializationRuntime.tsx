import React, { forwardRef } from "react";

import type { NoteEditorHandle } from "@/components/editors/types";
import { useEditorInitializationTimeout } from "@/hooks/useEditorInitializationTimeout";
import TiptapEditorRuntime from "./TiptapEditorRuntime";

type TiptapEditorInitializationRuntimeProps = React.ComponentPropsWithoutRef<typeof TiptapEditorRuntime>;

/** Adds the shared initialization watchdog around the existing Tiptap runtime shell. */
const TiptapEditorInitializationRuntime = forwardRef<
  NoteEditorHandle,
  TiptapEditorInitializationRuntimeProps
>(function TiptapEditorInitializationRuntime(props, ref) {
  const onEditorReady = useEditorInitializationTimeout({
    noteId: props.note.id,
    engine: "tiptap",
    onEditorReady: props.onEditorReady,
  });

  return (
    <TiptapEditorRuntime
      {...props}
      ref={ref}
      onEditorReady={onEditorReady}
    />
  );
});

TiptapEditorInitializationRuntime.displayName = "TiptapEditorInitializationRuntime";

export default TiptapEditorInitializationRuntime;
