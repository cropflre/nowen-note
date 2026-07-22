export type BubbleSelectionKind = "empty" | "text" | "cell" | "image" | "other";
export type EditorBubbleKind = "none" | "text" | "table" | "image" | "link";

export interface EditorBubbleDecisionInput {
  selectionKind: BubbleSelectionKind;
  tableActive: boolean;
  linkActive: boolean;
  hasVisibleText: boolean;
}

/** Resolve exactly one editor bubble for the current ProseMirror selection. */
export function resolveEditorBubbleKind(input: EditorBubbleDecisionInput): EditorBubbleKind {
  switch (input.selectionKind) {
    case "cell":
      return "table";
    case "image":
      return "image";
    case "text":
      return input.hasVisibleText ? "text" : "none";
    case "empty":
      if (input.tableActive) return "table";
      if (input.linkActive) return "link";
      return "none";
    default:
      return "none";
  }
}
