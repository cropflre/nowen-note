export const CONTENT_FORMAT_VALUES = ["markdown", "tiptap-json", "html"] as const;

export type NoteContentFormat = typeof CONTENT_FORMAT_VALUES[number];

export interface NoteLike {
  id?: string;
  title?: string;
  notebookId?: string;
  content?: string | null;
  contentText?: string | null;
  contentFormat?: string | null;
  isPinned?: number;
  isFavorite?: number;
  isLocked?: number;
  version?: number;
  tags?: Array<{ id: string; name: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export function normalizeContentFormat(contentFormat?: string | null): NoteContentFormat {
  if (contentFormat === "tiptap-json" || contentFormat === "html") {
    return contentFormat;
  }
  return "markdown";
}

export function buildCreateNotePayload(params: {
  notebookId: string;
  title?: string;
  content?: string;
  contentFormat?: string | null;
}) {
  const body: {
    notebookId: string;
    title?: string;
    content?: string;
    contentText?: string;
    contentFormat: NoteContentFormat;
  } = {
    notebookId: params.notebookId,
    contentFormat: normalizeContentFormat(params.contentFormat),
  };

  if (params.title !== undefined) {
    body.title = params.title;
  }
  if (params.content !== undefined) {
    body.content = params.content;
    body.contentText = params.content;
  }

  return body;
}

export function buildUpdateNotePayload(params: {
  currentNote: Pick<NoteLike, "version">;
  title?: string;
  content?: string;
  contentFormat?: string | null;
}) {
  const body: {
    title?: string;
    content?: string;
    contentText?: string;
    contentFormat?: NoteContentFormat;
    version: number;
    syncToYjs?: boolean;
    writeSource: "mcp";
  } = {
    version: params.currentNote.version || 1,
    writeSource: "mcp",
  };

  if (params.title !== undefined) {
    body.title = params.title;
  }
  if (params.content !== undefined) {
    const contentFormat = normalizeContentFormat(params.contentFormat);
    body.content = params.content;
    body.contentText = params.content;
    body.contentFormat = contentFormat;

    // Markdown Live 模式以服务端 Y.Doc/Y.Text 为运行时权威状态。MCP 如果只更新
    // notes.content，活跃房间里的旧 Y.Text 会在下一次持久化时把 MCP 内容覆盖掉。
    // 复用 notes PUT 已有的原子替换路径，使数据库、Yjs 历史和在线客户端同步更新。
    if (contentFormat === "markdown") {
      body.syncToYjs = true;
    }
  }

  return body;
}

export async function buildUpdateNotePayloadWithCurrentVersion(
  api: { getNote: (noteId: string) => Promise<NoteLike> },
  params: {
    noteId: string;
    title?: string;
    content?: string;
    contentFormat?: string | null;
  },
) {
  const currentNote = await api.getNote(params.noteId);
  return buildUpdateNotePayload({
    currentNote,
    title: params.title,
    content: params.content,
    contentFormat: params.contentFormat,
  });
}

export function buildReadNoteResult(note: NoteLike) {
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebookId,
    contentText: note.contentText,
    contentFormat: note.contentFormat || "unknown",
    isPinned: note.isPinned,
    isFavorite: note.isFavorite,
    isLocked: note.isLocked,
    version: note.version,
    tags: note.tags?.map((t) => ({ id: t.id, name: t.name })),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
