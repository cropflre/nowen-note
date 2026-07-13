export type NoteDropZone = "before" | "after";

export interface SortableNoteLike {
  id: string;
  notebookId: string;
  isLocked?: number;
}

export function getNoteListDragHint(canDragSort: boolean): string {
  return canDragSort ? "拖动调整笔记顺序" : "切换到手动排序后可拖动调整顺序";
}

export function shouldUseHtmlNoteDragging(canDragSort: boolean, coarsePointer: boolean): boolean {
  return canDragSort && !coarsePointer;
}

export function getDropZoneFromClientY(clientY: number, rect: Pick<DOMRect, "top" | "height">): NoteDropZone {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function reorderNotesWithinNotebook<T extends SortableNoteLike>(
  notes: T[],
  sourceId: string,
  targetId: string,
  zone: NoteDropZone,
): { notes: T[]; items: { id: string; sortOrder: number }[] } | null {
  if (!sourceId || !targetId || sourceId === targetId) return null;

  const source = notes.find((note) => note.id === sourceId);
  const target = notes.find((note) => note.id === targetId);
  if (!source || !target) return null;
  if (source.isLocked === 1 || target.isLocked === 1) return null;
  if (source.notebookId !== target.notebookId) return null;

  const next = notes.filter((note) => note.id !== sourceId);
  const targetIdx = next.findIndex((note) => note.id === targetId);
  if (targetIdx === -1) return null;

  const insertIdx = zone === "after" ? targetIdx + 1 : targetIdx;
  next.splice(insertIdx, 0, source);

  return {
    notes: next,
    items: next
      .filter((note) => note.notebookId === source.notebookId)
      .map((note, index) => ({ id: note.id, sortOrder: index })),
  };
}
