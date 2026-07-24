import React, { useEffect, useState } from "react";

import EditorPane from "./EditorPane";
import NoteSplitDialog from "@/components/NoteSplitDialog";
import { useApp, useAppActions } from "@/store/AppContext";
import { canWriteNote } from "@/lib/notePermissions";
import {
  findPreferredMarkdownSplitLevel,
  type NoteSplitHeadingLevel,
} from "@/lib/noteSplit";
import { findPreferredTiptapSplitLevel } from "@/lib/tiptapNoteSplit";
import type { Note } from "@/types";

function resolvePreferredLevel(note: Note | null | undefined): NoteSplitHeadingLevel | null {
  if (!note) return null;
  if (note.contentFormat === "markdown") {
    return findPreferredMarkdownSplitLevel(note.content || "");
  }
  if (note.contentFormat === "tiptap-json") {
    return findPreferredTiptapSplitLevel(note.content || "");
  }
  return null;
}

/**
 * 文档拆分运行时外壳：打开笔记时扫描一次可用标题层级，
 * 将拆分能力交给编辑器菜单，并持有事务化预览弹窗。
 */
export default function EditorPaneRuntime() {
  const { state } = useApp();
  const actions = useAppActions();
  const activeNote = state.activeNote;
  const [preferredLevel, setPreferredLevel] = useState<NoteSplitHeadingLevel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setDialogOpen(false);
    setPreferredLevel(resolvePreferredLevel(activeNote));
    // Deliberately scan only when a note is opened. Re-running a full heading scan after every
    // debounced save would undermine the large-document performance work this feature builds on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNote?.id]);

  const handleApplied = (updated: Note) => {
    actions.setActiveNote(updated);
    actions.updateNoteInList({
      id: updated.id,
      title: updated.title,
      contentText: updated.contentText,
      updatedAt: updated.updatedAt,
      version: updated.version,
      notebookId: updated.notebookId,
      workspaceId: updated.workspaceId,
    });
    actions.updateNoteTab({
      id: updated.id,
      title: updated.title,
      updatedAt: updated.updatedAt,
      contentFormat: updated.contentFormat,
      isLocked: updated.isLocked,
      isTrashed: updated.isTrashed,
      notebookId: updated.notebookId,
    });
    setPreferredLevel(resolvePreferredLevel(updated));
    actions.refreshNotes();
    actions.refreshNotebooks();
  };

  const supportedFormat = activeNote?.contentFormat === "markdown"
    || activeNote?.contentFormat === "tiptap-json";
  const canSplit = !!(
    activeNote
    && preferredLevel
    && supportedFormat
    && !activeNote.isLocked
    && !activeNote.isTrashed
    && canWriteNote(activeNote)
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <EditorPane
        canSplitDocument={canSplit}
        onSplitDocument={() => setDialogOpen(true)}
      />

      {dialogOpen && activeNote && preferredLevel && (
        <NoteSplitDialog
          open
          note={activeNote}
          notebooks={state.notebooks || []}
          preferredLevel={preferredLevel}
          onClose={() => setDialogOpen(false)}
          onApplied={handleApplied}
        />
      )}
    </div>
  );
}
