import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type { NoteLinkEntry } from "../repositories/types.js";
import type { NoteBlockIndexRow, NoteBlockType } from "./noteBlocks.js";
import type { IncrementalPatchIndexPlan } from "./blockPatchIncrementalIndexes.js";
import type { TiptapBlockPatchOperation } from "./tiptapBlockPatch.js";
import type { TiptapListItemStructuralOperation } from "./tiptapListItemStructure.js";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LEAF_BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const LIST_ITEM_TYPES = new Set(["listItem", "taskItem"]);
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

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

type ListStructureOperation = TiptapListItemStructuralOperation
  | Extract<TiptapBlockPatchOperation, { type: "lift" }>;

function listStructureOperations(operations: unknown[]): ListStructureOperation[] | null {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) return null;
  const scoped: ListStructureOperation[] = [];
  let listMoveCount = 0;
  for (const candidate of operations as any[]) {
    if (!candidate || typeof candidate !== "object") return null;
    if ((candidate.type === "create" || candidate.type === "delete") && candidate.scope === "listItem") {
      if (candidate.type === "create") {
        if (
          !validBlockId(candidate.blockId)
          || !validBlockId(candidate.targetBlockId)
          || !["before", "after"].includes(candidate.position)
        ) return null;
      } else if (!validBlockId(candidate.blockId)) {
        return null;
      }
      scoped.push(candidate as TiptapListItemStructuralOperation);
      continue;
    }
    if (candidate.type === "lift" && candidate.scope === "listItem") {
      if (!validBlockId(candidate.blockId) || !["before", "after"].includes(candidate.position)) return null;
      scoped.push(candidate as ListStructureOperation);
      continue;
    }
    if (candidate.type === "update" || candidate.type === "replace") continue;
    if (candidate.type === "move" && candidate.scope === "listItem") {
      listMoveCount += 1;
      continue;
    }
    return null;
  }
  return scoped.length > 0 || listMoveCount > 1 ? scoped : null;
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
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return null;

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

function rowsMirrorAnalysis(existing: ExistingIndexRow[], analysis: TiptapAnalysis): boolean {
  if (existing.length !== analysis.blocks.length) return false;
  const existingById = new Map(existing.map((row) => [row.blockId, row]));
  if (existingById.size !== analysis.blocks.length) return false;
  return analysis.blocks.every(({ row }) => {
    const previous = existingById.get(row.blockId);
    return Boolean(previous
      && previous.blockType === row.blockType
      && previous.parentBlockId === row.parentBlockId
      && previous.blockOrder === row.blockOrder
      && previous.plainText === row.plainText
      && previous.contentHash === row.contentHash
      && previous.path === row.path);
  });
}

function collectAncestorIds(
  rowsById: Map<string, { parentBlockId: string | null }>,
  startIds: string[],
): Set<string> {
  const output = new Set<string>();
  for (const startId of startIds) {
    let current: string | null = startId;
    while (current && !output.has(current)) {
      output.add(current);
      current = rowsById.get(current)?.parentBlockId || null;
    }
  }
  return output;
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
    addLink(links, seen, {
      targetNoteId: match[1].toLowerCase(),
      targetBlockId: match[2] || null,
      sourceBlockId,
      linkType: match[2] ? "block" : "note",
      linkText: match[3] || null,
      excerpt: excerpt || match[3] || null,
    });
  }
  for (const match of text.matchAll(NOTE_HREF_RE)) {
    addLink(links, seen, {
      targetNoteId: match[1].toLowerCase(),
      targetBlockId: match[2] || null,
      sourceBlockId,
      linkType: match[2] ? "block" : "note",
      linkText: null,
      excerpt,
    });
  }
}

function extractLinks(node: any, sourceBlockId: string, plainText: string): NoteLinkEntry[] {
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

function filterExistingTargets(
  db: Database.Database,
  noteId: string,
  links: NoteLinkEntry[],
): NoteLinkEntry[] {
  const targetExists = db.prepare("SELECT id FROM notes WHERE id = ?");
  return links.filter(
    (link) => !(link.targetNoteId === noteId.toLowerCase() && !link.targetBlockId)
      && Boolean(targetExists.get(link.targetNoteId)),
  );
}

/** Allow normalization bypass when a bounded list batch starts from an exact index mirror. */
export function canUseIncrementalListStructureIndexes(
  db: Database.Database,
  noteId: string,
  content: string,
  operations: unknown[],
): boolean {
  const scoped = listStructureOperations(operations);
  if (!scoped) return false;
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis || !rowsMirrorAnalysis(loadExistingRows(db, noteId), analysis)) return false;
  const knownItems = new Set(
    analysis.blocks
      .map(({ row }) => row)
      .filter((row) => LIST_ITEM_TYPES.has(row.blockType))
      .map((row) => row.blockId),
  );
  for (const operation of scoped) {
    if (operation.type === "create") {
      if (!knownItems.has(operation.targetBlockId) || knownItems.has(operation.blockId)) return false;
      knownItems.add(operation.blockId);
    } else {
      if (!knownItems.has(operation.blockId)) return false;
      knownItems.delete(operation.blockId);
    }
  }
  return true;
}

/** Build a minimal post-patch plan for a scoped list batch, including split content changes. */
export function planIncrementalListStructureIndexes(
  db: Database.Database,
  noteId: string,
  content: string,
  operations: unknown[],
): IncrementalPatchIndexPlan | null {
  const scoped = listStructureOperations(operations);
  if (!scoped) return null;
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis) return null;

  const existing = loadExistingRows(db, noteId);
  const existingById = new Map(existing.map((row) => [row.blockId, row]));
  const postIds = new Set(analysis.blocks.map(({ row }) => row.blockId));
  const addedIds = analysis.blocks.map(({ row }) => row.blockId).filter((id) => !existingById.has(id));
  const deletedIds = existing.map((row) => row.blockId).filter((id) => !postIds.has(id));

  const expectedIds = new Set(existing.map((row) => row.blockId));
  const createdParagraphByItem = new Map<string, string>();
  const liftedParagraphIds = new Set<string>();
  for (const operation of scoped) {
    if (operation.type === "create") {
      const paragraphId = (operation.node as any)?.content?.[0]?.attrs?.blockId;
      if (!validBlockId(paragraphId) || paragraphId === operation.blockId) return null;
      if (expectedIds.has(operation.blockId) || expectedIds.has(paragraphId)) return null;
      expectedIds.add(operation.blockId);
      expectedIds.add(paragraphId);
      createdParagraphByItem.set(operation.blockId, paragraphId);
      continue;
    }
    if (!expectedIds.has(operation.blockId)) return null;
    const paragraphId = createdParagraphByItem.get(operation.blockId)
      || existing.find((row) => row.parentBlockId === operation.blockId && row.blockType === "paragraph")?.blockId;
    if (!paragraphId || !expectedIds.has(paragraphId)) return null;
    expectedIds.delete(operation.blockId);
    if (operation.type === "lift") liftedParagraphIds.add(paragraphId);
    else expectedIds.delete(paragraphId);
  }
  const expectedAdded = [...expectedIds].filter((id) => !existingById.has(id));
  const expectedDeleted = existing.map((row) => row.blockId).filter((id) => !expectedIds.has(id));
  if (
    expectedAdded.length !== addedIds.length
    || expectedAdded.some((id) => !addedIds.includes(id))
    || expectedDeleted.length !== deletedIds.length
    || expectedDeleted.some((id) => !deletedIds.includes(id))
  ) return null;

  for (const operation of scoped.filter((candidate) => candidate.type === "create")) {
    const item = analysis.byId.get(operation.blockId)?.row;
    const paragraphId = createdParagraphByItem.get(operation.blockId);
    const paragraph = paragraphId ? analysis.byId.get(paragraphId)?.row : null;
    if (
      !item
      || !paragraph
      || !LIST_ITEM_TYPES.has(item.blockType)
      || paragraph.blockType !== "paragraph"
      || paragraph.parentBlockId !== item.blockId
    ) return null;
  }

  const existingParentMap = new Map(existing.map((row) => [row.blockId, { parentBlockId: row.parentBlockId }]));
  const postParentMap = new Map(analysis.blocks.map(({ row }) => [row.blockId, { parentBlockId: row.parentBlockId }]));
  const changedLeafIds = new Set(
    (operations as TiptapBlockPatchOperation[])
      .filter((operation) => operation.type === "update" || operation.type === "replace")
      .map((operation) => operation.blockId),
  );
  const movedItemIds = new Set(
    (operations as TiptapBlockPatchOperation[])
      .filter((operation) => operation.type === "move" && operation.scope === "listItem")
      .map((operation) => operation.blockId),
  );
  const reparentedIds = new Set([...movedItemIds, ...liftedParagraphIds]);
  const aggregateIds = new Set<string>();
  for (const id of [...addedIds, ...changedLeafIds, ...movedItemIds]) {
    collectAncestorIds(postParentMap, [id]).forEach((ancestor) => aggregateIds.add(ancestor));
  }
  for (const id of deletedIds) {
    collectAncestorIds(existingParentMap, [id]).forEach((ancestor) => aggregateIds.add(ancestor));
  }

  const affectedRows: NoteBlockIndexRow[] = [];
  for (const { row } of analysis.blocks) {
    const previous = existingById.get(row.blockId);
    if (!previous) {
      affectedRows.push(row);
      continue;
    }
    const contentChanged = previous.blockType !== row.blockType
      || previous.plainText !== row.plainText
      || previous.contentHash !== row.contentHash;
    const parentChanged = previous.parentBlockId !== row.parentBlockId;
    const orderChanged = previous.blockOrder !== row.blockOrder;
    const pathChanged = previous.path !== row.path;

    if (contentChanged && LEAF_BLOCK_TYPES.has(row.blockType) && !changedLeafIds.has(row.blockId)) return null;
    if (contentChanged && !aggregateIds.has(row.blockId)) return null;
    if (parentChanged && !reparentedIds.has(row.blockId)) return null;
    if (contentChanged || orderChanged || pathChanged) affectedRows.push(row);
  }

  const linkBlockIds = [...new Set([...addedIds, ...deletedIds, ...changedLeafIds])];
  const links: NoteLinkEntry[] = [];
  for (const blockId of [...addedIds, ...changedLeafIds]) {
    const block = analysis.byId.get(blockId);
    if (!block || !LEAF_BLOCK_TYPES.has(block.row.blockType)) continue;
    links.push(...extractLinks(block.node, blockId, block.row.plainText));
  }

  return {
    mode: "incremental",
    kind: changedLeafIds.size > 0 ? "mixed" : "structural",
    contentText: analysis.contentText,
    affectedRows,
    deletedBlockIds: deletedIds,
    links: filterExistingTargets(db, noteId, links),
    indexedBlockIds: [...new Set([...deletedIds, ...affectedRows.map((row) => row.blockId)])],
    linkBlockIds,
  };
}
