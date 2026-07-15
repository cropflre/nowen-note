import { Schema, type DOMOutputSpec } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureAsyncInsertAnchor,
  mapAsyncInsertAnchors,
  releaseAsyncInsertAnchor,
  restoreAsyncInsertAnchor,
  type AsyncInsertAnchor,
} from "@/lib/asyncEditorInsert";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: (): DOMOutputSpec => ["p", 0],
    },
    horizontalRule: {
      group: "block",
      atom: true,
      toDOM: (): DOMOutputSpec => ["hr"],
    },
    image: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { src: {} },
      toDOM: (node): DOMOutputSpec => ["img", { src: node.attrs.src }],
    },
    text: { group: "inline" },
  },
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

function createDividerView(selection: "after" | "divider" = "after") {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, schema.text("111")),
    schema.node("horizontalRule"),
    schema.node("paragraph"),
  ]);
  const horizontalRulePos = doc.child(0).nodeSize;
  const afterDividerPos = horizontalRulePos + doc.child(1).nodeSize + 1;
  const state = EditorState.create({
    doc,
    selection: selection === "divider"
      ? NodeSelection.create(doc, horizontalRulePos)
      : TextSelection.create(doc, afterDividerPos),
  });
  const view = new EditorView(document.createElement("div"), { state });
  views.push(view);
  return { view, horizontalRulePos, afterDividerPos };
}

describe("async editor insertion anchors", () => {
  it("restores insertion below a horizontal rule after selection drift", () => {
    const { view } = createDividerView("after");
    const anchor = captureAsyncInsertAnchor(view);

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(restoreAsyncInsertAnchor(view, anchor)).toBe(true);
    const image = schema.nodes.image.create({ src: "/test.png" });
    view.dispatch(view.state.tr.replaceSelectionWith(image));

    expect(view.state.doc.child(1).type.name).toBe("horizontalRule");
    expect(view.state.doc.child(2).type.name).toBe("paragraph");
    expect(view.state.doc.child(2).child(0).type.name).toBe("image");
  });

  it("biases a selected horizontal rule toward the following paragraph", () => {
    const { view, horizontalRulePos } = createDividerView("divider");
    const anchor = captureAsyncInsertAnchor(view);

    expect(anchor.from).toBe(horizontalRulePos + 1);
    expect(restoreAsyncInsertAnchor(view, anchor)).toBe(true);
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.from).toBeGreaterThan(horizontalRulePos);
  });

  it("maps a pending anchor through edits and advances it after insertion", () => {
    const { view, afterDividerPos } = createDividerView("after");
    const anchors = new Set<AsyncInsertAnchor>();
    const anchor = captureAsyncInsertAnchor(view);
    anchors.add(anchor);

    const prefix = view.state.tr.insertText("abc", 1);
    mapAsyncInsertAnchors(anchors, prefix);
    view.dispatch(prefix);
    expect(anchor.from).toBe(afterDividerPos + 3);

    expect(restoreAsyncInsertAnchor(view, anchor)).toBe(true);
    const image = schema.nodes.image.create({ src: "/test.png" });
    const imageInsert = view.state.tr.replaceSelectionWith(image);
    mapAsyncInsertAnchors(anchors, imageInsert);
    view.dispatch(imageInsert);
    expect(anchor.from).toBeGreaterThan(afterDividerPos + 3);

    releaseAsyncInsertAnchor(anchors, anchor);
    expect(anchor.active).toBe(false);
    expect(anchors.size).toBe(0);
  });
});
