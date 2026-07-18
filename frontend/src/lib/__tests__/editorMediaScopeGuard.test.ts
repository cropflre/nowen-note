import { describe, expect, it } from "vitest";
import { shouldShieldNonEditorMediaButton } from "@/lib/editorMediaScopeGuard";

describe("editor media scope guard", () => {
  it("shields Diary image buttons from the note-editor media bridge", () => {
    expect(shouldShieldNonEditorMediaButton({
      kind: "image",
      label: "添加图片",
      insideMediaSheet: false,
      insideEditorContext: false,
      insideMarkdownEditorShell: false,
    })).toBe(true);
  });

  it("keeps Tiptap and Markdown editor media buttons managed by the bridge", () => {
    expect(shouldShieldNonEditorMediaButton({
      kind: "image",
      label: "插入图片",
      insideMediaSheet: false,
      insideEditorContext: true,
      insideMarkdownEditorShell: false,
    })).toBe(false);
    expect(shouldShieldNonEditorMediaButton({
      kind: "video",
      label: "插入视频",
      insideMediaSheet: false,
      insideEditorContext: false,
      insideMarkdownEditorShell: true,
    })).toBe(false);
  });

  it("does not interfere with controls inside the media sheet or unrelated icons", () => {
    expect(shouldShieldNonEditorMediaButton({
      kind: "image",
      label: "选择图片",
      insideMediaSheet: true,
      insideEditorContext: false,
      insideMarkdownEditorShell: false,
    })).toBe(false);
    expect(shouldShieldNonEditorMediaButton({
      kind: null,
      label: "上传头像",
      insideMediaSheet: false,
      insideEditorContext: false,
      insideMarkdownEditorShell: false,
    })).toBe(false);
  });
});
