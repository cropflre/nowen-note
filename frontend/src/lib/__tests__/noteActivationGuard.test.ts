import { describe, expect, it } from "vitest";

import { NoteActivationGuard } from "@/lib/noteActivationGuard";

describe("NoteActivationGuard", () => {
  it("keeps the previous source retired after the target commits until the next navigation", () => {
    const guard = new NoteActivationGuard();
    guard.begin({ requestId: 1, noteId: "note-b" }, "note-a");

    // A stays authoritative while B is still loading, so normal save/version acknowledgements
    // must not be lost if B eventually fails.
    expect(guard.allowActiveNote("note-a")).toBe(true);

    expect(guard.allowActiveNote("note-b")).toBe(true);

    // Coordinator completion and React commit are both too early to assume the old RTE editor has
    // drained every async save/reconcile callback.
    guard.finish(1);
    expect(guard.allowActiveNote("note-a")).toBe(false);

    guard.commit("note-b");
    expect(guard.allowActiveNote("note-a")).toBe(false);
    expect(guard.allowActiveNote("note-c")).toBe(true);

    // An intentional navigation back to A creates a new load intent and makes A authoritative again.
    guard.begin({ requestId: 2, noteId: "note-a" }, "note-b");
    expect(guard.allowActiveNote("note-a")).toBe(true);
  });

  it("blocks unrelated note activations while the requested target is loading", () => {
    const guard = new NoteActivationGuard();
    guard.begin({ requestId: 3, noteId: "note-b" }, "note-a");

    expect(guard.allowActiveNote("note-c")).toBe(false);
  });

  it("releases the guard when a load is cancelled before the target is activated", () => {
    const guard = new NoteActivationGuard();
    guard.begin({ requestId: 4, noteId: "note-b" }, "note-a");

    guard.finish(4);

    expect(guard.allowActiveNote("note-a")).toBe(true);
    expect(guard.allowActiveNote("note-c")).toBe(true);
  });

  it("releases the guard when a load fails", () => {
    const guard = new NoteActivationGuard();
    guard.begin({ requestId: 5, noteId: "note-b" }, "note-a");

    guard.fail(5);

    expect(guard.allowActiveNote("note-a")).toBe(true);
    expect(guard.allowActiveNote("note-c")).toBe(true);
  });

  it("keeps the newest load intent authoritative", () => {
    const guard = new NoteActivationGuard();
    guard.begin({ requestId: 6, noteId: "note-b" }, "note-a");
    guard.begin({ requestId: 7, noteId: "note-c" }, "note-a");

    expect(guard.allowActiveNote("note-b")).toBe(false);
    expect(guard.allowActiveNote("note-c")).toBe(true);
  });
});
