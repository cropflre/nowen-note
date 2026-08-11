import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import {
  clearPreferredNoteSplitLevelCache,
  getCachedPreferredNoteSplitLevel,
  resolvePreferredNoteSplitLevel,
  schedulePreferredNoteSplitLevel,
} from "@/lib/noteSplitAnalysis";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-split-analysis",
    userId: "user-1",
    notebookId: "notebook-1",
    workspaceId: null,
    title: "Split analysis",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "B" }] },
      ],
    }),
    contentText: "A\nBody\nB",
    contentFormat: "tiptap-json",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: 1,
    sortOrder: 0,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  clearPreferredNoteSplitLevelCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("note split analysis scheduling", () => {
  it("keeps heading discovery off the synchronous note-open path", () => {
    const note = makeNote();
    const resolved = vi.fn();

    schedulePreferredNoteSplitLevel(note, resolved);

    expect(resolved).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(resolved).toHaveBeenCalledWith(2);
  });

  it("cancels stale analysis when the user switches again", () => {
    const resolved = vi.fn();
    const cancel = schedulePreferredNoteSplitLevel(makeNote(), resolved);

    cancel();
    vi.runAllTimers();

    expect(resolved).not.toHaveBeenCalled();
  });

  it("reuses the split result for the same note version and invalidates changed content", () => {
    const note = makeNote();

    expect(getCachedPreferredNoteSplitLevel(note).hit).toBe(false);
    expect(resolvePreferredNoteSplitLevel(note)).toBe(2);
    expect(getCachedPreferredNoteSplitLevel({ ...note })).toEqual({ hit: true, level: 2 });

    const changed = {
      ...note,
      version: 2,
      updatedAt: "2026-07-31T00:01:00.000Z",
      content: JSON.stringify({ type: "doc", content: [] }),
    };
    expect(getCachedPreferredNoteSplitLevel(changed).hit).toBe(false);
    expect(resolvePreferredNoteSplitLevel(changed)).toBeNull();
  });
});
