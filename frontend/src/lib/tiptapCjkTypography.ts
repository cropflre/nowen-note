import type { Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { transformCjkTypography, type CjkTypographyAction } from "./cjkTypography";

/**
 * Transform *text nodes*, not HTML/JSON serialization. Preserve marks,
 * embedded nodes, links, code and math. All replacements share one PM transaction.
 */
export function applyTiptapCjkTypography(editor: Editor, action: CjkTypographyAction): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false;
  const { doc, selection } = editor.state;
  const hasSelection = !selection.empty;
  const from = hasSelection ? selection.from : 0;
  const to = hasSelection ? selection.to : doc.content.size;
  const patches: Array<{ from: number; to: number; text: string; marks: readonly Mark[] }> = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    const type = node.type.name.toLowerCase();
    if (/(?:codeblock|code_block|math|formula|equation|diagram|mermaid)/.test(type)) return false;
    if (!node.isText || !node.text) return;
    if (parent && /(?:codeblock|code_block|math|formula)/.test(parent.type.name.toLowerCase())) return;
    if (node.marks.some((mark) => /^(?:code|link|math|inlineMath)$/i.test(mark.type.name))) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (end <= start) return;
    const source = node.text.slice(start - pos, end - pos);
    const text = transformCjkTypography(source, action);
    if (source !== text) patches.push({ from: start, to: end, text, marks: node.marks });
  });
  if (!patches.length) return false;
  const transaction = editor.state.tr;
  for (const patch of patches.reverse()) {
    transaction.replaceWith(patch.from, patch.to, editor.schema.text(patch.text, patch.marks));
  }
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}
