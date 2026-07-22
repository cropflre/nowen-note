import { describe, expect, it } from "vitest";
import { EditorRevisionGuard } from "@/lib/editorRevisionGuard";

describe("EditorRevisionGuard", () => {
  it("rejects stale document revisions", () => {
    const editor = {};
    const guard = new EditorRevisionGuard();
    const first = guard.next("note-a", editor);
    const second = guard.next("note-a", editor);

    expect(guard.isCurrent(first, "note-a", editor)).toBe(false);
    expect(guard.isCurrent(second, "note-a", editor)).toBe(true);
  });

  it("rejects tasks from another note or editor generation", () => {
    const editorA = {};
    const editorB = {};
    const guard = new EditorRevisionGuard();
    const noteA = guard.next("note-a", editorA);

    guard.reset("note-b", editorA);
    expect(guard.isCurrent(noteA, "note-b", editorA)).toBe(false);

    const noteB = guard.next("note-b", editorA);
    guard.reset("note-b", editorB);
    expect(guard.isCurrent(noteB, "note-b", editorB)).toBe(false);
  });

  it("invalidates pending work during unmount or explicit discard", () => {
    const editor = {};
    const guard = new EditorRevisionGuard();
    const token = guard.next("note-a", editor);
    guard.invalidate();
    expect(guard.isCurrent(token, "note-a", editor)).toBe(false);
  });
});
