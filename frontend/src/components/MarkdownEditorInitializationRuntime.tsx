import React, { forwardRef } from "react";

import type { NoteEditorHandle } from "@/components/editors/types";
import { useEditorInitializationTimeout } from "@/hooks/useEditorInitializationTimeout";
import MarkdownEditor from "./MarkdownEditor";

type MarkdownEditorInitializationRuntimeProps = React.ComponentPropsWithoutRef<typeof MarkdownEditor>;

/** Adds the shared initialization watchdog without changing the public Markdown editor contract. */
const MarkdownEditorInitializationRuntime = forwardRef<
  NoteEditorHandle,
  MarkdownEditorInitializationRuntimeProps
>(function MarkdownEditorInitializationRuntime(props, ref) {
  const onEditorReady = useEditorInitializationTimeout({
    noteId: props.note.id,
    engine: "markdown",
    onEditorReady: props.onEditorReady,
  });

  return (
    <MarkdownEditor
      {...props}
      ref={ref}
      onEditorReady={onEditorReady}
    />
  );
});

MarkdownEditorInitializationRuntime.displayName = "MarkdownEditorInitializationRuntime";

export default MarkdownEditorInitializationRuntime;
