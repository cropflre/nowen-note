import type { Editor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { isEditorDocumentMutable } from "@/lib/codeBlockPermissions";
import { CodeBlockFormatError, formatCodeBlock } from "@/lib/codeBlockFormatting";

export async function formatTiptapCodeBlock(editor: Editor, getPos: () => number | undefined): Promise<void> {
  if (!isEditorDocumentMutable(editor)) throw new CodeBlockFormatError("readOnly");
  const pos = getPos();
  const originalDoc = editor.view.state.doc;
  const original = typeof pos === "number" ? originalDoc.nodeAt(pos) : null;
  if (original?.type.name !== "codeBlock") throw new CodeBlockFormatError("changed");
  const formatted = await formatCodeBlock(original.textContent, original.attrs.language || "auto");
  if (!isEditorDocumentMutable(editor)) throw new CodeBlockFormatError("readOnly");
  let currentPos;
  try { currentPos = getPos(); } catch { throw new CodeBlockFormatError("changed"); }
  const view = editor.view;
  const current = typeof currentPos === "number" ? view.state.doc.nodeAt(currentPos) : null;
  if (view.state.doc !== originalDoc || !current || !original.eq(current)) throw new CodeBlockFormatError("changed");
  if (formatted === current.textContent) return;
  const tr = closeHistory(view.state.tr).replaceWith(
    currentPos! + 1, currentPos! + current.nodeSize - 1, view.state.schema.text(formatted),
  );
  view.dispatch(tr);
  view.focus();
}
