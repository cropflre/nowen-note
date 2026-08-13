import { describe, expect, it } from "vitest";
import { resolveEditorLifecycleSave } from "@/lib/editorLifecycleSafety";

describe("editor lifecycle save safety", () => {
  it("Case 2: flushes pending image/content immediately when the user switches notes", () => {
    // Image insertion is a document transaction, so Tiptap has a pending content debounce here.
    // The before-note-switch lifecycle path must force the latest editor JSON out immediately.
    expect(resolveEditorLifecycleSave({
      hasPendingContent: true,
      title: "Title",
      noteTitle: "Title",
      lastEmittedTitle: "Title",
      isTitleComposing: false,
    })).toBe("content");
  });

  it("flushes a title-only edit when no body debounce exists", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: false,
      title: "New title",
      noteTitle: "Old title",
      lastEmittedTitle: "Old title",
      isTitleComposing: false,
    })).toBe("title");
  });

  it("does not emit an unchanged title during lifecycle events", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: false,
      title: "Title",
      noteTitle: "Title",
      lastEmittedTitle: "Title",
      isTitleComposing: false,
    })).toBe("none");
  });

  it("does not send an unfinished IME title without pending body content", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: false,
      title: "未完成输",
      noteTitle: "旧标题",
      lastEmittedTitle: "旧标题",
      isTitleComposing: true,
    })).toBe("none");
  });
});
