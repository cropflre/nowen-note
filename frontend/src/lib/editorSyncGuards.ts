export type EditorSavePayload = {
  title?: string;
  content?: string;
  contentText?: string;
};

export function shouldSkipUnchangedTitleOnlyUpdate(
  currentTitle: string,
  data: EditorSavePayload,
): boolean {
  const hasContentPatch =
    data.content !== undefined || data.contentText !== undefined;
  if (hasContentPatch) return false;
  return data.title !== undefined && data.title === currentTitle;
}

export function isRemoteVersionNewer(
  current: { id: string; version: number } | null | undefined,
  remote: { noteId?: string; id?: string; version?: number } | null | undefined,
): boolean {
  if (!current || !remote || typeof remote.version !== "number") return false;
  const remoteId = remote.noteId ?? remote.id;
  return remoteId === current.id && remote.version > current.version;
}

type EditorSnapshot = { content: string; contentText: string; title?: string };
type PersistedNoteBody = { id: string; content: string; title: string };

/**
 * The editor's own serialization of one exact persisted body. Rich-text editors
 * re-serialize Markdown or older JSON differently, so byte equality with the
 * persisted body cannot by itself prove that the user has typed something.
 */
export type EditorCleanBaseline = {
  noteId: string;
  editorMode: string;
  noteContent: string;
  noteTitle: string;
  editorContent: string;
  editorTitle: string;
};

export function captureEditorCleanBaseline(
  note: PersistedNoteBody,
  snapshot: EditorSnapshot,
  editorMode: string,
): EditorCleanBaseline {
  return {
    noteId: note.id,
    editorMode,
    noteContent: note.content,
    noteTitle: note.title,
    editorContent: snapshot.content,
    editorTitle: snapshot.title ?? note.title,
  };
}

/** Unsaved edits exist only when the editor differs from the clean rendering of the persisted body. */
export function hasUnsavedEditorChanges({
  note,
  snapshot,
  baseline,
  editorMode,
}: {
  note: PersistedNoteBody;
  snapshot: EditorSnapshot | null;
  baseline: EditorCleanBaseline | null;
  editorMode: string;
}): boolean {
  if (!snapshot) return false;
  const title = snapshot.title ?? note.title;
  // Plain text is derived from the body; equal bodies are never an unsaved edit.
  if (snapshot.content === note.content && title === note.title) return false;
  const matches = !!baseline
    && baseline.noteId === note.id
    && baseline.editorMode === editorMode
    && baseline.noteContent === note.content
    && baseline.noteTitle === note.title;
  // Without a clean rendering of this exact body, protect the editor contents.
  if (!matches) return true;
  return snapshot.content !== baseline.editorContent || title !== baseline.editorTitle;
}

type FetchedNoteState = {
  id: string;
  version: number;
  /** Accepted but intentionally not compared (see below). */
  updatedAt?: string;
  title?: string;
  content?: string;
  tags?: Array<{ id: string }>;
};

function tagIdentity(tags: Array<{ id: string }> | undefined): string {
  return (tags || []).map((tag) => tag.id).sort().join("\u0000");
}

/**
 * Whether a persisted note read after a sync Apply differs from the open note.
 * Live Yjs persistence and tag links can change a note without a version bump.
 */
export function isFetchedRemoteNoteNewer(
  local: FetchedNoteState | null | undefined,
  fresh: FetchedNoteState | null | undefined,
): boolean {
  if (!local || !fresh || local.id !== fresh.id) return false;
  if (fresh.version !== local.version) return fresh.version > local.version;
  // Same version: only visible fields count. Timestamps may be formatted
  // differently by local saves and would signal false remote updates.
  return fresh.content !== local.content
    || fresh.title !== local.title
    || tagIdentity(fresh.tags) !== tagIdentity(local.tags);
}

export type TiptapSaveAckToken = {
  noteId: string;
  version: number;
  content: string;
  saveGeneration: number;
  preserveLocalEditor: boolean;
};

export function isMatchingTiptapSaveAck({
  noteChanged,
  noteId,
  noteVersion,
  noteContent,
  ack,
}: {
  noteChanged: boolean;
  noteId: string;
  noteVersion: number;
  noteContent: string;
  ack: TiptapSaveAckToken | null;
}): boolean {
  if (noteChanged || !ack || !ack.preserveLocalEditor) return false;
  return ack.noteId === noteId
    && ack.version === noteVersion
    && ack.content === noteContent
    && Number.isSafeInteger(ack.saveGeneration)
    && ack.saveGeneration > 0;
}

export function resolveConfirmedTiptapContent({
  serverContent,
  serverContentText,
  sentContent,
  sentContentText,
  editorSnapshot,
  fallbackContentText,
}: {
  serverContent?: string;
  serverContentText?: string;
  sentContent: string;
  sentContentText?: string;
  editorSnapshot: { content: string; contentText: string } | null;
  fallbackContentText: string;
}): {
  content: string;
  contentText: string;
  preserveLocalEditor: boolean;
} {
  const content = serverContent ?? sentContent;
  const contentText = serverContentText ?? sentContentText ?? fallbackContentText;
  return {
    content,
    contentText,
    preserveLocalEditor: !!editorSnapshot && (
      editorSnapshot.content !== sentContent || editorSnapshot.content === content
    ),
  };
}
