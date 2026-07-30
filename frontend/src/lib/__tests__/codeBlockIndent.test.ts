// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  IndentExtension,
  resolveIndentTargets,
} from "@/lib/codeBlockIndent";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function createEditor(content: Record<string, unknown>): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, IndentExtension],
    content,
  });
  editors.push(editor);
  return editor;
}

function nodePositions(editor: Editor, typeName: string): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === typeName) positions.push(pos);
  });
  return positions;
}

function topLevelTypes(editor: Editor): string[] {
  return Array.from(
    { length: editor.state.doc.childCount },
    (_, index) => editor.state.doc.child(index).type.name,
  );
}

function changeIndent(editor: Editor, delta: number): boolean {
  return (editor.commands as any).changeIndent(delta);
}

function paragraph(text: string) {
  return {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : undefined,
  };
}

function listItem(text: string, extra: Record<string, unknown>[] = []) {
  return {
    type: "listItem",
    content: [paragraph(text), ...extra],
  };
}

function orderedList(items: Record<string, unknown>[]) {
  return { type: "orderedList", content: items };
}

function codeBlock(text: string) {
  return {
    type: "codeBlock",
    content: [{ type: "text", text }],
  };
}

describe("code block indent commands", () => {
  it("applies repeated visual indent to only the selected standalone code block", () => {
    const editor = createEditor({
      type: "doc",
      content: [codeBlock("first"), codeBlock("second")],
    });
    const [firstPos, secondPos] = nodePositions(editor, "codeBlock");
    editor.commands.setTextSelection(firstPos + 2);

    expect(changeIndent(editor, 1)).toBe(true);
    expect(changeIndent(editor, 1)).toBe(true);
    expect(changeIndent(editor, 1)).toBe(true);

    expect(editor.state.doc.nodeAt(firstPos)?.attrs.indent).toBe(3);
    expect(editor.state.doc.nodeAt(secondPos)?.attrs.indent).toBe(0);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("targets a nested code block instead of its ordered-list ancestors", () => {
    const editor = createEditor({
      type: "doc",
      content: [orderedList([
        listItem("one", [codeBlock("nested")]),
      ])],
    });
    const [listPos] = nodePositions(editor, "orderedList");
    const [codePos] = nodePositions(editor, "codeBlock");
    editor.commands.setTextSelection(codePos + 2);

    const targets = resolveIndentTargets(editor.state);
    expect(targets.map((target) => target.node.type.name)).toEqual(["codeBlock"]);
    expect(changeIndent(editor, 1)).toBe(true);

    expect(editor.state.doc.nodeAt(codePos)?.attrs.indent).toBe(1);
    expect(editor.state.doc.nodeAt(listPos)?.attrs.indent).toBe(0);
  });

  it("moves a code block into the preceding numbered item and joins the following list", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        orderedList([listItem("one")]),
        codeBlock("example"),
        orderedList([listItem("two")]),
      ],
    });
    const [codePos] = nodePositions(editor, "codeBlock");
    editor.commands.setTextSelection(codePos + 3);

    expect(changeIndent(editor, 1)).toBe(true);

    expect(topLevelTypes(editor)).toEqual(["orderedList", "paragraph"]);
    const list = editor.state.doc.child(0);
    expect(list.type.name).toBe("orderedList");
    expect(list.childCount).toBe(2);
    expect(list.child(0).childCount).toBe(2);
    expect(list.child(0).child(1).type.name).toBe("codeBlock");
    expect(list.child(0).child(1).textContent).toBe("example");
    expect(list.child(1).textContent).toBe("two");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("supports repeated indent after the code block becomes part of a numbered item", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        orderedList([listItem("one")]),
        codeBlock("example"),
        orderedList([listItem("two")]),
      ],
    });
    const [codePos] = nodePositions(editor, "codeBlock");
    editor.commands.setTextSelection(codePos + 2);

    expect(changeIndent(editor, 1)).toBe(true);
    expect(changeIndent(editor, 1)).toBe(true);
    expect(changeIndent(editor, 1)).toBe(true);

    const [nestedCodePos] = nodePositions(editor, "codeBlock");
    expect(editor.state.doc.nodeAt(nestedCodePos)?.attrs.indent).toBe(2);
    expect(editor.state.doc.child(0).childCount).toBe(2);
  });

  it("reduces visual indent before lifting the code block out of its list", () => {
    const editor = createEditor({
      type: "doc",
      content: [orderedList([
        listItem("one", [{
          type: "codeBlock",
          attrs: { indent: 1 },
          content: [{ type: "text", text: "nested" }],
        }]),
        listItem("two"),
      ])],
    });
    const [codePos] = nodePositions(editor, "codeBlock");
    editor.commands.setTextSelection(codePos + 2);

    expect(changeIndent(editor, -1)).toBe(true);
    expect(editor.state.doc.nodeAt(codePos)?.attrs.indent).toBe(0);
    expect(topLevelTypes(editor)).toEqual(["orderedList", "paragraph"]);

    expect(changeIndent(editor, -1)).toBe(true);
    expect(topLevelTypes(editor)).toEqual([
      "orderedList",
      "codeBlock",
      "orderedList",
      "paragraph",
    ]);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("does not mutate a read-only editor", () => {
    const editor = createEditor({ type: "doc", content: [codeBlock("readonly")] });
    const [codePos] = nodePositions(editor, "codeBlock");
    editor.commands.setTextSelection(codePos + 2);
    editor.setEditable(false);

    expect(changeIndent(editor, 1)).toBe(false);
    expect(editor.state.doc.nodeAt(codePos)?.attrs.indent).toBe(0);
  });
});
