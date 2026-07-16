import { NodeView } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { isEditorDocumentMutable } from "@/lib/codeBlockPermissions";

type MutableEditorState = Pick<Editor, "isEditable" | "isDestroyed">;

export interface NodeViewMutationTarget {
  editor?: MutableEditorState | null;
}

const NODE_VIEW_MUTATION_GUARD = Symbol.for("nowen.tiptap.nodeViewMutationGuard");

/**
 * Re-read the live editor state at mutation time.
 *
 * NodeView callbacks may be created while the editor is editable and invoked
 * after the notebook has been locked, so a render-time boolean is not enough.
 */
export function canApplyNodeViewMutation(
  target: NodeViewMutationTarget | null | undefined,
): boolean {
  return isEditorDocumentMutable(target?.editor);
}

/**
 * Execute a NodeView document mutation only while the editor is still mutable.
 * Returning undefined is intentional: Tiptap's updateAttributes/deleteNode
 * helpers are void APIs, and a blocked mutation must be a silent no-op.
 */
export function runNodeViewMutation<T>(
  target: NodeViewMutationTarget | null | undefined,
  mutation: () => T,
): T | undefined {
  if (!canApplyNodeViewMutation(target)) return undefined;
  return mutation();
}

/**
 * Install one process-wide guard on Tiptap's NodeView base class.
 *
 * ReactNodeView inherits these methods, so this protects every current and
 * future React NodeView that changes node attributes or deletes a node. It is
 * deliberately narrower than patching EditorView.dispatch: selection changes,
 * remote collaboration transactions and server-driven content refreshes remain
 * untouched while locked.
 */
export function installNodeViewMutationGuard(): void {
  const prototype = NodeView.prototype as any;
  if (prototype[NODE_VIEW_MUTATION_GUARD]) return;

  const originalUpdateAttributes = prototype.updateAttributes;
  const originalDeleteNode = prototype.deleteNode;

  if (typeof originalUpdateAttributes !== "function" || typeof originalDeleteNode !== "function") {
    console.warn("[NodeViewMutationGuard] Tiptap NodeView mutation methods were not found");
    return;
  }

  prototype.updateAttributes = function guardedUpdateAttributes(
    this: NodeViewMutationTarget,
    attributes: Record<string, unknown>,
  ): void {
    runNodeViewMutation(this, () => originalUpdateAttributes.call(this, attributes));
  };

  prototype.deleteNode = function guardedDeleteNode(this: NodeViewMutationTarget): void {
    runNodeViewMutation(this, () => originalDeleteNode.call(this));
  };

  Object.defineProperty(prototype, NODE_VIEW_MUTATION_GUARD, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
}
