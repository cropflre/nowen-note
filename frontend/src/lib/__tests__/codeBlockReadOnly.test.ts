import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import {
  canUseCodeBlockToolbarAction,
  isEditorDocumentMutable,
  type CodeBlockToolbarAction,
} from "@/lib/codeBlockPermissions";
import { replaceCodeBlockWithPlainText } from "@/lib/tiptapEditorCommands";

const VIEW_ACTIONS: CodeBlockToolbarAction[] = [
  "copy",
  "collapse",
  "mermaid-view",
  "theme",
];

const MUTATING_ACTIONS: CodeBlockToolbarAction[] = [
  "language",
  "dissolve",
];

describe("code block read-only permissions", () => {
  it("keeps reading actions available and blocks document mutations while locked", () => {
    const editor = { isEditable: false, isDestroyed: false } as Pick<Editor, "isEditable" | "isDestroyed">;

    expect(isEditorDocumentMutable(editor)).toBe(false);
    for (const action of VIEW_ACTIONS) {
      expect(canUseCodeBlockToolbarAction(action, editor)).toBe(true);
    }
    for (const action of MUTATING_ACTIONS) {
      expect(canUseCodeBlockToolbarAction(action, editor)).toBe(false);
    }
  });

  it("restores language and dissolve actions after unlocking", () => {
    const editor = { isEditable: true, isDestroyed: false } as Pick<Editor, "isEditable" | "isDestroyed">;

    expect(isEditorDocumentMutable(editor)).toBe(true);
    for (const action of [...VIEW_ACTIONS, ...MUTATING_ACTIONS]) {
      expect(canUseCodeBlockToolbarAction(action, editor)).toBe(true);
    }
  });

  it("treats a destroyed editor as non-mutable", () => {
    const editor = { isEditable: true, isDestroyed: true } as Pick<Editor, "isEditable" | "isDestroyed">;
    expect(isEditorDocumentMutable(editor)).toBe(false);
    expect(canUseCodeBlockToolbarAction("dissolve", editor)).toBe(false);
  });
});

describe("replaceCodeBlockWithPlainText", () => {
  it("does not access EditorView or dispatch a transaction when the editor is read-only", () => {
    let viewAccessed = false;
    const editor = {
      isEditable: false,
      isDestroyed: false,
      get view() {
        viewAccessed = true;
        throw new Error("read-only command must not access EditorView");
      },
    } as unknown as Editor;

    const result = replaceCodeBlockWithPlainText(editor, 0, {} as ProseMirrorNode);

    expect(result).toBe(false);
    expect(viewAccessed).toBe(false);
  });

  it("keeps the unlocked dissolve behavior and converts every code line to a paragraph", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "text*", group: "block" },
        codeBlock: { content: "text*", group: "block", code: true },
        text: { group: "inline" },
      },
    });
    const codeBlock = schema.nodes.codeBlock.create(null, schema.text("first\nsecond"));
    let state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, [codeBlock]),
    });
    const focus = vi.fn();
    const dispatch = vi.fn((transaction: Transaction) => {
      state = state.apply(transaction);
    });
    const view = {
      get state() {
        return state;
      },
      dispatch,
      focus,
    };
    const editor = {
      isEditable: true,
      isDestroyed: false,
      view,
    } as unknown as Editor;

    expect(replaceCodeBlockWithPlainText(editor, 0, codeBlock)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("first");
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.child(1).textContent).toBe("second");
  });
});
