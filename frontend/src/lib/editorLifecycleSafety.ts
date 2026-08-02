import { shouldEmitTitleUpdate } from "@/lib/titleIme";

export type EditorLifecycleSaveMode = "none" | "title" | "content";

export function resolveEditorLifecycleSave({
  hasPendingContent,
  title,
  noteTitle,
  lastEmittedTitle,
  isTitleComposing,
}: {
  hasPendingContent: boolean;
  title: string;
  noteTitle: string;
  lastEmittedTitle: string;
  isTitleComposing: boolean;
}): EditorLifecycleSaveMode {
  if (hasPendingContent) return "content";
  if (isTitleComposing) return "none";
  return shouldEmitTitleUpdate({ title, noteTitle, lastEmittedTitle })
    ? "title"
    : "none";
}
