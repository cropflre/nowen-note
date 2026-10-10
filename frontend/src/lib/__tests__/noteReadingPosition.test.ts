import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTE_READING_POSITIONS_KEY,
  NOTE_READING_POSITIONS_LIMIT,
  noteReadingPositionKey,
  readNoteReadingPosition,
  resolveNoteReadingScrollTop,
  saveNoteReadingPosition,
} from "../noteReadingPosition";

beforeEach(() => localStorage.clear());

describe("Issue #817: note reading position", () => {
  it("keeps different notes, accounts, servers and editor modes independent", () => {
    const first = noteReadingPositionKey("https://one.example", "alice", "note-1", "richtext");
    const second = noteReadingPositionKey("https://one.example", "alice", "note-2", "richtext");
    const otherUser = noteReadingPositionKey("https://one.example", "bob", "note-1", "richtext");
    const otherServer = noteReadingPositionKey("https://two.example", "alice", "note-1", "richtext");
    const markdown = noteReadingPositionKey("https://one.example", "alice", "note-1", "markdown");
    saveNoteReadingPosition(first, 800, 4000, 500, 100);
    expect(readNoteReadingPosition(first)?.top).toBe(800);
    for (const key of [second, otherUser, otherServer, markdown]) {
      expect(readNoteReadingPosition(key)).toBeNull();
    }
  });

  it("restores the same absolute position and clamps when a note becomes shorter", () => {
    const key = noteReadingPositionKey("local", "owner", "note", "markdown");
    saveNoteReadingPosition(key, 1200, 3000, 500);
    const state = readNoteReadingPosition(key)!;
    expect(resolveNoteReadingScrollTop(state, 3000, 500)).toBe(1200);
    expect(resolveNoteReadingScrollTop(state, 900, 500)).toBe(400);
  });

  it("persists an explicit return to the beginning rather than reviving stale progress", () => {
    const key = noteReadingPositionKey("local", "owner", "note", "richtext");
    saveNoteReadingPosition(key, 900, 2000, 400, 1);
    saveNoteReadingPosition(key, 0, 2000, 400, 2);
    expect(readNoteReadingPosition(key)?.top).toBe(0);
  });

  it("bounds local storage and ignores malformed stored data", () => {
    for (let i = 0; i < NOTE_READING_POSITIONS_LIMIT + 15; i++) {
      saveNoteReadingPosition(`note-${i}`, i, 3000, 100, i + 1);
    }
    expect(Object.keys(JSON.parse(localStorage.getItem(NOTE_READING_POSITIONS_KEY)!))).toHaveLength(NOTE_READING_POSITIONS_LIMIT);
    expect(readNoteReadingPosition("note-0")).toBeNull();
    expect(readNoteReadingPosition(`note-${NOTE_READING_POSITIONS_LIMIT + 14}`)).not.toBeNull();
    localStorage.setItem(NOTE_READING_POSITIONS_KEY, "{bad");
    expect(readNoteReadingPosition("note-1")).toBeNull();
  });
});
