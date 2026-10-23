// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import {
  createSlashExtension,
  deactivateSlashCommands,
  getSlashPluginState,
} from "@/components/extensions/SlashCommandExtension";

function dispatchTextInput(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  return editor.view.someProp("handleTextInput", (handler) => handler(
    editor.view,
    from,
    to,
    text,
    () => editor.state.tr.insertText(text, from, to).scrollIntoView(),
  )) === true;
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
  it("keeps an active menu when a desktop control reconfigures unrelated plugins", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);
    dispatchTextInput(ctx.editor, "/");
    const key = new PluginKey("desktop-control");
    ctx.editor.registerPlugin(new Plugin({ key }));
    ctx.editor.unregisterPlugin(key);

    expect(getSlashPluginState(ctx.editor)).toMatchObject({ active: true, query: "" });
    expect(ctx.onDeactivate).not.toHaveBeenCalled();
    ctx.editor.commands.insertContent("h1");
    expect(ctx.onQueryChange.mock.calls.at(-1)?.[0]).toBe("h1");
  });

  it("closes an active menu when the editor is destroyed", () => {
    const ctx = createEditor();
    dispatchTextInput(ctx.editor, "/");
    ctx.editor.destroy();
    expect(ctx.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("closes an active menu when the editor is unmounted", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);
    dispatchTextInput(ctx.editor, "/");
    ctx.editor.unmount();
    expect(ctx.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("closes an active menu when its own plugin is removed", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);
    dispatchTextInput(ctx.editor, "/");
    ctx.editor.unregisterPlugin("slashCommands");
    expect(ctx.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("keeps the DOM input selection when desktop text arrives before selectionchange", () => {
    const ctx = createEditor();
    editors.push(ctx.editor);
    ctx.editor.commands.setContent("<p>Existing text</p><p></p>");
    ctx.editor.commands.setTextSelection(1);
    const from = ctx.editor.state.doc.content.size - 1;
    const defaultTransaction = vi.fn(() => {
      const tr = ctx.editor.state.tr.insertText("/", from, from);
      return tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView();
    });
    // Chromium's DOM mutation provides the actual input range and selection,
    // even when EditorState still contains the selection from the last click.
    ctx.editor.view.someProp("handleTextInput", handler => handler(
      ctx.editor.view, from, from, "/", defaultTransaction,
    ));

    expect(ctx.editor.state.selection.from).toBe(from + 1);
    ctx.editor.commands.insertContent("h1");
    expect(ctx.editor.getText()).toBe("Existing text\n\n/h1");
    expect(getSlashPluginState(ctx.editor)).toMatchObject({ active: true, from, query: "h1" });
  });

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
