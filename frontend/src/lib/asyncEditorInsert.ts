import { NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export interface AsyncInsertAnchor {
  from: number;
  to: number;
  bias: -1 | 1;
  active: boolean;
}

function clampPosition(position: number, max: number): number {
  return Math.max(0, Math.min(max, position));
}

/** Capture the logical insertion point before a native picker or modal blurs the editor. */
export function captureAsyncInsertAnchor(view: Pick<EditorView, "state">): AsyncInsertAnchor {
  const { selection } = view.state;
  if (selection instanceof NodeSelection) {
    return {
      from: selection.to,
      to: selection.to,
      bias: 1,
      active: true,
    };
  }

  return {
    from: selection.from,
    to: selection.to,
    bias: selection.head >= selection.anchor ? 1 : -1,
    active: true,
  };
}

/** Keep pending insertion points aligned with edits that happen while an upload is running. */
export function mapAsyncInsertAnchors(
  anchors: Iterable<AsyncInsertAnchor>,
  transaction: Transaction,
): void {
  if (!transaction.docChanged) return;

  for (const anchor of anchors) {
    if (!anchor.active) continue;
    const collapsed = anchor.from === anchor.to;
    const mappedFrom = transaction.mapping.map(anchor.from, collapsed ? 1 : -1);
    const mappedTo = transaction.mapping.map(anchor.to, 1);
    anchor.from = Math.min(mappedFrom, mappedTo);
    anchor.to = Math.max(mappedFrom, mappedTo);
  }
}

/** Restore a text-capable selection close to the captured point (biasing after atom nodes). */
export function restoreAsyncInsertAnchor(view: EditorView, anchor: AsyncInsertAnchor): boolean {
  if (!anchor.active) return false;

  const { doc } = view.state;
  const max = doc.content.size;
  const from = clampPosition(anchor.from, max);
  const to = clampPosition(anchor.to, max);

  try {
    const selection = TextSelection.between(
      doc.resolve(Math.min(from, to)),
      doc.resolve(Math.max(from, to)),
      anchor.bias,
    );
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    return true;
  } catch (error) {
    console.warn("Failed to restore async editor insert anchor:", error);
    return false;
  }
}

export function releaseAsyncInsertAnchor(
  anchors: Set<AsyncInsertAnchor>,
  anchor: AsyncInsertAnchor,
): void {
  anchor.active = false;
  anchors.delete(anchor);
}
