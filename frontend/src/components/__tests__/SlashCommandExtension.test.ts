// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  createSlashExtension,
  deactivateSlashCommands,
  getSlashPluginState,
} from "@/components/extensions/SlashCommandExtension";

function dispatchTextInput(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  return editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, text)) === true;
}

function createEditor() {
  const onActivate = vi.fn();
  const onDeactivate = vi.fn();
  const onQueryChange = vi.fn();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, createSlashExtension(onActivate, onDeactivate, onQueryChange)],
    content: "<p></p>",
  });
  return { editor, onActivate, onDeactivate, onQueryChange };
}

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

describe("SlashCommandExtension", () => {
  it("opens and fully resets for 20 consecutive command sessions without keydown timers", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);

    for (let index = 0; index < 20; index += 1) {
      expect(dispatchTextInput(ctx.editor, "/")).toBe(true);
      expect(getSlashPluginState(ctx.editor)).toMatchObject({ active: true, query: "" });

      const slashFrom = getSlashPluginState(ctx.editor).from;
      const cursor = ctx.editor.state.selection.from;
      deactivateSlashCommands(ctx.editor);
      ctx.editor.chain().deleteRange({ from: slashFrom, to: cursor }).run();

      expect(getSlashPluginState(ctx.editor).active).toBe(false);
      expect(ctx.editor.getText()).toBe("");
    }

    expect(ctx.onActivate).toHaveBeenCalledTimes(20);
    expect(ctx.onDeactivate).toHaveBeenCalledTimes(20);
  });

  it("tracks the query and closes when whitespace ends the command", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);

    expect(dispatchTextInput(ctx.editor, "/")).toBe(true);
    ctx.editor.commands.insertContent("hea");
    expect(getSlashPluginState(ctx.editor)).toMatchObject({ active: true, query: "hea" });
    const queryCalls = ctx.onQueryChange.mock.calls;
    expect(queryCalls[queryCalls.length - 1]?.[0]).toBe("hea");

    ctx.editor.commands.insertContent(" ");
    expect(getSlashPluginState(ctx.editor).active).toBe(false);
    expect(ctx.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("activates from an input transaction fallback used by composition-based browsers", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);

    // Programmatic insertion bypasses handleTextInput and exercises the same
    // transaction fallback used when Opera/IME commits DOM text directly.
    ctx.editor.commands.insertContent("/");

    expect(getSlashPluginState(ctx.editor)).toMatchObject({ active: true, query: "" });
    expect(ctx.onActivate).toHaveBeenCalledTimes(1);
  });

  it("does not reactivate from an old slash exposed by deleting later text", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);

    ctx.editor.commands.setContent("<p>/old</p>");
    ctx.editor.commands.setTextSelection(5);
    ctx.editor.chain().deleteRange({ from: 2, to: 5 }).run();

    expect(ctx.editor.getText()).toBe("/");
    expect(getSlashPluginState(ctx.editor).active).toBe(false);
    expect(ctx.onActivate).not.toHaveBeenCalled();
  });
});
