import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const INSTALL_SYMBOL = Symbol.for("nowen.tiptap.empty-block-identity-dispatch");

export const EMPTY_BLOCK_ID_RECONCILIATION_META = "nowen:empty-block-id-reconciliation";

interface EmptyParagraphIdentity {
  blockId: string | null;
  attrsWithoutBlockId: Record<string, unknown>;
}

function normalizedAttrs(node: ProseMirrorNode): Record<string, unknown> {
  const attrs = { ...(node.attrs || {}) } as Record<string, unknown>;
  delete attrs.blockId;
  return attrs;
}

function describeEmptyParagraph(doc: ProseMirrorNode): EmptyParagraphIdentity | null {
  if (doc.type.name !== "doc" || doc.childCount !== 1) return null;
  const paragraph = doc.firstChild;
  if (!paragraph || paragraph.type.name !== "paragraph" || paragraph.content.size !== 0) return null;

  const rawBlockId = paragraph.attrs?.blockId;
  const blockId = typeof rawBlockId === "string" && rawBlockId.length > 0
    ? rawBlockId
    : null;
  return {
    blockId,
    attrsWithoutBlockId: normalizedAttrs(paragraph),
  };
}

/**
 * Empty-document reconciliation is safe only when the complete ProseMirror document differs by the
 * single paragraph's stable Block ID. Any text, node, document-attribute or presentation-attribute
 * change must continue through the original transaction.
 */
export function isEmptyBlockIdentityOnlyChange(
  currentDoc: ProseMirrorNode,
  nextDoc: ProseMirrorNode,
): boolean {
  if (currentDoc.type !== nextDoc.type) return false;
  if (JSON.stringify(currentDoc.attrs) !== JSON.stringify(nextDoc.attrs)) return false;

  const current = describeEmptyParagraph(currentDoc);
  const next = describeEmptyParagraph(nextDoc);
  if (!current || !next || !next.blockId || !BLOCK_ID_RE.test(next.blockId)) return false;
  if (current.blockId === next.blockId) return false;
  return JSON.stringify(current.attrsWithoutBlockId) === JSON.stringify(next.attrsWithoutBlockId);
}

/**
 * Convert Tiptap's whole-document setContent transaction into one metadata-only node-markup step.
 * The replacement keeps the exact selection and is excluded from ProseMirror history, so the next
 * Undo still restores the user's deletion rather than merely undoing the server Block ID.
 */
export function rewriteEmptyBlockIdentityTransaction(
  view: Pick<EditorView, "state">,
  transaction: Transaction,
): Transaction {
  if (!transaction.docChanged || !isEmptyBlockIdentityOnlyChange(view.state.doc, transaction.doc)) {
    return transaction;
  }

  const currentParagraph = view.state.doc.firstChild;
  const nextParagraph = transaction.doc.firstChild;
  if (!currentParagraph || !nextParagraph) return transaction;

  const rewritten = view.state.tr
    .setNodeMarkup(0, undefined, {
      ...currentParagraph.attrs,
      blockId: nextParagraph.attrs.blockId,
    })
    .setMeta("addToHistory", false)
    .setMeta(EMPTY_BLOCK_ID_RECONCILIATION_META, true);

  const preventUpdate = transaction.getMeta("preventUpdate");
  if (preventUpdate !== undefined) rewritten.setMeta("preventUpdate", preventUpdate);
  if (transaction.scrolledIntoView) rewritten.scrollIntoView();
  return rewritten;
}

/** Install once for every Tiptap/ProseMirror editor sharing this bundle. */
export function installTiptapEmptyBlockIdentityDispatch(): void {
  const prototype = EditorView.prototype as EditorView & Record<PropertyKey, unknown>;
  if (prototype[INSTALL_SYMBOL]) return;

  const originalDispatch = EditorView.prototype.dispatch;
  EditorView.prototype.dispatch = function dispatchWithEmptyBlockIdentity(
    this: EditorView,
    transaction: Transaction,
  ): void {
    originalDispatch.call(this, rewriteEmptyBlockIdentityTransaction(this, transaction));
  };
  prototype[INSTALL_SYMBOL] = true;
}

installTiptapEmptyBlockIdentityDispatch();
