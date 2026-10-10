import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import {
  buildImageClipboardPasteTransaction,
  createImageClipboardPayload,
  mapImageClipboardPayload,
} from "../imageNodeClipboard";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    image: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        src: { default: "" },
        width: { default: null },
        rotation: { default: 0 },
        flipX: { default: false },
        alt: { default: null },
      },
      toDOM: (node) => ["img", node.attrs],
    },
  },
});

function image(src: string, attrs: Record<string, unknown> = {}) {
  return schema.nodes.image.create({ src, ...attrs });
}

function findImagePos(doc: any, src: string): number {
  let found = -1;
  doc.descendants((node: any, pos: number) => {
    if (found < 0 && node.type.name === "image" && node.attrs.src === src) found = pos;
  });
  if (found < 0) throw new Error(`image not found: ${src}`);
  return found;
}

function imageAttrs(doc: any) {
  const result: Array<Record<string, unknown>> = [];
  doc.descendants((node: any) => {
    if (node.type.name === "image") result.push({ ...node.attrs });
  });
  return result;
}

describe("imageNodeClipboard", () => {
  it("copies the full image node after the selected source without re-creating attachment data", () => {
    const source = image("/api/attachments/source", {
      width: 320,
      rotation: 90,
      flipX: true,
      alt: "产品图",
    });
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [source])]);
    const sourcePos = findImagePos(doc, "/api/attachments/source");
    const state = EditorState.create({
      schema,
      doc,
      selection: NodeSelection.create(doc, sourcePos),
    });
    const payload = createImageClipboardPayload(state, "copy");
    expect(payload).not.toBeNull();

    const result = buildImageClipboardPasteTransaction(state, payload!);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    const next = state.apply(result.transaction);
    expect(imageAttrs(next.doc)).toEqual([
      expect.objectContaining({
        src: "/api/attachments/source",
        width: 320,
        rotation: 90,
        flipX: true,
        alt: "产品图",
      }),
      expect.objectContaining({
        src: "/api/attachments/source",
        width: 320,
        rotation: 90,
        flipX: true,
        alt: "产品图",
      }),
    ]);
  });

  it("moves a cut image after the selected target in one transaction", () => {
    const source = image("/api/attachments/source", { rotation: 270, flipX: true });
    const target = image("/api/attachments/target");
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [source, schema.text("中间"), target]),
    ]);
    const sourcePos = findImagePos(doc, "/api/attachments/source");
    const targetPos = findImagePos(doc, "/api/attachments/target");
    const sourceState = EditorState.create({
      schema,
      doc,
      selection: NodeSelection.create(doc, sourcePos),
    });
    const payload = createImageClipboardPayload(sourceState, "cut");
    expect(payload).not.toBeNull();

    const targetState = EditorState.create({
      schema,
      doc,
      selection: NodeSelection.create(doc, targetPos),
    });
    const result = buildImageClipboardPasteTransaction(targetState, payload!);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    const next = targetState.apply(result.transaction);
    expect(imageAttrs(next.doc).map((attrs) => attrs.src)).toEqual([
      "/api/attachments/target",
      "/api/attachments/source",
    ]);
    expect(imageAttrs(next.doc)[1]).toEqual(expect.objectContaining({ rotation: 270, flipX: true }));
  });

  it("maps the source image position through edits made before paste", () => {
    const source = image("/api/attachments/source");
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("A"), source, schema.text("B")]),
    ]);
    const sourcePos = findImagePos(doc, "/api/attachments/source");
    const state = EditorState.create({
      schema,
      doc,
      selection: NodeSelection.create(doc, sourcePos),
    });
    const payload = createImageClipboardPayload(state, "cut");
    expect(payload).not.toBeNull();

    const transaction = state.tr.insertText("前置", 1);
    const mapped = mapImageClipboardPayload(payload!, transaction);
    expect(mapped).not.toBeNull();
    expect(mapped!.sourcePos).toBeGreaterThan(sourcePos);
    expect(transaction.doc.nodeAt(mapped!.sourcePos)?.attrs.src).toBe("/api/attachments/source");
  });
});
