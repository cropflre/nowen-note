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
