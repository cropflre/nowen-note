import { useLayoutEffect, useMemo, useState } from "react";
import EditorPane from "@/components/EditorPane";
import { useApp } from "@/store/AppContext";
import { setActiveNoteEditorModeOverride } from "@/lib/editorMode";
import {
  editorModeForNoteEditorKind,
  resolveNoteEditorKind,
} from "@/lib/noteEditorRouting";

/**
 * Route an existing note by its persisted contentFormat before EditorPane mounts.
 * This override is in-memory and note-scoped: it neither mutates the user's global
 * editor preference nor allows the debug URL flag to open an incompatible editor.
 */
export default function FormatAwareEditorPane() {
  const { state } = useApp();
  const note = state.activeNote;
  const kind = resolveNoteEditorKind(note?.contentFormat);
  const mode = editorModeForNoteEditorKind(kind);
  const editorKey = useMemo(
    () => note ? `${note.id}:${kind}` : "empty",
    [kind, note?.id],
  );
  const [preparedKey, setPreparedKey] = useState<string>(() => note ? "" : "empty");

  useLayoutEffect(() => {
    if (!note) {
      setActiveNoteEditorModeOverride(null);
      setPreparedKey("empty");
      return;
    }

    setActiveNoteEditorModeOverride(mode);
    setPreparedKey(editorKey);
    return () => setActiveNoteEditorModeOverride(null);
  }, [editorKey, mode, note?.id]);

  if (note && preparedKey !== editorKey) {
    return <div className="flex-1 min-h-0 bg-app-bg" aria-hidden="true" />;
  }

  return <EditorPane key={editorKey} />;
}
