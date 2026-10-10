export type BubbleSelectionKind = "empty" | "text" | "cell" | "image" | "other";
export type EditorBubbleKind = "none" | "text" | "table" | "image" | "link";

export interface EditorBubbleDecisionInput {
  selectionKind: BubbleSelectionKind;
  tableActive: boolean;
  linkActive: boolean;
  hasVisibleText: boolean;
}

export interface EditorBubblePositionInput {
  anchorTop: number;
  anchorBottom: number;
  centerX: number;
  bubbleWidth: number;
  bubbleHeight: number;
  viewportTop: number;
  viewportLeft: number;
  viewportWidth: number;
  viewportHeight: number;
  touchLayout: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Keep touch selection actions below Android/iOS ActionMode instead of falling back above it. */
export function resolveEditorBubblePosition(input: EditorBubblePositionInput): { top: number; left: number } {
  const viewportRight = input.viewportLeft + input.viewportWidth;
  const viewportBottom = input.viewportTop + input.viewportHeight;
  const visibleBubbleWidth = Math.min(input.bubbleWidth, Math.max(0, input.viewportWidth - 16));
  const top = input.touchLayout
    ? clamp(
      input.anchorBottom + 8,
      input.viewportTop + 8,
      viewportBottom - input.bubbleHeight - 8,
    )
    : clamp(
      input.anchorTop - input.bubbleHeight - 4,
      input.viewportTop + 8,
      viewportBottom - input.bubbleHeight - 8,
    );
  const left = clamp(
    input.centerX - visibleBubbleWidth / 2,
    input.viewportLeft + 8,
    viewportRight - visibleBubbleWidth - 8,
  );
  return { top, left };
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
