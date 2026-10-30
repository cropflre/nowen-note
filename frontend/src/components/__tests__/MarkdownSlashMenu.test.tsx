import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState, Compartment, EditorSelection, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlashPlugin, emptySlashState, getDefaultMdSlashItems, MarkdownSlashMenu, type SlashState } from "../MarkdownSlashMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Markdown slash commands (Issue #853)", () => {
  let view: EditorView, host: HTMLDivElement, root: Root, state: SlashState;
  const editable = new Compartment();
  const items = getDefaultMdSlashItems(key => key, {});
  const coords = { top: 740, bottom: 760, left: 1010, right: 1010 };
  function render() {
    root.render(<MarkdownSlashMenu state={state} items={items} view={view} onClose={() => {
      state = emptySlashState; render();
    }} />);
  }
  async function settle() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  }
  async function setText(text: string, position = text.length) {
    await act(async () => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: position },
    }));
    await settle();
  }
  async function key(key: string, isComposing = false) {
    await act(async () => view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing, bubbles: true, cancelable: true })));
    await settle();
  }
  const menu = () => document.querySelector<HTMLElement>('[role="listbox"]');
  beforeEach(async () => {
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockImplementation(() => coords);
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    Element.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div"); document.body.appendChild(host);
    root = createRoot(document.createElement("div"));
    state = emptySlashState;
    view = new EditorView({ parent: host, state: EditorState.create({ extensions: [
      markdown(), history(), keymap.of(defaultKeymap), editable.of(EditorView.editable.of(true)),
      createSlashPlugin(value => { state = value; if (view) render(); }),
    ] }) });
    await act(async () => { view.focus(); render(); });
    await settle();
  });
  afterEach(async () => {
    await act(async () => { view.destroy(); root.unmount(); }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it.each([
    ["/H1", "# "], ["/code", "```\n\n```\n"], ["/tab", "| 列1 | 列2 | 列3 |"],
    ["/todo", "- [ ] "], ["/引用", "> "],
  ])("filters and executes %s through Enter", async (query, expected) => {
    await setText(query);
    expect(state.active).toBe(true);
    await key("Enter");
    expect(view.state.doc.toString()).toContain(expected);
    expect(view.state.doc.toString()).not.toContain(query);
  });
  it.each([["/H1", "# "], ["/todo", "- [ ] "], ["/quote", "> "]])("keeps typing after the inserted prefix for %s", async (query, prefix) => {
    await setText(query); await key("Enter");
    await act(async () => view.dispatch(view.state.replaceSelection("continued text")));
    expect(view.state.doc.toString()).toBe(`${prefix}continued text`);
  });
  it("opens a discoverable menu at / and supports arrows, Tab and pointer selection", async () => {
    await setText("/");
    expect(menu()).not.toBeNull();
    await key("ArrowDown"); await key("Tab");
    expect(view.state.doc.toString()).toBe("## ");
    await setText("/code");
    await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(view.state.doc.toString()).toBe("```\n\n```\n");
  });
  it.each(["```sh\n/code\n```", "~~~\n/code\n~~~", "    /code", "`text /code`", "https://example.com/code", "folder/code"])("does not offer commands within code/URLs/paths: %s", async text => {
    await setText(text, text.indexOf("/code") + 5);
    expect(state.active).toBe(false);
  });
  it("keeps existing text after inserting a block command mid-line", async () => {
    await setText("before /code after", 12);
    await key("Enter");
    expect(view.state.doc.toString()).toContain("before ");
    expect(view.state.doc.toString()).toContain(" after");
    expect(view.state.doc.toString()).not.toContain("/code");
  });
  it("Escape and outside pointer dismiss without deleting the query", async () => {
    await setText("/H1"); await key("Escape");
    expect(view.state.doc.toString()).toBe("/H1"); expect(menu()).toBeNull();
    host.dispatchEvent(new Event("scroll")); await settle();
    expect(menu()).toBeNull();
    await setText("/H2");
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull(); expect(view.state.doc.toString()).toBe("/H2");
  });
  it("does not consume an IME confirmation or run unmatched commands", async () => {
    await setText("/H1"); await key("Enter", true);
    expect(view.state.doc.toString()).toBe("/H1");
    await setText("/nonexistent"); await key("Enter");
    expect(view.state.doc.toString()).toBe("/nonexistent\n");
  });
  it("closes on read-only reconfiguration and cannot execute stale items", async () => {
    await setText("/H1");
    const staleItem = document.querySelector<HTMLElement>('[role="option"]');
    await act(async () => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(false)) }));
    await settle();
    await act(async () => staleItem?.click());
    expect(view.state.doc.toString()).toBe("/H1"); expect(menu()).toBeNull();
  });
  it("does not activate for multiple carets", async () => {
    await setText("/H1\n/H2");
    await act(async () => view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) }));
    await act(async () => view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7)]) }));
    await settle(); expect(state.active).toBe(false);
  });
  it("keeps the floating menu inside the viewport at the right/bottom edge", async () => {
    await setText("/");
    const el = menu()!;
    expect(parseFloat(el.style.left) + parseFloat(el.style.width)).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseFloat(el.style.top)).toBeLessThan(coords.top);
  });
  it("fits the visible area when a software keyboard reduces the viewport", async () => {
    const viewport = new EventTarget();
    Object.assign(viewport, { offsetLeft: 0, offsetTop: 0, width: 320, height: 300 });
    vi.stubGlobal("visualViewport", viewport);
    await setText("/");
    const el = menu()!;
    expect(parseFloat(el.style.top) + parseFloat(el.style.maxHeight)).toBeLessThanOrEqual(292);
    expect(parseFloat(el.style.left) + parseFloat(el.style.width)).toBeLessThanOrEqual(312);
    vi.unstubAllGlobals();
  });
  it("reads real cursor geometry outside CodeMirror updates", async () => {
    vi.mocked(EditorView.prototype.coordsAtPos).mockRestore();
    const geometry = vi.spyOn(EditorView.prototype, "coordsAtPos");
    const errors = vi.spyOn(console, "error");
    await setText("/H1");
    expect(state.active).toBe(true);
    expect(geometry).toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("Reading the editor layout");
  });
  it("closes when the editor loses focus", async () => {
    await setText("/H1");
    await act(async () => view.contentDOM.blur()); await settle();
    expect(menu()).toBeNull();
  });
  it.each(["/H1", "/code", "/tab"])("undo restores %s in a single step", async query => {
    await setText(query); await key("Enter");
    await act(async () => { undo(view); });
    expect(view.state.doc.toString()).toBe(query);
  });
});
