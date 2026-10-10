import type { Content, Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

/** Insert after a selected embed atom; replacing it requires an explicit delete action. */
export function insertContentPreservingBlockEmbed(editor: Editor, content: Content): boolean {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "blockEmbed") {
    return editor.chain().focus().insertContentAt(selection.to, content).run();
  }
  return editor.chain().focus().insertContent(content).run();
}
