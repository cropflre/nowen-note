// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlashEventHandlers, createSlashExtension, getDefaultSlashCommands, SlashCommandsMenu } from "@/components/SlashCommands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("grouped slash menu command selection", () => {
  let editor: Editor, root: Root, host: HTMLDivElement;
  const opened = vi.fn();
  const scrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const handlers = createSlashEventHandlers();
    editor = new Editor({ extensions: [StarterKit, createSlashExtension(handlers.onActivate, handlers.onDeactivate, handlers.onQueryChange)], content: "<p></p>" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const items = getDefaultSlashCommands(key => key === "slash.catInsert" ? "插入" : key, undefined, undefined, undefined, vi.fn());
    await act(async () => root.render(<SlashCommandsMenu editor={editor} items={items} />));
    opened.mockClear();
    window.addEventListener("nowen:open-mindmap-insert", opened);
    await act(async () => editor.commands.insertContent("/"));
  });

  afterEach(async () => {
    window.removeEventListener("nowen:open-mindmap-insert", opened);
    await act(async () => { root.unmount(); editor.destroy(); });
    host.remove();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.restoreAllMocks();
  });

  const key = async (value: string) => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
  const mindmap = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("选择已有脑图"))!;

  it("opens the highlighted mind map after ArrowDown and Enter instead of inserting the timestamp", async () => {
    expect(host.querySelectorAll("button")[1]).toBe(mindmap());
    await key("ArrowDown");
    await key("Enter");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("");
  });

  it("executes the hovered mind map through Enter", async () => {
    await act(async () => mindmap().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await key("Enter");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("");
  });

  it("keeps mouse clicks and filtered keyboard selection on the same mind map command", async () => {
    await act(async () => mindmap().click());
    expect(opened).toHaveBeenCalledTimes(1);
    await act(async () => {
      editor.commands.insertContent("/");
      editor.commands.insertContent("思维导图");
    });
    await key("Enter");
    expect(opened).toHaveBeenCalledTimes(2);
    expect(editor.getText()).toBe("");
  });
});

describe("mind map foolproof insertion command", () => {
  it("exposes a searchable /思维导图 command and opens the picker without requiring an ID", () => {
    const commands = getDefaultSlashCommands((key) => key);
    const item = commands.find((command) => command.id === "mindmap");

    expect(item).toBeTruthy();
    expect(item?.label).toBe("思维导图");
    expect(item?.keywords).toEqual(expect.arrayContaining(["脑图", "思维导图", "mindmap"]));

    const handler = vi.fn();
    window.addEventListener("nowen:open-mindmap-insert", handler, { once: true });

    item?.action({} as unknown as Editor);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps the Mermaid code template under a distinct command", () => {
    const commands = getDefaultSlashCommands((key) => key === "slash.mermaidMindMap" ? "Mermaid 脑图（代码块）" : key);
    const item = commands.find((command) => command.id === "mermaidMindMap");
    const editor = new Editor({ extensions: [StarterKit], content: "<p>正文</p>" });
    try {
      expect(item?.label).toBe("Mermaid 脑图（代码块）");
      item?.action(editor);
      const document = editor.getJSON() as { content?: Array<{ type?: string; attrs?: { language?: string }; content?: Array<{ text?: string }> }> };
      expect(document.content?.some((node) =>
        node.type === "codeBlock" && node.attrs?.language === "mermaid" && node.content?.[0]?.text?.startsWith("mindmap"),
      )).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
