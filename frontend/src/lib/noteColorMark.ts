import type { NoteColorMark } from "@/types";

export const NOTE_COLOR_MARK_OPTIONS: Array<{
  value: NoteColorMark | null;
  hex: string;
  labelKey: string;
}> = [
  { value: null, hex: "transparent", labelKey: "note.colorMark.none" },
  { value: "red", hex: "#ef4444", labelKey: "note.colorMark.red" },
  { value: "orange", hex: "#f97316", labelKey: "note.colorMark.orange" },
  { value: "yellow", hex: "#eab308", labelKey: "note.colorMark.yellow" },
  { value: "green", hex: "#22c55e", labelKey: "note.colorMark.green" },
  { value: "blue", hex: "#3b82f6", labelKey: "note.colorMark.blue" },
  { value: "purple", hex: "#a855f7", labelKey: "note.colorMark.purple" },
  { value: "gray", hex: "#9ca3af", labelKey: "note.colorMark.gray" },
];

const COLOR_BY_ID = new Map(
  NOTE_COLOR_MARK_OPTIONS
    .filter((item): item is typeof NOTE_COLOR_MARK_OPTIONS[number] & { value: NoteColorMark } => item.value !== null)
    .map((item) => [item.value, item.hex]),
);

export function getNoteColorMarkHex(value: NoteColorMark | null | undefined): string | null {
  if (!value) return null;
  return COLOR_BY_ID.get(value) || null;
}

export function isNoteColorMark(value: unknown): value is NoteColorMark {
  return typeof value === "string" && COLOR_BY_ID.has(value as NoteColorMark);
}
