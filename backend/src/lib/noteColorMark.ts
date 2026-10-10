export const NOTE_COLOR_MARKS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
export type NoteColorMark = typeof NOTE_COLOR_MARKS[number];
const NOTE_COLOR_MARK_SET = new Set<string>(NOTE_COLOR_MARKS);
export function isValidNoteColorMarkInput(value: unknown): value is NoteColorMark | null {
  return value === null || (typeof value === "string" && NOTE_COLOR_MARK_SET.has(value));
}
export function normalizeNoteColorMark(value: unknown): NoteColorMark | null {
  return typeof value === "string" && NOTE_COLOR_MARK_SET.has(value) ? value as NoteColorMark : null;
}
