import { describe, expect, it, vi } from "vitest";
import { NodeView } from "@tiptap/core";
import {
  canApplyNodeViewMutation,
  installNodeViewMutationGuard,
  runNodeViewMutation,
} from "@/lib/nodeViewMutationGuard";

describe("NodeView mutation guard", () => {
  it("re-reads the live editor state before every mutation", () => {
    const target = {
      editor: {
        isEditable: true,
        isDestroyed: false,
      },
    };

    expect(canApplyNodeViewMutation(target)).toBe(true);

    target.editor.isEditable = false;
    expect(canApplyNodeViewMutation(target)).toBe(false);

    target.editor.isEditable = true;
    target.editor.isDestroyed = true;
    expect(canApplyNodeViewMutation(target)).toBe(false);
  });

  it("does not execute stale callbacks after the notebook becomes locked", () => {
    const target = {
      editor: {
        isEditable: false,
        isDestroyed: false,
      },
    };
    const mutation = vi.fn(() => "mutated");

    expect(runNodeViewMutation(target, mutation)).toBeUndefined();
    expect(mutation).not.toHaveBeenCalled();
  });

  it("executes the original NodeView mutation while the editor is editable", () => {
    const target = {
      editor: {
        isEditable: true,
        isDestroyed: false,
      },
    };
    const mutation = vi.fn(() => "mutated");

    expect(runNodeViewMutation(target, mutation)).toBe("mutated");
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("patches updateAttributes and deleteNode once and blocks both in read-only mode", () => {
    const prototype = NodeView.prototype as any;

    installNodeViewMutationGuard();
    const guardedUpdateAttributes = prototype.updateAttributes;
    const guardedDeleteNode = prototype.deleteNode;

    installNodeViewMutationGuard();
    expect(prototype.updateAttributes).toBe(guardedUpdateAttributes);
    expect(prototype.deleteNode).toBe(guardedDeleteNode);

    // These fake NodeViews intentionally omit getPos/node/commands. If the
    // original Tiptap methods were reached, both calls would throw.
    const lockedNodeView = {
      editor: {
        isEditable: false,
        isDestroyed: false,
      },
    };

    expect(() => guardedUpdateAttributes.call(lockedNodeView, { width: 640 })).not.toThrow();
    expect(() => guardedDeleteNode.call(lockedNodeView)).not.toThrow();
  });

  it("blocks destroyed NodeViews even when their last editable snapshot was true", () => {
    const target = {
      editor: {
        isEditable: true,
        isDestroyed: true,
      },
    };
    const mutation = vi.fn();

    expect(runNodeViewMutation(target, mutation)).toBeUndefined();
    expect(mutation).not.toHaveBeenCalled();
  });
});
