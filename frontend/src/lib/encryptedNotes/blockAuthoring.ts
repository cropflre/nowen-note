import { Compartment, EditorState, Transaction, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { encryptedBlockFence, markdownEncryptedBlocks } from "./blockDocument";
import { validateEncryptedNotePlaintext } from "./noteDocument";

/** Capture the exact selected text; a late encryption result must never replace a newer document. */
export function prepareMarkdownSelectionEncryption(view: EditorView, history: Compartment) {
  const snapshot = view.state.doc; const selections = view.state.selection.ranges;
  const { from, to, empty } = view.state.selection.main;
  if (!view.dom.isConnected || !view.state.facet(EditorView.editable) || view.state.facet(EditorState.readOnly)
    || empty || selections.length !== 1) throw new Error("Select editable text");
  if (markdownEncryptedBlocks(snapshot.toString()).some((block) => from < block.to && to > block.from)) throw new Error("Selection contains encrypted content");
  let unsupported = false;
  syntaxTree(view.state).iterate({ from, to, enter(node) {
    if (["FencedCode", "CodeBlock", "HTMLBlock", "HTMLTag", "Image", "Link"].includes(node.name)) unsupported = true;
  } });
  const plaintext = snapshot.sliceString(from, to);
  if (unsupported || !plaintext.trim()) throw new Error("Select ordinary text");
  validateEncryptedNotePlaintext(plaintext, "markdown");
  return { plaintext, format: "markdown" as const, commit: (source: string) => {
    if (!view.dom.isConnected || !view.state.facet(EditorView.editable) || view.state.facet(EditorState.readOnly)
      || view.state.doc !== snapshot) throw new Error("Encrypted selection changed");
    const extensions = history.get(view.state);
    if (extensions === undefined) throw new Error("Editor history unavailable");
    const before = snapshot.sliceString(0, from); const after = snapshot.sliceString(to);
    const insert = `${before && !before.endsWith("\n\n") ? "\n\n" : ""}${encryptedBlockFence(source)}${after && !after.startsWith("\n\n") ? "\n\n" : ""}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from }, effects: history.reconfigure([]), annotations: Transaction.addToHistory.of(false) });
    view.dispatch({ effects: history.reconfigure(extensions) });
  } };
}

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
