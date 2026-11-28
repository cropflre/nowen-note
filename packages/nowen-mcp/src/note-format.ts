export const CONTENT_FORMAT_VALUES = ["markdown", "tiptap-json", "html", "plaintext", "ppt-json"] as const;
export const NOTE_TYPE_VALUES = ["normal", "word", "ppt"] as const;

export type NoteContentFormat = typeof CONTENT_FORMAT_VALUES[number];
export type CreatableNoteType = typeof NOTE_TYPE_VALUES[number];

export interface NoteLike {
  id?: string;
  title?: string;
  notebookId?: string;
  content?: string | null;
  contentText?: string | null;
  contentFormat?: string | null;
  noteType?: string | null;
  isPinned?: number;
  isFavorite?: number;
  isLocked?: number;
  version?: number;
  tags?: Array<{ id: string; name: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export function isValidContentFormat(value?: string | null): value is NoteContentFormat {
  return typeof value === "string" && (CONTENT_FORMAT_VALUES as readonly string[]).includes(value);
}

export function isEncryptedContentFormat(value?: string | null): boolean {
  return typeof value === "string" && value.startsWith("encrypted-note-");
}

export function normalizeContentFormat(contentFormat?: string | null): NoteContentFormat {
  if (isValidContentFormat(contentFormat)) {
    return contentFormat;
  }
  return "markdown";
}

function buildDefaultPptJson(title: string): string {
  return JSON.stringify({
    version: 1,
    title: title || "无标题 PPT 演示文稿",
    theme: "classic",
    slides: [
      {
        id: "slide-1",
        layout: "title",
        title: title || "无标题 PPT 演示文稿",
        subtitle: "",
        bullets: [],
        notes: "",
      },
    ],
  });
}

export function buildCreateNotePayload(params: {
  notebookId: string;
  title?: string;
  content?: string;
  contentFormat?: string | null;
  noteType?: CreatableNoteType;
}) {
  const noteType: CreatableNoteType = params.noteType === "word" || params.noteType === "ppt"
    ? params.noteType
    : "normal";
  const resolvedFormat: NoteContentFormat = noteType === "ppt"
    ? "ppt-json"
    : params.contentFormat !== undefined && params.contentFormat !== null
      ? normalizeContentFormat(params.contentFormat)
      : noteType === "word"
        ? "tiptap-json"
        : "markdown";

  const body: {
    notebookId: string;
    title?: string;
    content?: string;
    contentText?: string;
    contentFormat: NoteContentFormat;
    noteType?: CreatableNoteType;
  } = {
    notebookId: params.notebookId,
    contentFormat: resolvedFormat,
  };

  if (noteType !== "normal") {
    body.noteType = noteType;
  }
  if (params.title !== undefined) {
    body.title = params.title;
  }
  if (params.content !== undefined) {
    body.content = params.content;
    body.contentText = params.content;
  } else if (noteType === "ppt") {
    body.content = buildDefaultPptJson(params.title || "无标题 PPT 演示文稿");
  }

  return body;
}

export function buildUpdateNotePayload(params: {
  currentNote: Pick<NoteLike, "version" | "contentFormat" | "noteType">;
  title?: string;
  content?: string;
  contentFormat?: string | null;
}) {
  if (isEncryptedContentFormat(params.currentNote.contentFormat)) {
    throw new Error("加密笔记禁止通过 MCP 明文修改，请在 Nowen Note 客户端解锁后操作");
  }
  if (params.currentNote.noteType === "excel" && (params.content !== undefined || params.contentFormat !== undefined)) {
    throw new Error("Excel 工作簿正文请使用 nowen_update_excel 更新，不能通过 nowen_update_note 覆盖正文");
  }

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
    // 若调用方未显式指定 contentFormat，优先保留笔记现有格式，避免把 Word/富文本/TXT/PPT 误改写为 markdown。
    const contentFormat = params.contentFormat !== undefined && params.contentFormat !== null
      ? normalizeContentFormat(params.contentFormat)
      : isValidContentFormat(params.currentNote.contentFormat)
        ? params.currentNote.contentFormat
        : "markdown";
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
    noteType: note.noteType || "normal",
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
