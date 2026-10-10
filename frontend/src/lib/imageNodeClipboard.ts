import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export type ImageClipboardMode = "copy" | "cut";

export type ImageClipboardPayload = {
  mode: ImageClipboardMode;
  nodeJson: Record<string, unknown>;
  sourcePos: number;
  sourceSrc: string;
};

export type ImageClipboardPasteResult =
  | { status: "ready"; transaction: Transaction; insertedPos: number }
  | { status: "same-position" }
  | { status: "source-missing" };

function isImageNode(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return node?.type?.name === "image";
}

function imageSrc(node: ProseMirrorNode | null | undefined): string {
  return isImageNode(node) ? String(node.attrs?.src || "") : "";
}

export function createImageClipboardPayload(
  state: EditorState,
  mode: ImageClipboardMode,
): ImageClipboardPayload | null {
  const selection = state.selection;
  if (!(selection instanceof NodeSelection) || !isImageNode(selection.node)) return null;
  return {
    mode,
    nodeJson: selection.node.toJSON() as Record<string, unknown>,
    sourcePos: selection.from,
    sourceSrc: imageSrc(selection.node),
  };
}

/**
 * Keep the source image identity mapped while the user edits before choosing the paste target.
 * If the source disappears (note switch, manual delete, document replacement), cancel the pending
 * clipboard rather than risking removal of the wrong node.
 */
export function mapImageClipboardPayload(
  payload: ImageClipboardPayload,
  transaction: Transaction,
): ImageClipboardPayload | null {
  if (!transaction.docChanged) return payload;

  const mappedPos = transaction.mapping.map(payload.sourcePos, 1);
  const mappedNode = transaction.doc.nodeAt(mappedPos);
  if (isImageNode(mappedNode) && imageSrc(mappedNode) === payload.sourceSrc) {
    return mappedPos === payload.sourcePos ? payload : { ...payload, sourcePos: mappedPos };
  }

  const matches: number[] = [];
  transaction.doc.descendants((node, pos) => {
    if (isImageNode(node) && imageSrc(node) === payload.sourceSrc) matches.push(pos);
  });
  return matches.length === 1 ? { ...payload, sourcePos: matches[0] } : null;
}

function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Build one ProseMirror transaction for image copy/move.
 *
 * - copy: duplicates the full image node JSON without touching the attachment file;
 * - cut: deletes the source and inserts at the mapped target in the same transaction, so one Undo
 *   restores the whole move and the source is never removed before paste succeeds.
 */
export function buildImageClipboardPasteTransaction(
  state: EditorState,
  payload: ImageClipboardPayload,
): ImageClipboardPasteResult {
  const sourceNode = state.doc.nodeAt(payload.sourcePos);
  if (!isImageNode(sourceNode) || imageSrc(sourceNode) !== payload.sourceSrc) {
    return { status: "source-missing" };
  }

  let imageNode: ProseMirrorNode;
  try {
    imageNode = state.schema.nodeFromJSON(payload.nodeJson);
  } catch {
    return { status: "source-missing" };
  }
  if (!isImageNode(imageNode)) return { status: "source-missing" };

  const selection = state.selection;
  const sourceFrom = payload.sourcePos;
  const sourceTo = sourceFrom + sourceNode.nodeSize;

  if (payload.mode === "cut" && selection instanceof NodeSelection && selection.from === sourceFrom) {
    return { status: "same-position" };
  }
  if (
    payload.mode === "cut"
    && !selection.empty
    && rangesOverlap(selection.from, selection.to, sourceFrom, sourceTo)
  ) {
    return { status: "same-position" };
  }

  let targetFrom = selection.from;
  let targetTo = selection.to;
  if (selection instanceof NodeSelection) {
    // Node selections paste after the selected node. For Copy on the source image itself this
    // produces the intuitive "duplicate after current image" behavior instead of replacing it.
    targetFrom = selection.to;
    targetTo = selection.to;
  }

  let transaction = state.tr;
  let insertedPos: number;

  if (payload.mode === "cut") {
    transaction = transaction.delete(sourceFrom, sourceTo);
    const mappedFrom = transaction.mapping.map(targetFrom, -1);
    const mappedTo = transaction.mapping.map(targetTo, 1);
    insertedPos = mappedFrom;
    transaction = mappedFrom === mappedTo
      ? transaction.insert(mappedFrom, imageNode)
      : transaction.replaceRangeWith(mappedFrom, mappedTo, imageNode);
  } else if (selection instanceof NodeSelection) {
    insertedPos = targetFrom;
    transaction = transaction.insert(targetFrom, imageNode);
  } else {
    insertedPos = selection.from;
    transaction = transaction.replaceSelectionWith(imageNode, false);
  }

  try {
    transaction = transaction.setSelection(NodeSelection.create(transaction.doc, insertedPos));
  } catch {
    // Some unusual parent schemas cannot select the inserted inline node; insertion still succeeds.
  }
  return { status: "ready", transaction: transaction.scrollIntoView(), insertedPos };
}
