import type { Editor } from "@tiptap/react";

export type CodeBlockToolbarAction =
  | "copy"
  | "collapse"
  | "mermaid-view"
  | "theme"
  | "language"
  | "dissolve";

const MUTATING_ACTIONS = new Set<CodeBlockToolbarAction>([
  "language",
  "dissolve",
]);

export function isEditorDocumentMutable(
  editor: Pick<Editor, "isEditable" | "isDestroyed"> | null | undefined,
): boolean {
  return !!editor && editor.isDestroyed !== true && editor.isEditable === true;
}

/**
 * Code-block toolbar permission matrix.
 *
 * View-only actions remain available while a notebook is locked. Actions that
 * change node attributes or document structure require an editable editor.
 */
export function canUseCodeBlockToolbarAction(
  action: CodeBlockToolbarAction,
  editor: Pick<Editor, "isEditable" | "isDestroyed"> | null | undefined,
): boolean {
  return !MUTATING_ACTIONS.has(action) || isEditorDocumentMutable(editor);
}
