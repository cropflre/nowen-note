/**
 * Local, per-account/per-server reading positions.
 * Stores viewport coordinates only; it never modifies note content or Sync V2.
 */
export const NOTE_READING_POSITIONS_KEY = "nowen.note-reading-positions.v1";
export const NOTE_READING_POSITIONS_LIMIT = 160;

export interface NoteReadingPosition {
  top: number;
  ratio: number;
  savedAt: number;
}

type ReadingPositionRecord = Record<string, NoteReadingPosition>;

export function noteReadingPositionKey(
  server: string,
  userId: string,
  noteId: string,
  mode: string,
): string {
  return JSON.stringify([server, userId, noteId, mode]);
}

function normalizePosition(value: unknown): NoteReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<NoteReadingPosition>;
  if (!Number.isFinite(v.top) || !Number.isFinite(v.ratio) || !Number.isFinite(v.savedAt)) return null;
  if (v.top! < 0 || v.ratio! < 0 || v.ratio! > 1) return null;
  return { top: v.top!, ratio: v.ratio!, savedAt: v.savedAt! };
}

function readRecords(): ReadingPositionRecord {
  try {
    const raw = localStorage.getItem(NOTE_READING_POSITIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: ReadingPositionRecord = {};
    for (const [key, value] of Object.entries(parsed)) {
      const position = normalizePosition(value);
      if (position) result[key] = position;
    }
    return result;
  } catch {
    return {};
  }
}

export function readNoteReadingPosition(key: string): NoteReadingPosition | null {
  return readRecords()[key] || null;
}

export function saveNoteReadingPosition(
  key: string,
  top: number,
  scrollHeight: number,
  clientHeight: number,
  savedAt = Date.now(),
): void {
  if (!key || !Number.isFinite(top) || !Number.isFinite(savedAt)) return;
  const max = Math.max(0, scrollHeight - clientHeight);
  const safeTop = Math.max(0, Math.min(max, top));
  const all = readRecords();
  all[key] = { top: Math.round(safeTop), ratio: max > 0 ? safeTop / max : 0, savedAt };
  const entries = Object.entries(all)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, NOTE_READING_POSITIONS_LIMIT);
  try {
    localStorage.setItem(NOTE_READING_POSITIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Reading location is best effort; storage quota/private mode must not break editing.
  }
}

export function resolveNoteReadingScrollTop(
  position: NoteReadingPosition,
  scrollHeight: number,
  clientHeight: number,
): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  // Absolute position is more faithful after small edits. If content shrinks,
  // clamp rather than jumping back to the beginning.
  return Math.max(0, Math.min(max, position.top));
}
