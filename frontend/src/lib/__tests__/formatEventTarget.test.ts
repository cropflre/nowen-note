// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { shouldHandleFormatEvent } from "@/lib/formatEventTarget";

afterEach(() => { document.body.innerHTML = ""; });

function mount(html: string) {
  document.body.innerHTML = html;
  return {
    rich: document.querySelector<HTMLElement>("#rich .ProseMirror")!,
    markdown: document.querySelector<HTMLElement>("#markdown .cm-editor")!,
    title: document.querySelector<HTMLElement>("#title")!,
  };
}

const split = `
  <input id="title" />
  <div id="rich"><div class="ProseMirror" contenteditable="true" tabindex="0"><p>left</p></div></div>
  <div id="markdown"><div class="cm-editor"><div class="cm-content" contenteditable="true" tabindex="0">right</div></div></div>`;

describe("format events in split view", () => {
  it("lets only the focused editor apply a shortcut", () => {
    const { rich, markdown } = mount(split);
    rich.focus();
    expect(shouldHandleFormatEvent(rich)).toBe(true);
    expect(shouldHandleFormatEvent(markdown)).toBe(false);

    markdown.querySelector<HTMLElement>(".cm-content")!.focus();
    expect(shouldHandleFormatEvent(markdown)).toBe(true);
    expect(shouldHandleFormatEvent(rich)).toBe(false);
  });

  it("keeps the previous behaviour when no editor has focus, e.g. a native menu", () => {
    const { rich, markdown, title } = mount(split);
    expect(shouldHandleFormatEvent(rich)).toBe(true);
    title.focus();
    expect(shouldHandleFormatEvent(rich)).toBe(true);
    expect(shouldHandleFormatEvent(markdown)).toBe(true);
  });
});
