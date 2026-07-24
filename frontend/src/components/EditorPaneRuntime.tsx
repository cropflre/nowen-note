import React, { useEffect, useState } from "react";
import { Scissors } from "lucide-react";

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
 * Runtime shell for document splitting.
 *
 * The original EditorPane remains untouched. This shell scans a Markdown or Tiptap note once when
 * it opens, exposes a compact split action when two peer headings exist, and owns the transactional
 * preview dialog. The server re-reads and version-checks the note before applying any mutation.
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
      <EditorPane />

      {canSplit && (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="absolute bottom-10 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-accent-primary/25 bg-app-elevated/95 px-3 py-2 text-xs font-medium text-accent-primary shadow-lg backdrop-blur transition hover:bg-accent-primary/10"
          title={`按 H${preferredLevel} 拆分为章节笔记`}
          aria-label="拆分文档"
        >
          <Scissors size={14} />
          拆分文档
        </button>
      )}

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
