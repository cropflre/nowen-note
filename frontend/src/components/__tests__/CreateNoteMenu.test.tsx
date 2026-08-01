// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

import CreateNoteMenu, { type NoteType } from "@/components/CreateNoteMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("CreateNoteMenu", () => {
  let container: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    document.body.innerHTML = "";
    anchor = document.createElement("button");
    anchor.getBoundingClientRect = () => ({
      x: 300,
      y: 30,
      top: 30,
      right: 340,
      bottom: 62,
      left: 300,
      width: 40,
      height: 32,
      toJSON: () => ({}),
    });
    document.body.appendChild(anchor);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("exposes both create actions and all three import actions", () => {
    const picked: NoteType[] = [];
    act(() => {
      root.render(
        <CreateNoteMenu
          anchorRef={{ current: anchor }}
          onClose={() => undefined}
          onPick={(type) => { picked.push(type); }}
        />,
      );
    });

    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-note-menu-action]"))
      .map((element) => element.dataset.noteMenuAction)).toEqual([
        "normal",
        "markdown",
        "markdown-file",
        "word",
        "wechat",
      ]);
    expect(document.body.textContent).toContain("导入 Markdown 文件");
    expect(document.body.textContent).toContain("导入公众号文章");

    const markdownImport = document.querySelector<HTMLButtonElement>('[data-note-menu-action="markdown-file"]');
    const wechatImport = document.querySelector<HTMLButtonElement>('[data-note-menu-action="wechat"]');
    act(() => markdownImport?.click());
    act(() => wechatImport?.click());
    expect(picked).toEqual(["markdown-file", "wechat"]);
  });
});
