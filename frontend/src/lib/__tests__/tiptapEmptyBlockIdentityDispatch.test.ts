// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

import {
  EMPTY_BLOCK_ID_RECONCILIATION_META,
  isEmptyBlockIdentityOnlyChange,
  rewriteEmptyBlockIdentityTransaction,
} from "@/lib/tiptapEmptyBlockIdentityDispatch";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: {
        blockId: { default: null },
        textAlign: { default: null },
        lineHeight: { default: null },
      },
      toDOM: (node) => ["p", { "data-block-id": node.attrs.blockId }, 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
  },
});

function paragraphDoc(blockId: string | null, text = "", attrs: Record<string, unknown> = {}): ProseMirrorNode {
  return schema.node("doc", null, [
    schema.node(
      "paragraph",
      { blockId, textAlign: null, lineHeight: null, ...attrs },
      text ? [schema.text(text)] : undefined,
    ),
  ]);
}

const views: EditorView[] = [];

afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
  document.body.innerHTML = "";
});

describe("empty Tiptap Block identity dispatch", () => {
  it("rewrites an identity-only setContent into a non-history metadata transaction", () => {
    const current = paragraphDoc("blk_local000", "");
    const server = paragraphDoc("blk_server00", "");
    const state = EditorState.create({ doc: current, plugins: [history()] });
    const original = state.tr
      .replaceWith(0, state.doc.content.size, server.content)
      .setMeta("preventUpdate", true);

    const rewritten = rewriteEmptyBlockIdentityTransaction({ state }, original);

    expect(rewritten).not.toBe(original);
    expect(rewritten.getMeta("addToHistory")).toBe(false);
    expect(rewritten.getMeta("preventUpdate")).toBe(true);
    expect(rewritten.getMeta(EMPTY_BLOCK_ID_RECONCILIATION_META)).toBe(true);
    expect(rewritten.selection.from).toBe(state.selection.from);
    expect(rewritten.doc.firstChild?.attrs.blockId).toBe("blk_server00");
    expect(rewritten.doc.textContent).toBe("");
  });

  it("keeps the first Undo focused on the user's deletion, not the server Block ID", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: Transaction[] = [];
    let view!: EditorView;
    view = new EditorView(host, {
      state: EditorState.create({
        doc: paragraphDoc("blk_original", "Only text"),
        plugins: [history()],
      }),
      dispatchTransaction(transaction) {
        seen.push(transaction);
        view.updateState(view.state.apply(transaction));
      },
    });
    views.push(view);

    const localEmpty = paragraphDoc("blk_local000", "");
    let deletion = view.state.tr.replaceWith(0, view.state.doc.content.size, localEmpty.content);
    deletion = deletion.setSelection(TextSelection.create(deletion.doc, 1));
    view.dispatch(deletion);
    expect(view.state.doc.textContent).toBe("");
    expect(view.state.doc.firstChild?.attrs.blockId).toBe("blk_local000");

    const serverEmpty = paragraphDoc("blk_server00", "");
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, serverEmpty.content)
        .setMeta("preventUpdate", true),
    );

    const reconciliation = seen.at(-1);
    expect(reconciliation?.getMeta(EMPTY_BLOCK_ID_RECONCILIATION_META)).toBe(true);
    expect(reconciliation?.getMeta("addToHistory")).toBe(false);
    expect(view.state.selection.from).toBe(1);
    expect(view.state.doc.firstChild?.attrs.blockId).toBe("blk_server00");

    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.textContent).toBe("Only text");
    expect(view.state.doc.firstChild?.attrs.blockId).toBe("blk_original");
  });

  it("does not rewrite content, structure or presentation changes", () => {
    const emptyLocal = paragraphDoc("blk_local000", "");
    expect(isEmptyBlockIdentityOnlyChange(
      emptyLocal,
      paragraphDoc("blk_server00", "new text"),
    )).toBe(false);
    expect(isEmptyBlockIdentityOnlyChange(
      emptyLocal,
      paragraphDoc("blk_server00", "", { textAlign: "center" }),
    )).toBe(false);

    const state = EditorState.create({ doc: paragraphDoc("blk_local000", "Text") });
    const server = paragraphDoc("blk_server00", "Text");
    const transaction = state.tr.replaceWith(0, state.doc.content.size, server.content);
    expect(rewriteEmptyBlockIdentityTransaction({ state }, transaction)).toBe(transaction);
  });
});
