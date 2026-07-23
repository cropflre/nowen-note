import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";

import type { NoteBlockIndexRow, NoteBlockType } from "./noteBlocks";

const SUPPORTED = new Set<string>([
  "heading",
  "paragraph",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
]);
const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;

export interface TiptapBlockIndexPlan {
  content: string;
  contentText: string;
  rows: NoteBlockIndexRow[];
  changed: boolean;
}

function makeBlockId(): string {
  return `blk_${uuid()}`;
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function collectNodeText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.text || "");
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  return node.content.map(collectNodeText).join("");
}

function hashText(type: string, text: string): string {
  return createHash("sha256")
    .update(type)
    .update("\0")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex");
}

/**
 * Build the authoritative Tiptap Block index without touching a database.
 *
 * The title-rewrite runtime only handles Tiptap sources. Missing or duplicate
 * Block IDs are normalized exactly like the SQLite indexer so the caller can
 * persist notes.content, note_blocks_index and note_links in one transaction.
 */
export function buildTiptapBlockIndexPlan(
  noteId: string,
  content: string,
): TiptapBlockIndexPlan | null {
  let doc: any;
  try {
    doc = JSON.parse(content || "{}");
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.type !== "doc" || !Array.isArray(doc.content)) {
    return null;
  }

  const rows: NoteBlockIndexRow[] = [];
  const seen = new Set<string>();
  let order = 0;
  let changed = false;

  const visit = (nodes: any[], parentBlockId: string | null, parentPath: number[]) => {
    nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") return;
      const path = [...parentPath, index];
      let nextParent = parentBlockId;

      if (SUPPORTED.has(node.type)) {
        const attrs = node.attrs && typeof node.attrs === "object" ? { ...node.attrs } : {};
        let blockId = validBlockId(attrs.blockId) ? attrs.blockId : null;
        if (!blockId || seen.has(blockId)) {
          blockId = makeBlockId();
          attrs.blockId = blockId;
          node.attrs = attrs;
          changed = true;
        }
        seen.add(blockId);
        const plainText = collectNodeText(node).replace(/\u0000/g, "").trim();
        rows.push({
          noteId,
          blockId,
          blockType: node.type as NoteBlockType,
          parentBlockId,
          blockOrder: order,
          plainText,
          contentHash: hashText(node.type, plainText),
          path: path.join("."),
          startOffset: null,
          endOffset: null,
        });
        order += 1;
        nextParent = blockId;
      }

      if (Array.isArray(node.content)) visit(node.content, nextParent, path);
    });
  };

  visit(doc.content, null, []);
  const normalized = changed ? JSON.stringify(doc) : content;
  return {
    content: normalized,
    contentText: rows.map((row) => row.plainText).filter(Boolean).join("\n\n"),
    rows,
    changed,
  };
}
