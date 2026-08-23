// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  activateUntitledTitlePlaceholder,
  clearUntitledTitlePlaceholder,
  isUntitledNoteTitle,
  restoreUntitledTitleForBlur,
} from "@/components/UntitledNoteTitleBridge";

describe("UntitledNoteTitleBridge", () => {
  it("recognizes localized and legacy default titles without classifying arbitrary titles", () => {
    expect(isUntitledNoteTitle("无标题笔记", "无标题笔记", "tiptap-json")).toBe(true);
    expect(isUntitledNoteTitle("Untitled Note", "Untitled Note", "tiptap-json")).toBe(true);
    expect(isUntitledNoteTitle("无标题 Markdown", "无标题笔记", "markdown")).toBe(true);
    expect(isUntitledNoteTitle("无标题 Markdown", "无标题笔记", "tiptap-json")).toBe(false);
    expect(isUntitledNoteTitle("项目周报", "无标题笔记", "tiptap-json")).toBe(false);
  });

  it("turns the persisted default title into a real empty-value placeholder", () => {
    const field = document.createElement("textarea");
    field.value = "无标题笔记";
    field.placeholder = "请输入标题";

    expect(activateUntitledTitlePlaceholder(field, "无标题笔记")).toBe(true);
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("无标题笔记");
    expect(field.dataset.nowenUntitledTitlePlaceholder).toBe("true");
  });

  it("does not overwrite a title the user has started typing", () => {
    const field = document.createElement("textarea");
    field.value = "我的新标题";
    field.placeholder = "请输入标题";

    expect(activateUntitledTitlePlaceholder(field, "无标题笔记")).toBe(false);
    expect(field.value).toBe("我的新标题");
    expect(field.placeholder).toBe("无标题笔记");
  });

  it("temporarily restores the persisted title for blur guards, then can return to placeholder", () => {
    const field = document.createElement("textarea");
    field.value = "无标题笔记";
    field.placeholder = "请输入标题";
    activateUntitledTitlePlaceholder(field, "无标题笔记");

    expect(restoreUntitledTitleForBlur(field, "无标题笔记")).toBe(true);
    expect(field.value).toBe("无标题笔记");

    expect(activateUntitledTitlePlaceholder(field, "无标题笔记")).toBe(true);
    expect(field.value).toBe("");
  });

  it("restores the editor's original placeholder after a real title is saved", () => {
    const field = document.createElement("textarea");
    field.value = "无标题笔记";
    field.placeholder = "请输入标题";
    activateUntitledTitlePlaceholder(field, "无标题笔记");

    field.value = "正式标题";
    clearUntitledTitlePlaceholder(field);

    expect(field.value).toBe("正式标题");
    expect(field.placeholder).toBe("请输入标题");
    expect(field.dataset.nowenUntitledTitlePlaceholder).toBeUndefined();
  });
});
