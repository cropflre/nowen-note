import type { Editor } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { markdownToHtml, tiptapJsonToMarkdown } from "@/lib/contentFormat";
import { isEncryptedBlockLanguage } from "@/lib/encryptedNotes/blockDocument";
import { projectMarkdownForUser } from "@/lib/markdownUserContent";
import { sanitizeForPaste } from "@/lib/sanitizeHtml";
import { EDITOR_ACTION_MAX_INPUT_BYTES, utf8Bytes } from "./registry";
import type { EditorActionAdapter, EditorActionSnapshot } from "./types";

/** Same serialization as the AI writing assistant, so plugins see links, images and marks as Markdown. */
function serialize(doc: ProseMirrorNode, from: number, to: number): string {
  if (from >= to) return "";
  try { return tiptapJsonToMarkdown(doc.cut(from, to).toJSON()).trim(); } catch { return doc.textBetween(from, to, "\n").trim(); }
}

function isEncryptedNode(node: ProseMirrorNode): boolean {
  return node.type.name === "codeBlock" && isEncryptedBlockLanguage(node.attrs.language);
}

function touchesEncryptedBlock(doc: ProseMirrorNode, from: number, to: number): boolean {
  const $from = doc.resolve(from);
  for (let depth = $from.depth; depth > 0; depth -= 1) if (isEncryptedNode($from.node(depth))) return true;
  let hit = false;
  if (from < to) doc.nodesBetween(from, to, (node) => { if (isEncryptedNode(node)) hit = true; return !hit; });
  return hit;
}

/** Leading/trailing whitespace inside one textblock stays where it is. */
function trimRange(doc: ProseMirrorNode, from: number, to: number): { from: number; to: number } {
  if (from >= to) return { from, to };
  const $from = doc.resolve(from), $to = doc.resolve(to);
  if ($from.parent !== $to.parent || !$from.parent.isTextblock) return { from, to };
  const text = doc.textBetween(from, to, "\n", "￼");
  const lead = text.length - text.trimStart().length, trail = text.length - text.trimEnd().length;
  return lead + trail >= text.length ? { from, to: from } : { from: from + lead, to: to - trail };
}

/** One line without Markdown syntax: inserted as text so spacing and the surrounding marks are kept. */
function isPlainLine(markdown: string): boolean {
  return !markdown.includes("\n") && !/[*_`~#>[\]!|<\\$^]/.test(markdown) && !/^\s*(?:[-+]\s|\d+[.)]\s)/.test(markdown);
}

/** Parses untrusted Markdown like a paste: sanitized HTML in an inert document, then the editor schema. */
function parseMarkdown(editor: Editor, markdown: string) {
  const html = sanitizeForPaste(markdownToHtml(markdown));
  const body = new window.DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html").body;
  return { parser: ProseMirrorDOMParser.fromSchema(editor.schema), body };
}

export function createTiptapEditorActionAdapter(editor: Editor, getNoteId: () => string): EditorActionAdapter {
  return {
    kind: "tiptap",
    isComposing: () => !editor.isDestroyed && editor.view.composing,
    hasSelection: () => {
      if (editor.isDestroyed) return false;
      const { from, to } = editor.state.selection;
      return from < to && editor.state.doc.textBetween(from, to, "\n", "￼").trim().length > 0;
    },
    focus: () => { if (!editor.isDestroyed) editor.commands.focus(); },
    capture() {
      if (editor.isDestroyed) return { error: "NOT_READY" };
      const { doc, selection } = editor.state;
      const { from, to } = trimRange(doc, selection.from, selection.to);
      if (touchesEncryptedBlock(doc, from, to)) return { error: "ENCRYPTED_REGION" };
      const original = serialize(doc, from, to);
      const text = projectMarkdownForUser(original);
      if (utf8Bytes(text) > EDITOR_ACTION_MAX_INPUT_BYTES) return { error: "TOO_LARGE" };
      const noteId = getNoteId();
      const range = { from, to, alive: true };
      // Follow local, collaborative and undo edits so the result never lands on stale coordinates.
      const follow = ({ transaction }: { transaction: Transaction }) => {
        if (!transaction.docChanged || !range.alive) return;
        if (range.from === range.to) {
          const mapped = transaction.mapping.mapResult(range.from, -1);
          if (mapped.deleted) range.alive = false;
          range.from = range.to = mapped.pos;
          return;
        }
        const start = transaction.mapping.map(range.from, 1), end = transaction.mapping.map(range.to, -1);
        range.from = start; range.to = Math.max(start, end);
      };
      editor.on("transaction", follow);
      let released = false;
      const snapshot: EditorActionSnapshot = {
        kind: "tiptap",
        noteId,
        text,
        original,
        hasSelection: from < to,
        apply(markdown, mode) {
          if (released || editor.isDestroyed || !editor.isEditable || getNoteId() !== noteId || !range.alive) return "conflict";
          const state = editor.state;
          if (range.to > state.doc.content.size) return "conflict";
          if (mode === "replace" && serialize(state.doc, range.from, range.to) !== original) return "conflict";
          const from = mode === "replace" ? range.from : range.to, to = range.to;
          if (touchesEncryptedBlock(state.doc, from, to)) return "conflict";
          const $from = state.doc.resolve(from);
          const tr = state.tr;
          let end = to;
          if ($from.parent.type.spec.code || isPlainLine(markdown)) {
            tr.insertText(markdown, from, to);
          } else {
            const { parser, body } = parseMarkdown(editor, markdown);
            if (mode === "insert" && markdown.trim().includes("\n") && $from.parent.isTextblock && $from.depth > 0) {
              // Block results go after the current block (or replace it when it is empty).
              const empty = $from.parent.content.size === 0;
              const start = empty ? $from.before() : $from.after();
              end = $from.after();
              tr.replaceRange(start, end, new Slice(parser.parse(body).content, 0, 0));
            } else {
              tr.replaceRange(from, to, parser.parseSlice(body));
            }
          }
          const caret = Math.min(tr.mapping.map(end, 1), tr.doc.content.size);
          tr.setSelection(TextSelection.near(tr.doc.resolve(caret), -1));
          editor.view.dispatch(tr.scrollIntoView());
          return "applied";
        },
        release() {
          if (released) return;
          released = true; range.alive = false;
          editor.off("transaction", follow);
        },
      };
      return snapshot;
    },
  };
}
