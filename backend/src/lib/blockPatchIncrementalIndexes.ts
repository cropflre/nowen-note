import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";

import type { NoteLinkEntry } from "../repositories/types.js";
import type { NoteBlockIndexRow, NoteBlockType } from "./noteBlocks.js";
import type { TiptapBlockPatchOperation } from "./tiptapBlockPatch.js";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LEAF_BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const INDEXED_BLOCK_TYPES = new Set([
  "heading",
  "paragraph",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
]);
const NOTE_LINK_RE = /\[\[note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#blk:([a-zA-Z0-9_-]+))?(?:\|([^\]]*))?\]\]/g;
const NOTE_HREF_RE = /note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#blk:([a-zA-Z0-9_-]+))?/g;

type LeafPatchOperation = Extract<
  TiptapBlockPatchOperation,
  { type: "update" | "replace" }
>;

interface ExistingIndexRow {
  blockId: string;
  blockType: string;
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  contentHash: string;
  path: string;
}

interface AnalyzedBlock {
  row: NoteBlockIndexRow;
  node: any;
}

interface TiptapAnalysis {
  blocks: AnalyzedBlock[];
  byId: Map<string, AnalyzedBlock>;
  contentText: string;
}

export interface IncrementalPatchIndexPlan {
  mode: "incremental";
  contentText: string;
  affectedRows: NoteBlockIndexRow[];
  links: NoteLinkEntry[];
  /** Rows rewritten in note_blocks_index, including indexed ancestors with aggregate text. */
  indexedBlockIds: string[];
  /** Source Block rows whose note_links entries are replaced. */
  linkBlockIds: string[];
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

function analyzeTiptap(noteId: string, content: string): TiptapAnalysis | null {
  let doc: any;
  try {
    doc = JSON.parse(content || "{}");
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.type !== "doc" || !Array.isArray(doc.content)) {
    return null;
  }

  const blocks: AnalyzedBlock[] = [];
  const byId = new Map<string, AnalyzedBlock>();
  let order = 0;
  let invalid = false;

  const visit = (nodes: any[], parentBlockId: string | null, parentPath: number[]) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node || typeof node !== "object") continue;
      const path = [...parentPath, index];
      let nextParent = parentBlockId;

      if (INDEXED_BLOCK_TYPES.has(node.type)) {
        const blockId = node.attrs?.blockId;
        if (!validBlockId(blockId) || byId.has(blockId)) {
          invalid = true;
          return;
        }
        const plainText = collectNodeText(node).replace(/\u0000/g, "").trim();
        const analyzed: AnalyzedBlock = {
          row: {
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
          },
          node,
        };
        order += 1;
        blocks.push(analyzed);
        byId.set(blockId, analyzed);
        nextParent = blockId;
      }

      if (Array.isArray(node.content)) {
        visit(node.content, nextParent, path);
        if (invalid) return;
      }
    }
  };

  visit(doc.content, null, []);
  if (invalid) return null;
  return {
    blocks,
    byId,
    contentText: blocks.map(({ row }) => row.plainText).filter(Boolean).join("\n\n"),
  };
}

function loadExistingRows(db: Database.Database, noteId: string): ExistingIndexRow[] {
  return db.prepare(`
    SELECT blockId, blockType, parentBlockId, blockOrder, plainText, contentHash, path
    FROM note_blocks_index
    WHERE noteId = ?
    ORDER BY blockOrder ASC
  `).all(noteId) as ExistingIndexRow[];
}

function structuresMatch(
  existing: ExistingIndexRow[],
  analysis: TiptapAnalysis,
  ignoredContentIds: Set<string>,
): boolean {
  if (existing.length !== analysis.blocks.length) return false;
  const existingById = new Map(existing.map((row) => [row.blockId, row]));
  if (existingById.size !== analysis.blocks.length) return false;

  for (const { row } of analysis.blocks) {
    const previous = existingById.get(row.blockId);
    if (!previous) return false;
    if (
      previous.parentBlockId !== row.parentBlockId
      || previous.blockOrder !== row.blockOrder
      || previous.path !== row.path
    ) {
      return false;
    }
    if (!ignoredContentIds.has(row.blockId) && (
      previous.blockType !== row.blockType
      || previous.contentHash !== row.contentHash
      || previous.plainText !== row.plainText
    )) {
      return false;
    }
    // Only top-level safe leaf replacements may change block type. Nested replacements are already
    // rejected by the patch engine, and this check keeps the index planner fail-closed as well.
    if (
      ignoredContentIds.has(row.blockId)
      && previous.blockType !== row.blockType
      && row.parentBlockId !== null
    ) {
      return false;
    }
  }
  return true;
}

function addLink(
  links: NoteLinkEntry[],
  seen: Set<string>,
  entry: NoteLinkEntry,
): void {
  const key = `${entry.sourceBlockId || ""}:${entry.targetNoteId}:${entry.targetBlockId || ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  links.push(entry);
}

function entriesFromText(
  text: string,
  sourceBlockId: string,
  excerpt: string | null,
  links: NoteLinkEntry[],
  seen: Set<string>,
): void {
  for (const match of text.matchAll(NOTE_LINK_RE)) {
    const targetNoteId = match[1].toLowerCase();
    const targetBlockId = match[2] || null;
    const displayText = match[3] || null;
    addLink(links, seen, {
      targetNoteId,
      targetBlockId,
      sourceBlockId,
      linkType: targetBlockId ? "block" : "note",
      linkText: displayText,
      excerpt: excerpt || displayText,
    });
  }
  for (const match of text.matchAll(NOTE_HREF_RE)) {
    const targetNoteId = match[1].toLowerCase();
    const targetBlockId = match[2] || null;
    addLink(links, seen, {
      targetNoteId,
      targetBlockId,
      sourceBlockId,
      linkType: targetBlockId ? "block" : "note",
      linkText: null,
      excerpt,
    });
  }
}

function extractLinksFromLeaf(node: any, sourceBlockId: string, plainText: string): NoteLinkEntry[] {
  const links: NoteLinkEntry[] = [];
  const seen = new Set<string>();
  const excerpt = plainText.replace(/\s+/g, " ").trim().slice(0, 240) || null;

  const visit = (candidate: any) => {
    if (!candidate || typeof candidate !== "object") return;
    if (candidate.type === "text") {
      const text = String(candidate.text || "");
      entriesFromText(text, sourceBlockId, excerpt, links, seen);
      for (const mark of Array.isArray(candidate.marks) ? candidate.marks : []) {
        const href = mark?.attrs?.href;
        if (mark?.type === "link" && typeof href === "string" && href.startsWith("note:")) {
          entriesFromText(href, sourceBlockId, excerpt, links, seen);
        }
      }
    }
    for (const child of Array.isArray(candidate.content) ? candidate.content : []) visit(child);
  };

  visit(node);
  return links;
}

function isLeafOnlyPatch(
  operations: TiptapBlockPatchOperation[],
): operations is LeafPatchOperation[] {
  return operations.length > 0 && operations.every(
    (operation) => operation.type === "update" || operation.type === "replace",
  );
}

function collectIndexedAncestors(analysis: TiptapAnalysis, leafBlockIds: string[]): string[] {
  const output = new Set<string>();
  for (const leafBlockId of leafBlockIds) {
    let current: string | null = leafBlockId;
    while (current && !output.has(current)) {
      output.add(current);
      current = analysis.byId.get(current)?.row.parentBlockId || null;
    }
  }
  return analysis.blocks
    .map(({ row }) => row.blockId)
    .filter((blockId) => output.has(blockId));
}

/**
 * Check whether the persisted Block index is a complete structural mirror of the current Tiptap
 * document. This intentionally fails closed: a stale/missing/duplicate ID forces full normalization.
 */
export function canUseIncrementalPatchIndexes(
  db: Database.Database,
  noteId: string,
  content: string,
  operations: TiptapBlockPatchOperation[],
): boolean {
  if (!isLeafOnlyPatch(operations)) return false;
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis) return false;
  const affected = new Set(operations.map((operation) => operation.blockId));
  for (const blockId of affected) {
    const block = analysis.byId.get(blockId);
    if (!block || !LEAF_BLOCK_TYPES.has(block.row.blockType)) return false;
  }
  return structuresMatch(loadExistingRows(db, noteId), analysis, new Set());
}

/** Build a post-patch incremental update plan without mutating persistence. */
export function planIncrementalPatchIndexes(
  db: Database.Database,
  userId: string,
  noteId: string,
  content: string,
  operations: TiptapBlockPatchOperation[],
): IncrementalPatchIndexPlan | null {
  if (!isLeafOnlyPatch(operations)) return null;
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis) return null;
  const linkBlockIds = [...new Set(operations.map((operation) => operation.blockId))];

  for (const blockId of linkBlockIds) {
    const block = analysis.byId.get(blockId);
    if (!block || !LEAF_BLOCK_TYPES.has(block.row.blockType)) return null;
  }
  const indexedBlockIds = collectIndexedAncestors(analysis, linkBlockIds);
  const ignoredContentIds = new Set(indexedBlockIds);
  if (!structuresMatch(loadExistingRows(db, noteId), analysis, ignoredContentIds)) return null;

  const links = linkBlockIds.flatMap((blockId) => {
    const block = analysis.byId.get(blockId) as AnalyzedBlock;
    return extractLinksFromLeaf(block.node, blockId, block.row.plainText)
      .filter((link) => !(link.targetNoteId === noteId.toLowerCase() && !link.targetBlockId));
  });

  // Filter nonexistent targets using the same existence rule as full link sync. ACL is checked when
  // backlinks are read, so this does not disclose private targets to the patching client.
  const targetExists = db.prepare("SELECT id FROM notes WHERE id = ?");
  const validLinks = links.filter((link) => Boolean(targetExists.get(link.targetNoteId)));
  void userId;

  return {
    mode: "incremental",
    contentText: analysis.contentText,
    affectedRows: indexedBlockIds.map((blockId) => (analysis.byId.get(blockId) as AnalyzedBlock).row),
    links: validLinks,
    indexedBlockIds,
    linkBlockIds,
  };
}

/** Apply one previously validated incremental plan inside the caller's SQLite transaction. */
export function applyIncrementalPatchIndexes(
  db: Database.Database,
  userId: string,
  noteId: string,
  plan: IncrementalPatchIndexPlan,
): void {
  const upsert = db.prepare(`
    INSERT INTO note_blocks_index (
      noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
      contentHash, path, startOffset, endOffset, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(noteId, blockId) DO UPDATE SET
      blockType = excluded.blockType,
      parentBlockId = excluded.parentBlockId,
      blockOrder = excluded.blockOrder,
      plainText = excluded.plainText,
      contentHash = excluded.contentHash,
      path = excluded.path,
      startOffset = excluded.startOffset,
      endOffset = excluded.endOffset,
      updatedAt = datetime('now')
  `);
  for (const row of plan.affectedRows) {
    upsert.run(
      row.noteId,
      row.blockId,
      row.blockType,
      row.parentBlockId,
      row.blockOrder,
      row.plainText,
      row.contentHash,
      row.path,
      row.startOffset,
      row.endOffset,
    );
  }

  const placeholders = plan.linkBlockIds.map(() => "?").join(",");
  db.prepare(`
    DELETE FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId IN (${placeholders})
  `).run(noteId, ...plan.linkBlockIds);

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO note_links (
      id, userId, sourceNoteId, targetNoteId, targetBlockId, sourceBlockId,
      linkType, linkText, excerpt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  for (const link of plan.links) {
    insertLink.run(
      uuid(),
      userId,
      noteId,
      link.targetNoteId,
      link.targetBlockId,
      link.sourceBlockId,
      link.linkType,
      link.linkText,
      link.excerpt,
    );
  }
}
