import { describe, expect, it } from "vitest";
import {
  captureEditorCleanBaseline,
  hasUnsavedEditorChanges,
  isFetchedRemoteNoteNewer,
} from "../editorSyncGuards";

// The persisted body is Markdown written by another device; the rich-text editor
// re-serializes the same document as Tiptap JSON with its own plain text.
const persisted = { id: "n1", version: 15, title: "双向同步测试 1106", content: "# 标题\n\n正文 v15", contentText: "标题 正文 v15" };
const rendered = { content: '{"type":"doc","content":[{"type":"heading"}]}', contentText: "标题\n\n正文 v15", title: "双向同步测试 1106" };

describe("active note dirty detection", () => {
  it("does not treat an untouched editor's own serialization as an unsaved edit", () => {
    const baseline = captureEditorCleanBaseline(persisted, rendered, "rte");
    expect(hasUnsavedEditorChanges({ note: persisted, snapshot: rendered, baseline, editorMode: "rte" })).toBe(false);
  });

  it("reports user edits made after the clean rendering", () => {
    const baseline = captureEditorCleanBaseline(persisted, rendered, "rte");
    expect(hasUnsavedEditorChanges({
      note: persisted, snapshot: { ...rendered, content: rendered.content + " typed" }, baseline, editorMode: "rte",
    })).toBe(true);
    expect(hasUnsavedEditorChanges({
      note: persisted, snapshot: { ...rendered, title: "新标题" }, baseline, editorMode: "rte",
    })).toBe(true);
  });

  it("stays conservative when no matching clean rendering exists", () => {
    expect(hasUnsavedEditorChanges({ note: persisted, snapshot: rendered, baseline: null, editorMode: "rte" })).toBe(true);
    const baseline = captureEditorCleanBaseline(persisted, rendered, "rte");
    // Baselines never transfer to another body, note or editor engine.
    expect(hasUnsavedEditorChanges({ note: { ...persisted, content: "other" }, snapshot: rendered, baseline, editorMode: "rte" })).toBe(true);
    expect(hasUnsavedEditorChanges({ note: { ...persisted, id: "n2" }, snapshot: rendered, baseline, editorMode: "rte" })).toBe(true);
    expect(hasUnsavedEditorChanges({ note: persisted, snapshot: rendered, baseline, editorMode: "md" })).toBe(true);
  });

  it("ignores derived plain-text differences when the body itself is identical", () => {
    expect(hasUnsavedEditorChanges({
      note: persisted, snapshot: { content: persisted.content, contentText: "differently derived", title: persisted.title },
      baseline: null, editorMode: "md",
    })).toBe(false);
  });

  it("is clean when the editor is not mounted", () => {
    expect(hasUnsavedEditorChanges({ note: persisted, snapshot: null, baseline: null, editorMode: "md" })).toBe(false);
  });
});

describe("fetched remote note freshness", () => {
  const local = { id: "n1", version: 20, updatedAt: "2026-11-06 09:27:58", title: "t", content: "a", tags: [{ id: "x" }] };

  it("accepts higher versions and rejects older or foreign notes", () => {
    expect(isFetchedRemoteNoteNewer(local, { ...local, version: 21 })).toBe(true);
    expect(isFetchedRemoteNoteNewer(local, { ...local, version: 19, content: "old" })).toBe(false);
    expect(isFetchedRemoteNoteNewer(local, { ...local, id: "n2", version: 21 })).toBe(false);
    expect(isFetchedRemoteNoteNewer(null, local)).toBe(false);
  });

  it("detects same-version body, title and tag changes such as live Yjs persistence", () => {
    expect(isFetchedRemoteNoteNewer(local, { ...local })).toBe(false);
    expect(isFetchedRemoteNoteNewer(local, { ...local, updatedAt: "2026-11-06T01:27:58.000Z" })).toBe(false);
    expect(isFetchedRemoteNoteNewer(local, { ...local, content: "b", updatedAt: "2026-11-06 09:28:30" })).toBe(true);
    expect(isFetchedRemoteNoteNewer(local, { ...local, title: "t2" })).toBe(true);
    expect(isFetchedRemoteNoteNewer(local, { ...local, tags: [{ id: "x" }, { id: "y" }] })).toBe(true);
    expect(isFetchedRemoteNoteNewer(local, { ...local, tags: [{ id: "x" }] })).toBe(false);
  });
});
