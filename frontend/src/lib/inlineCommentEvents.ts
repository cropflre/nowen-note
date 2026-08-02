import type { TextCommentAnchor } from "@/lib/inlineCommentAnchor";

export const OPEN_INLINE_COMMENT_PANEL_EVENT = "nowen:inline-comments:open";
export const CLOSE_INLINE_COMMENT_PANEL_EVENT = "nowen:inline-comments:close";

export interface OpenInlineCommentPanelDetail {
  noteId: string;
  noteTitle?: string;
  anchor?: TextCommentAnchor | null;
  onClose?: () => void;
}

export function openInlineCommentPanel(detail: OpenInlineCommentPanelDetail): void {
  window.dispatchEvent(new CustomEvent<OpenInlineCommentPanelDetail>(
    OPEN_INLINE_COMMENT_PANEL_EVENT,
    { detail },
  ));
}

export function closeInlineCommentPanel(): void {
  window.dispatchEvent(new CustomEvent(CLOSE_INLINE_COMMENT_PANEL_EVENT));
}
