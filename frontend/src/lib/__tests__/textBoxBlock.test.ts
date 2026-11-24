// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, generateHTML, generateJSON, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Slice } from "@tiptap/pm/model";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import {
  applyTextBoxDropSide,
  endTextBoxDrag,
  isTextBox,
  resolveTextBoxDropSide,
  startTextBoxDrag,
  textBoxDragPluginKey,
  textBoxNodeViewAttrs,
} from "@/components/extensions/textBox";
import { addBlockBelow, convertBlock } from "@/components/blockMenuActions";
import { getTiptapExtensions, markdownToTiptapJSON, tiptapJsonToMarkdown } from "@/lib/contentFormat";
import { noteContentToExportHtml } from "@/lib/exportServiceCore";
import { tiptapExtensions } from "@/lib/importService";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

const editors: Editor[] = [];
const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const textBox = (attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent => ({ type: "callout", attrs: { type: "gray", icon: "", ...attrs }, content });
const fixture: JSONContent = { type: "doc", content: [
  textBox({ float: "right", width: 35 }, paragraph("Boxed caption"), paragraph("Second boxed line")),
  paragraph("Body text wraps around the box"),
  textBox({ float: "left", width: 60 }, paragraph("Left box")),
  { type: "callout", attrs: { type: "blue", icon: "" }, content: [paragraph("Plain callout")] },
] };

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  vi.useRealTimers();
});

function createEditor(content: unknown, extensions = tiptapExtensions): Editor {
  const editor = new Editor({ element: document.createElement("div"), extensions, content: content as JSONContent });
  editors.push(editor);
  return editor;
}

function boxes(json: unknown): Array<{ float: unknown; width: unknown; text: string }> {
  return ((json as JSONContent).content ?? [])
    .filter((node) => node.type === "callout")
    .map((node) => ({ float: node.attrs?.float ?? null, width: node.attrs?.width ?? null, text: JSON.stringify(node.content) }));
}

function assertFixture(json: unknown) {
  const result = boxes(json);
  expect(result.map(({ float, width }) => [float, width])).toEqual([["right", 35], ["left", 60], [null, null]]);
  expect(result[0].text).toContain("Boxed caption");
  expect(result[0].text).toContain("Second boxed line");
  expect(result[1].text).toContain("Left box");
  expect(JSON.stringify(json)).toContain("Body text wraps around the box");
}

describe("text box data (Issue #915)", () => {
  it("survives schema repair, Markdown switching, static HTML and export", () => {
    let content: unknown = fixture;
    for (let round = 0; round < 3; round++) { content = repairTiptapJson(content); assertFixture(content); }

    content = fixture;
    for (let round = 0; round < 3; round++) {
      const markdown = tiptapJsonToMarkdown(content);
      expect(markdown).toContain('data-float="right"');
      content = markdownToTiptapJSON(markdown);
      assertFixture(content);
    }

    const html = generateHTML(fixture, getTiptapExtensions());
    expect(html).toMatch(/data-float="right"[^>]*data-width="35"|data-width="35"[^>]*data-float="right"/);
    expect(html).toContain("float: right");
    expect(html).toContain("width: 35%");
    assertFixture(generateJSON(html, getTiptapExtensions()));
    assertFixture(generateJSON(noteContentToExportHtml(JSON.stringify(fixture), "", "tiptap-json"), getTiptapExtensions()));
  });

  it("degrades to a normal callout, keeping the text, in versions without text boxes", () => {
    // 1.6.0 及更早版本的 callout 只有 type / icon 两个属性。
    const OldCallout = CalloutExtension.extend({
      addAttributes() {
        return {
          type: { default: "blue", parseHTML: (el: HTMLElement) => el.getAttribute("data-callout-type") || "blue", renderHTML: (a: Record<string, unknown>) => ({ "data-callout-type": a.type }) },
          icon: { default: "", renderHTML: () => ({}) },
        };
      },
    });
    const oldExtensions = [StarterKit, OldCallout];
    const reopened = generateJSON(generateHTML(fixture, oldExtensions), oldExtensions);
    expect(boxes(reopened).map(({ float }) => float)).toEqual([null, null, null]);
    expect(JSON.stringify(reopened)).toContain("Boxed caption");
    expect(JSON.stringify(reopened)).toContain("Left box");
    // A brand-new node type would have made the old schema reject the whole note.
    expect(() => generateHTML({ type: "doc", content: [{ type: "textBox", content: [paragraph("x")] }] }, oldExtensions)).toThrow(/Unknown node type/);
  });

  it("exposes float and width to the node view's outer element", () => {
    const editor = createEditor(fixture);
    const [right, , left, plain] = Array.from({ length: 4 }, (_, index) => editor.state.doc.child(index));
    expect(textBoxNodeViewAttrs(right)).toEqual({ "data-text-box": "right", style: "--nowen-text-box-width: 35%" });
    expect(textBoxNodeViewAttrs(left)).toEqual({ "data-text-box": "left", style: "--nowen-text-box-width: 60%" });
    expect(textBoxNodeViewAttrs(plain)).toEqual({ "data-text-box": "off", style: "" });
    expect(isTextBox(right)).toBe(true);
    expect(isTextBox(plain)).toBe(false);
  });
});

describe("inserting and converting text boxes", () => {
  it("wraps the current block and switches between text box and callout without losing content", () => {
    const editor = createEditor({ type: "doc", content: [paragraph("Make me a box"), paragraph("Body")] });
    expect(convertBlock(editor, { type: "textBox" }, 1)).toBe(true);
    editor.state.doc.check();
    let box = editor.state.doc.firstChild!;
    expect(box.type.name).toBe("callout");
    expect(box.attrs).toMatchObject({ type: "gray", float: "right", width: 40 });
    expect(box.textContent).toBe("Make me a box");

    expect(convertBlock(editor, { type: "textBox" }, 1)).toBe(false);
    expect(convertBlock(editor, { type: "callout" }, 1)).toBe(true);
    box = editor.state.doc.firstChild!;
    expect(box.attrs).toMatchObject({ type: "gray", float: null, width: null });
    expect(box.textContent).toBe("Make me a box");

    expect(convertBlock(editor, { type: "textBox" }, 1)).toBe(true);
    expect(editor.state.doc.firstChild!.attrs).toMatchObject({ float: "right", width: 40 });
    expect(convertBlock(editor, { type: "paragraph" }, 1)).toBe(true);
    expect(editor.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("Make me a boxBody");
  });

  it("refuses to nest a text box inside a callout", () => {
    const editor = createEditor({ type: "doc", content: [textBox({}, paragraph("Inside a callout"))] });
    const before = editor.getJSON();
    expect(convertBlock(editor, { type: "textBox" }, 3)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("adds an empty floating box below the current block with the cursor inside", () => {
    const editor = createEditor({ type: "doc", content: [paragraph("Existing")] });
    expect(addBlockBelow(editor, "textBox", 1)).not.toBeNull();
    editor.state.doc.check();
    const box = editor.state.doc.child(1);
    expect(box.attrs).toMatchObject({ type: "gray", float: "right", width: 40 });
    expect(box.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.node(1)).toBe(box);
  });
});

describe("dragging a text box to the other side", () => {
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 100, height: 100, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  function dragEvent() {
    const data = new Map<string, string>();
    const dataTransfer = {
      clearData: () => data.clear(),
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      setDragImage: vi.fn(),
      effectAllowed: "none",
    };
    return { event: { dataTransfer } as unknown as DragEvent, data };
  }

  function dragPlugin(editor: Editor) {
    const plugin = textBoxDragPluginKey.get(editor.state)!;
    return {
      drop: (x: number) => plugin.props.handleDOMEvents!.drop!.call(plugin, editor.view, { clientX: x, clientY: 10 } as DragEvent),
      transform: (slice: Slice) => plugin.props.transformPasted!.call(plugin, slice, editor.view, false),
    };
  }

  it("uses the half of the drop container to pick the side", () => {
    const editor = createEditor(fixture);
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 40, inside: -1 });
    vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(rect(100, 800));
    expect(resolveTextBoxDropSide(editor.view, 300, 10)).toBe("left");
    expect(resolveTextBoxDropSide(editor.view, 700, 10)).toBe("right");
  });

  it("moves the dragged box to the drop side and leaves other drags and pastes alone", () => {
    vi.useFakeTimers();
    const editor = createEditor(fixture);
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 40, inside: -1 });
    vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(rect(0, 1000));
    const plugin = dragPlugin(editor);

    const { event, data } = dragEvent();
    expect(startTextBoxDrag(editor.view, 0, event)).toBe(true);
    expect(data.get("text/plain")).toContain("Boxed caption");
    expect(data.get("text/html")).toContain('data-float="right"');
    const dragging = (editor.view as unknown as { dragging: { move: boolean; slice: Slice } }).dragging;
    expect(dragging.move).toBe(true);
    expect(isTextBox(dragging.slice.content.firstChild)).toBe(true);

    plugin.drop(200);
    const moved = plugin.transform(dragging.slice);
    expect(moved.content.firstChild!.attrs).toMatchObject({ float: "left", width: 35 });
    expect(moved.content.firstChild!.textContent).toBe("Boxed captionSecond boxed line");

    // A later paste or block-handle drag is not affected.
    expect(plugin.transform(dragging.slice)).toBe(dragging.slice);
    expect(applyTextBoxDropSide(Slice.empty, "left")).toBe(Slice.empty);
  });

  it("clears the drag state when the drag is cancelled", () => {
    vi.useFakeTimers();
    const editor = createEditor(fixture);
    const { event } = dragEvent();
    expect(startTextBoxDrag(editor.view, 0, event)).toBe(true);
    endTextBoxDrag(editor.view);
    vi.advanceTimersByTime(60);
    expect((editor.view as unknown as { dragging: unknown }).dragging).toBeNull();
    // Only text boxes start this drag.
    expect(startTextBoxDrag(editor.view, editor.state.doc.child(0).nodeSize, event)).toBe(false);
  });
});
