import React, { useEffect, useState } from "react";

import FormatAwareEditorPane from "./FormatAwareEditorPane";
import NoteSplitDialog from "@/components/NoteSplitDialog";
import { useApp, useAppActions } from "@/store/AppContext";
import { canWriteNote } from "@/lib/notePermissions";
import type { NoteSplitHeadingLevel } from "@/lib/noteSplit";
import {
  getCachedPreferredNoteSplitLevel,
  resolvePreferredNoteSplitLevel,
  schedulePreferredNoteSplitLevel,
} from "@/lib/noteSplitAnalysis";
import type { Note } from "@/types";

/**
 * 文档拆分运行时外壳。
 *
 * 标题扫描只服务于可选的“拆分文档”入口，不应阻塞每次笔记切换。首次打开把扫描安排
 * 到浏览器空闲阶段；A → B → A 返回同一版本时直接复用缓存结果。
 */
export default function EditorPaneRuntime() {
  const { state } = useApp();
  const actions = useAppActions();
  const activeNote = state.activeNote;
  const [preferredLevel, setPreferredLevel] = useState<NoteSplitHeadingLevel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setDialogOpen(false);
    setPreferredLevel(null);

    const note = activeNote;
    if (!note) return;

    const cached = getCachedPreferredNoteSplitLevel(note);
    if (cached.hit) {
      setPreferredLevel(cached.level);
      return;
    }

    return schedulePreferredNoteSplitLevel(note, setPreferredLevel);
    // Deliberately analyze only when a note is opened. Re-running after every debounced save would
    // put the full-document scan back onto the editing path that this optimization removes.
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
    // This scan follows an explicit split transaction, not a routine note switch, so resolving it
    // synchronously keeps the command state accurate without affecting navigation latency.
    setPreferredLevel(resolvePreferredNoteSplitLevel(updated));
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
      <FormatAwareEditorPane
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
