import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { history as createHistory } from "@tiptap/pm/history";
import { ENCRYPTED_BLOCK_LANGUAGE, readEncryptedBlock } from "./blockDocument";
import { validateEncryptedNotePlaintext } from "./noteDocument";

/** Keep the selected rich-text structure in the temporary editor, including basic marks. */
export function prepareTiptapSelectionEncryption(editor: Editor) {
  const { selection, doc } = editor.state;
  if (!editor.isEditable || editor.isDestroyed || selection.empty || !(selection instanceof TextSelection)) throw new Error("Select editable text");
  const content = selection.content().content.toJSON();
  const plaintext = JSON.stringify({ type: "doc", content });
  validateEncryptedNotePlaintext(plaintext, "tiptap-json");
  let unsupported = false;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === "codeBlock") unsupported = true;
  });
  if (unsupported || !doc.textBetween(selection.from, selection.to).trim()) throw new Error("Select ordinary text");
  return { plaintext, format: "tiptap-json" as const, commit: (source: string) => {
    readEncryptedBlock(source);
    if (editor.isDestroyed || !editor.isEditable || editor.state.doc !== doc) throw new Error("Encrypted selection changed");
    // Reinitialise only the history plugin so undo cannot restore the selected plaintext.
    const history = editor.state.plugins.find((plugin) => plugin.spec.key === createHistory().spec.key);
    if (!history) throw new Error("Editor history unavailable");
    const node = editor.schema.nodes.codeBlock.create({ language: ENCRYPTED_BLOCK_LANGUAGE }, editor.schema.text(source));
    const transaction = editor.state.tr.replaceRangeWith(selection.from, selection.to, node).setMeta("addToHistory", false);
    editor.view.dispatch(transaction);
    const plugins = editor.state.plugins;
    editor.view.updateState(editor.state.reconfigure({ plugins: plugins.filter((plugin) => plugin !== history) }));
    editor.view.updateState(editor.state.reconfigure({ plugins }));
  } };
}
