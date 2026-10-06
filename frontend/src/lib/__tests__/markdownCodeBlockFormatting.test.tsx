// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { history, undo } from "@codemirror/commands";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { markdownLivePreviewExtension } from "@/lib/markdownLivePreview";
import { resolveMarkdownCodeBlockLanguage } from "@/lib/markdownCodeBlockLanguage";
import {
  formatMarkdownCodeBlock, markdownCodeBlockFormattingExtension, resolveMarkdownCodeBlockSource,
} from "@/lib/markdownCodeBlockFormatting";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const views: EditorView[] = [];
beforeAll(() => {
  (globalThis as any).ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(async () => {
  await act(async () => { views.splice(0).forEach((view) => view.destroy()); });
  document.body.innerHTML = "";
});

function editor(doc: string, extensions: any[] = [], anchor = 0) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor }, extensions: [history(), markdown(), ...extensions] }) });
  views.push(view);
  return view;
}

describe("Markdown formatting writes through to source", () => {
  it.each([
    ["auto", '<html lang="zh-CN"><body>hello</body></html>', "html"],
    ["js", '\n<!doctype HTML PUBLIC "test"><html></html>', "html"],
    ["js", "const x = '<!DOCTYPE html>';", "js"],
    ["javascript", "<html><body>JSX</body></html>", "javascript"],
    ["jsx", "<html><body>JSX</body></html>", "jsx"],
    ["json", "<!DOCTYPE html><html></html>", "json"],
    ["markdown", "<!DOCTYPE html><html></html>", "markdown"],
    ["python", "<!DOCTYPE html><html></html>", "python"],
    ["text", "<div>fragment</div>", "text"],
    ["", "const x=1", ""],
  ])("resolves %s content conservatively", (language, code, expected) => {
    expect(resolveMarkdownCodeBlockLanguage(code, language)).toBe(expected);
  });

  it.each(["javascript", "js", "", "text", "auto"])("formats an HTML document in a %s fence and restores it with undo", async (language) => {
    const code = '<!DOCTYPE html>\n<html lang="zh-CN"><head><style>body{color:red}</style></head><body><script>const x={a:1};</script></body></html>';
    const source = `before\n\n\`\`\`${language}\n${code}\n\`\`\`\n\nafter`;
    const view = editor(source);
    await formatMarkdownCodeBlock(view, source, source.indexOf("```"));
    const result = view.state.doc.toString();
    expect(result).toContain(`before\n\n\`\`\`${language}\n<!DOCTYPE html>\n<html lang="zh-CN">\n  <head>`);
    expect(result).toContain("body{color:red}");
    expect(result).toContain("const x={a:1};");
    expect(result).toMatch(/\n```\n\nafter$/);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps explicit JSON validation and invalid JavaScript unchanged", async () => {
    for (const source of ['```json\n<!DOCTYPE html><html></html>\n```', '```javascript\nconst x=;\n```']) {
      const view = editor(source);
      await expect(formatMarkdownCodeBlock(view, source, 0)).rejects.toMatchObject({ reason: "invalid" });
      expect(view.state.doc.toString()).toBe(source);
      expect(undo(view)).toBe(false);
    }
  });

  it("shows HTML and formats an HTML document through the preview button", async () => {
    const source = '```javascript\n<!DOCTYPE html><html><head><title>Test</title></head><body>hello</body></html>\n```';
    const view = editor(source);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onFormat = vi.fn((text, offset) => formatMarkdownCodeBlock(view, text, offset));
    try {
      await act(async () => { root.render(<MarkdownPreview markdown={source} onFormatCodeBlock={onFormat} />); });
      expect(host.querySelector(".font-medium")?.textContent).toBe("HTML");
      await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="codeBlockFormatting.format"]')!.click(); });
      expect(onFormat).toHaveBeenCalledWith(source, 0);
      expect(view.state.doc.toString()).toContain("\n  <head>\n    <title>Test</title>");
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it.each(["```", "~~~~"])("preserves %s fences, language info and surrounding prose with one undo", async (fence) => {
    const source = `before\n\n${fence}json extra\n{"a":1}\n${fence}\n\nafter`;
    const view = editor(source);
    view.dispatch({ changes: { from: 0, insert: "typed " } });
    const before = view.state.doc.toString();
    await formatMarkdownCodeBlock(view, before, before.indexOf(fence));
    expect(view.state.doc.toString()).toBe(before.replace('{"a":1}', '{\n  "a": 1\n}'));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
  });

  it("keeps blockquote prefixes and formats only the chosen duplicate block", async () => {
    const source = '> ```json\n> {"a":1}\n> ```\n\n```json\n{"a":1}\n```';
    const view = editor(source);
    await formatMarkdownCodeBlock(view, source, source.indexOf("```"));
    expect(view.state.doc.toString()).toBe('> ```json\n> {\n>   "a": 1\n> }\n> ```\n\n```json\n{"a":1}\n```');
  });

  it("preserves list indentation and leaves an empty block unchanged", async () => {
    const source = '- ```json\n  {"a":1}\n  ```\n\n- next item';
    const view = editor(source);
    await formatMarkdownCodeBlock(view, source, source.indexOf("```"));
    expect(view.state.doc.toString()).toBe('- ```json\n  {\n    "a": 1\n  }\n  ```\n\n- next item');
    const empty = '```json\n```';
    const blank = editor(empty);
    await formatMarkdownCodeBlock(blank, empty, 0);
    expect(blank.state.doc.toString()).toBe(empty);
  });

  it("maps preview positions across preprocessing without matching duplicate code strings", () => {
    const source = 'math $x$\n\n```json\n{"a":1}\n```\n\n```json\n{"a":1}\n```';
    const rendered = source.replace("$x$", "<span data-math-source=\"x\"></span>");
    const offset = rendered.lastIndexOf("```json");
    expect(resolveMarkdownCodeBlockSource(source, rendered, offset)).toBe(source.lastIndexOf("```json"));
  });

  it("rejects invalid syntax, stale previews, concurrent edits and revoked permission", async () => {
    const invalid = '```json\n{"a":}\n```';
    const view = editor(invalid);
    await expect(formatMarkdownCodeBlock(view, invalid, 0)).rejects.toMatchObject({ reason: "invalid" });
    expect(view.state.doc.toString()).toBe(invalid);
    const source = '```json\n{"a":1}\n```';
    const changed = editor(source);
    const pending = formatMarkdownCodeBlock(changed, source, 0);
    changed.dispatch({ changes: { from: 10, insert: " " } });
    await expect(pending).rejects.toMatchObject({ reason: "changed" });
    await expect(formatMarkdownCodeBlock(changed, source, 0)).rejects.toMatchObject({ reason: "changed" });
    const permission = new Compartment();
    const locked = editor(source, [permission.of(EditorView.editable.of(true))]);
    const locking = formatMarkdownCodeBlock(locked, source, 0);
    locked.dispatch({ effects: permission.reconfigure(EditorView.editable.of(false)) });
    await expect(locking).rejects.toMatchObject({ reason: "readOnly" });
    expect(locked.state.doc.toString()).toBe(source);
  });

  it("renders the source button for an active fence and removes it when locked", async () => {
    const permission = new Compartment();
    const source = '```json\n{"a":1}\n```';
    let view!: EditorView;
    await act(async () => { view = editor(source, [markdownCodeBlockFormattingExtension, permission.of(EditorView.editable.of(true))], 10); });
    expect(view.dom.querySelector('button[aria-label="codeBlockFormatting.format"]')).not.toBeNull();
    await act(async () => { view.dom.querySelector<HTMLButtonElement>('button[aria-label="codeBlockFormatting.format"]')!.click(); });
    expect(view.state.doc.toString()).toContain('"a": 1');
    await act(async () => { view.dispatch({ effects: permission.reconfigure(EditorView.editable.of(false)) }); });
    expect(view.dom.querySelector('button[aria-label="codeBlockFormatting.format"]')).toBeNull();
  });

  it("formats through the actual preview renderer, including transformed positions", async () => {
    const source = 'before $x$\n\n```json\n{"a":1}\n```\n\n```json\n{"a":1}\n```';
    const view = editor(source);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onFormat = vi.fn((text, offset) => formatMarkdownCodeBlock(view, text, offset));
    await act(async () => { root.render(<MarkdownPreview markdown={source} onFormatCodeBlock={onFormat} />); });
    const buttons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="codeBlockFormatting.format"]');
    expect(buttons).toHaveLength(2);
    await act(async () => { buttons[1].click(); });
    expect(onFormat).toHaveBeenCalledWith(source, source.lastIndexOf("```json"));
    expect(view.state.doc.toString()).toBe(source.slice(0, source.lastIndexOf('{"a":1}')) + '{\n  "a": 1\n}\n```');
    await act(async () => { root.render(<MarkdownPreview markdown={source} />); });
    expect(host.querySelector('button[aria-label="codeBlockFormatting.format"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("formats inactive Live blocks and removes the affordance after read-only reconfiguration", async () => {
    const source = '```json\n{"a":1}\n```\n\nediting paragraph';
    const permission = new Compartment();
    let view!: EditorView;
    await act(async () => { view = editor(source, [markdownLivePreviewExtension, permission.of(EditorState.readOnly.of(false))], source.length); });
    const button = view.dom.querySelector<HTMLButtonElement>('button[aria-label="codeBlockFormatting.format"]');
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); });
    expect(view.state.doc.toString()).toContain('"a": 1');
    await act(async () => { view.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(true)) }); });
    expect(view.dom.querySelector('button[aria-label="codeBlockFormatting.format"]')).toBeNull();
  });
});
