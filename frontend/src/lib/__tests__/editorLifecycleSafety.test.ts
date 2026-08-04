import { describe, expect, it } from "vitest";
import { resolveEditorLifecycleSave } from "@/lib/editorLifecycleSafety";

describe("editor lifecycle save safety", () => {
  it("flushes pending content even when the title is unchanged", () => {
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
