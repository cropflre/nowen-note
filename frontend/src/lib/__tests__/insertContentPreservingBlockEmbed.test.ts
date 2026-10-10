// @vitest-environment jsdom

import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { insertContentPreservingBlockEmbed } from "@/lib/insertContentPreservingBlockEmbed";

const Embed = Node.create({
  name: "blockEmbed",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({ href: { default: "" } }),
  parseHTML: () => [{ tag: "div[data-nowen-block-embed]", getAttrs: (element) => ({ href: (element as HTMLElement).getAttribute("data-nowen-block-embed") }) }],
  renderHTML: ({ HTMLAttributes }) => ["div", { "data-nowen-block-embed": HTMLAttributes.href }],
});

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

describe("insertContentPreservingBlockEmbed", () => {
  it("inserts after a selected mind map embed without replacing its stable reference", () => {
    const editor = new Editor({
      extensions: [StarterKit, Embed],
      content: '<p>前文</p><div data-nowen-block-embed="mindmap:11111111-1111-4111-8111-111111111111"></div><p>后文</p>',
    });
    editors.push(editor);
    editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize);

    expect(insertContentPreservingBlockEmbed(editor, '<div data-nowen-block-embed="mindmap:22222222-2222-4222-8222-222222222222"></div>')).toBe(true);
    expect(editor.getJSON().content).toMatchObject([
      { type: "paragraph" },
      { type: "blockEmbed", attrs: { href: "mindmap:11111111-1111-4111-8111-111111111111" } },
      { type: "blockEmbed", attrs: { href: "mindmap:22222222-2222-4222-8222-222222222222" } },
      { type: "paragraph", content: [{ text: "后文" }] },
    ]);
  });

  it("also places a Mermaid block after the selected native embed", () => {
    const editor = new Editor({
      extensions: [StarterKit, Embed],
      content: '<div data-nowen-block-embed="mindmap:11111111-1111-4111-8111-111111111111"></div><p>后文</p>',
    });
    editors.push(editor);
    editor.commands.setNodeSelection(0);

    expect(insertContentPreservingBlockEmbed(editor, {
      type: "codeBlock",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "mindmap\n  root((中心主题))" }],
    })).toBe(true);
    expect(editor.getJSON().content).toMatchObject([
      { type: "blockEmbed", attrs: { href: "mindmap:11111111-1111-4111-8111-111111111111" } },
      { type: "codeBlock", attrs: { language: "mermaid" } },
      { type: "paragraph", content: [{ text: "后文" }] },
    ]);
  });
});
