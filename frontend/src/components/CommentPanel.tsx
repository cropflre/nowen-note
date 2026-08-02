import React, { useEffect, useRef } from "react";
import { openInlineCommentPanel } from "@/lib/inlineCommentEvents";

interface CommentPanelProps {
  noteId: string;
  noteTitle: string;
  onClose: () => void;
}

/**
 * Compatibility entry used by EditorPane's existing “评论与批注” menu items.
 *
 * The actual UI is now rendered once by InlineCommentBridge so selection
 * annotations and the legacy whole-note entry share the same right-side
 * drawer, permission checks, polling and anchor highlighting.
 */
export default function CommentPanel({ noteId, noteTitle, onClose }: CommentPanelProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    openInlineCommentPanel({
      noteId,
      noteTitle,
      onClose: () => onCloseRef.current(),
    });
  }, [noteId, noteTitle]);

  return null;
}
