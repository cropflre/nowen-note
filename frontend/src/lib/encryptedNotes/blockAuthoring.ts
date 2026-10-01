import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { encryptedBlockFence } from "./blockDocument";

/** Only a completed envelope enters the main editor, in one isolated undo step. */
export function commitMarkdownEncryptedRegion(view: EditorView, snapshot: Text, range: { from: number; to: number; prefix?: string }, source: string): void {
  if (!view.state.facet(EditorView.editable) || view.state.doc !== snapshot) throw new Error("Encrypted region changed");
  view.dispatch({ changes: { from: range.from, to: range.to, insert: encryptedBlockFence(source, range.prefix) }, selection: { anchor: range.from }, annotations: isolateHistory.of("full") });
}
