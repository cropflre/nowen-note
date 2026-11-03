import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { aiProvenanceParagraph, markAiMarkdown, type AiProvenance } from "./aiContentProvenance";
export interface AgentEdit { before: string; after: string }
export interface AgentProposal { original: string; result: string; format: "markdown" | "tiptap-json"; edits: AgentEdit[]; token: string }
export interface AgentRun { id: string; noteId: string; status: string; errorCode?: string | null; steps: Array<{ sequence: number; toolName: string; status: string }>; proposal?: AgentProposal }
export function sameAgentSnapshot(a: string, b: string, format: string): boolean {
  try { return format === "tiptap-json" ? JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) : a === b; } catch { return false; }
}
/** Validate every range before dispatching a single undoable transaction. */
export function agentTextRanges(parts: Array<{ text: string; pos: number }>, edits: AgentEdit[]) {
  const ranges: Array<{ from: number; to: number; insert: string; part: number }> = [];
  if (parts.length === 1 && parts[0].text === "" && edits.length === 1 && edits[0].before === "" && edits[0].after.trim()) {
    return [{ from: parts[0].pos, to: parts[0].pos, insert: edits[0].after, part: 0 }];
  }
  for (const edit of edits) {
    if (!edit.before) throw new Error("INVALID_TOOL_ARGUMENTS");
    const matches: typeof ranges = [];
    parts.forEach((part, index) => {
      let from = part.text.indexOf(edit.before);
      while (from >= 0) { matches.push({ from: part.pos + from, to: part.pos + from + edit.before.length, insert: edit.after, part: index }); from = part.text.indexOf(edit.before, from + 1); }
    });
    if (matches.length !== 1) throw new Error("AMBIGUOUS_EDIT");
    const range = matches[0];
    if (ranges.some(r => r.from < range.to && range.from < r.to)) throw new Error("OVERLAPPING_EDIT");
    ranges.push(range);
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/** The declaration and proposed replacements share one editor transaction. */
export function agentMarkdownChanges(original: string, edits: AgentEdit[], provenance?: AiProvenance) {
  const changes = agentTextRanges([{ text: original, pos: 0 }], edits).map(({ from, to, insert }) => ({ from, to, insert }));
  if (provenance) {
    const prefix = markAiMarkdown("", provenance) + "\n\n";
    if (changes[0]?.from === 0) changes[0].insert = prefix + changes[0].insert;
    else changes.unshift({ from: 0, to: 0, insert: prefix });
  }
  return changes;
}

export function applyAgentTiptapChanges(editor: Editor, edits: AgentEdit[], provenance?: AiProvenance): void {
  const parts: Array<{ text: string; pos: number; marks: readonly import("@tiptap/pm/model").Mark[] }> = [];
  editor.state.doc.descendants((node, pos) => { if (node.isText) parts.push({ text: node.text!, pos, marks: node.marks }); });
  if (editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.type.name === "paragraph" && editor.state.doc.firstChild.content.size === 0) {
    parts.push({ text: "", pos: 1, marks: [] });
  }
  const ranges = agentTextRanges(parts, edits);
  const tr = editor.state.tr;
  for (const range of ranges.reverse()) {
    if (range.insert) tr.replaceWith(range.from, range.to, editor.schema.text(range.insert, parts[range.part].marks));
    else tr.delete(range.from, range.to);
  }
  if (provenance) tr.insert(0, editor.schema.nodeFromJSON(aiProvenanceParagraph(provenance)));
  editor.view.dispatch(closeHistory(tr));
  editor.view.dispatch(closeHistory(editor.state.tr));
}
