import { EditorState, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { encryptedBlockFence, markdownEncryptedBlocks } from "./blockDocument";

/** Bind a preview card to its original fence, including repeated copies and shifted preview offsets. */
export function prepareMarkdownEncryptedRegionEdit(view: EditorView, source: string, rendered: string, offset: number): { source: string; commit: (ciphertext: string) => void } {
  const snapshot = view.state.doc;
  if (!view.dom.isConnected || !view.state.facet(EditorView.editable) || view.state.facet(EditorState.readOnly)) throw new Error("Encrypted region is read-only");
  if (snapshot.toString() !== source) throw new Error("Encrypted preview is stale");
  const original = markdownEncryptedBlocks(source);
  const preview = markdownEncryptedBlocks(rendered);
  const index = preview.findIndex((block) => offset >= block.from && offset < block.to);
  const block = original[index];
  if (!block || original.length !== preview.length || JSON.stringify(block.envelope) !== JSON.stringify(preview[index].envelope)) throw new Error("Encrypted preview fence changed");
  return { source: block.source, commit: (ciphertext) => {
    if (!view.dom.isConnected || view.state.facet(EditorState.readOnly)) throw new Error("Encrypted region changed");
    commitMarkdownEncryptedRegion(view, snapshot, block, ciphertext);
  } };
}

/** Only a completed envelope enters the main editor, in one isolated undo step. */
export function commitMarkdownEncryptedRegion(view: EditorView, snapshot: Text, range: { from: number; to: number; prefix?: string }, source: string): void {
  if (!view.state.facet(EditorView.editable) || view.state.doc !== snapshot) throw new Error("Encrypted region changed");
  view.dispatch({ changes: { from: range.from, to: range.to, insert: encryptedBlockFence(source, range.prefix) }, selection: { anchor: range.from }, annotations: isolateHistory.of("full") });
}
