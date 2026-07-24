import type { EditorMode } from "@/lib/editorMode";

export type NoteEditorKind = "markdown" | "tiptap" | "html-preview";

export function resolveNoteEditorKind(contentFormat: string | null | undefined): NoteEditorKind {
  if (contentFormat === "markdown") return "markdown";
  if (contentFormat === "html") return "html-preview";
  return "tiptap";
}

export function editorModeForNoteEditorKind(kind: NoteEditorKind): EditorMode {
  return kind === "markdown" ? "md" : "tiptap";
}
