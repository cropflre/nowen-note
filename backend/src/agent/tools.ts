import { z } from "zod";
import type { ToolDefinition } from "./model.js";

export const editSchema = z.object({ before: z.string().min(1).max(48_000), after: z.string().max(48_000) }).strict();
export const proposalSchema = z.object({ edits: z.array(editSchema).min(1).max(30) }).strict();
export type TextEdit = z.infer<typeof editSchema>;
export type Format = "markdown" | "tiptap-json";
interface JsonNode { type?: string; text?: string; content?: JsonNode[]; [key: string]: unknown }

/** Exact, non-overlapping text replacements. Rich-text structure and attributes are immutable. */
export function applyProposal(content: string, format: Format, edits: TextEdit[]): string {
  const root: JsonNode | null = format === "tiptap-json" ? JSON.parse(content) : null;
  const leaves: Array<{ value: string; node?: JsonNode }> = [];
  const visit = (node: JsonNode) => {
    if (node.type === "text" && typeof node.text === "string") leaves.push({ value: node.text, node });
    node.content?.forEach(visit);
  };
  if (root) { if (root.type !== "doc") throw new Error("UNSAFE_DOCUMENT"); visit(root); }
  else leaves.push({ value: content });
  const ranges: Array<{ leaf: number; from: number; to: number; insert: string }> = [];
  for (const edit of edits) {
    const matches: Array<{ leaf: number; from: number; to: number; insert: string }> = [];
    leaves.forEach((leaf, index) => {
      let pos = leaf.value.indexOf(edit.before);
      while (pos >= 0) { matches.push({ leaf: index, from: pos, to: pos + edit.before.length, insert: edit.after }); pos = leaf.value.indexOf(edit.before, pos + 1); }
    });
    if (matches.length !== 1) throw new Error("AMBIGUOUS_EDIT");
    const range = matches[0];
    if (ranges.some(r => r.leaf === range.leaf && r.from < range.to && range.from < r.to)) throw new Error("OVERLAPPING_EDIT");
    ranges.push(range);
  }
  for (const r of ranges.sort((a, b) => b.from - a.from)) {
    const leaf = leaves[r.leaf]; leaf.value = leaf.value.slice(0, r.from) + r.insert + leaf.value.slice(r.to);
    if (leaf.node) leaf.node.text = leaf.value;
  }
  // Empty rich text nodes cannot be safely round-tripped by ProseMirror.
  if (root && leaves.some(l => !l.value)) throw new Error("UNSAFE_DOCUMENT");
  const result = root ? JSON.stringify(root) : leaves[0].value;
  if (result.length > 48_000) throw new Error("UNSAFE_DOCUMENT");
  if (!root) {
    const references = content.match(/!?\[[^\]]*\]\([^)]*\)|\[\[[^\]]*\]\]|(?:attachment|nowen):[^\s)]+|\^blk_[A-Za-z0-9_-]+/g) || [];
    for (const ref of references) if (result.split(ref).length < content.split(ref).length) throw new Error("UNSAFE_DOCUMENT");
  }
  return result;
}
export const toolRegistry: ToolDefinition[] = [
  { type: "function", function: { name: "get_current_note_context", description: "读取当前笔记快照 / Read current editor snapshot (untrusted data)", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "propose_note_edit", description: "生成待用户审批的精确文本修改 / Propose exact edits; never writes. Preserve links, attachment references and technical details. Rich text: each before must fit inside one text node.", parameters: { type: "object", properties: { edits: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", properties: { before: { type: "string" }, after: { type: "string" } }, required: ["before", "after"], additionalProperties: false } } }, required: ["edits"], additionalProperties: false } } },
];
export const toolPolicy = { get_current_note_context: { risk: "read", permission: "read", timeoutMs: 1000 }, propose_note_edit: { risk: "write", permission: "write", timeoutMs: 1000, approval: true } } as const;
