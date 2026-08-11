export type NoteWriteSource =
  | "mcp"
  | "live-autosave"
  | "manual-save"
  | "sync"
  | "import"
  | "api";

const NOTE_WRITE_SOURCES = new Set<NoteWriteSource>([
  "mcp",
  "live-autosave",
  "manual-save",
  "sync",
  "import",
  "api",
]);

export function normalizeNoteWriteSource(
  value: unknown,
  fallback: NoteWriteSource = "api",
): NoteWriteSource {
  return typeof value === "string" && NOTE_WRITE_SOURCES.has(value as NoteWriteSource)
    ? value as NoteWriteSource
    : fallback;
}

export function logNoteWrite(event: {
  noteId: string;
  source: NoteWriteSource;
  baseVersion: number | null;
  oldVersion: number | null;
  newVersion: number | null;
  outcome: "committed" | "rejected";
  reason?: string;
}): void {
  // 只记录并发定位所需元数据，不记录标题或正文等敏感内容。
  console.info("[note-write]", event);
}
