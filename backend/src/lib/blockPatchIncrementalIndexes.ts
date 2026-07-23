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
type StructuralPatchOperation = Extract<
  TiptapBlockPatchOperation,
  { type: "create" | "delete" | "move" }
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

interface StructuralDelta {
  existing: ExistingIndexRow[];
  existingById: Map<string, ExistingIndexRow>;
  addedBlockIds: string[];
  deletedBlockIds: string[];
}

interface PatchGroups {
  leaf: LeafPatchOperation[];
  structural: StructuralPatchOperation[];
}

export interface IncrementalPatchIndexPlan {
  mode: "incremental";
  kind: "leaf" | "structural" | "mixed";
  contentText: string;
  affectedRows: NoteBlockIndexRow[];
  deletedBlockIds: string[];
  links: NoteLinkEntry[];
  /** Block IDs inserted, updated or deleted in note_blocks_index. */
  indexedBlockIds: string[];
  /** Source Block rows whose note_links entries are replaced or deleted. */
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

function splitOperations(operations: TiptapBlockPatchOperation[]): PatchGroups {
  const leaf: LeafPatchOperation[] = [];
  const structural: StructuralPatchOperation[] = [];
  for (const operation of operations) {
    if (operation.type === "update" || operation.type === "replace") leaf.push(operation);
    else structural.push(operation);
  }
  return { leaf, structural };
}

function isTopLevelLeaf(row: Pick<ExistingIndexRow, "blockType" | "parentBlockId" | "path">): boolean {
  return row.parentBlockId === null
    && !row.path.includes(".")
    && LEAF_BLOCK_TYPES.has(row.blockType);
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

function validateLeafBase(analysis: TiptapAnalysis, operations: LeafPatchOperation[]): boolean {
  return operations.every((operation) => {
    const block = analysis.byId.get(operation.blockId);
    return Boolean(block && LEAF_BLOCK_TYPES.has(block.row.blockType));
  });
}

function validateStructuralBase(
  analysis: TiptapAnalysis,
  operations: StructuralPatchOperation[],
): boolean {
  const knownTopLevelIds = new Set(
    analysis.blocks
      .map(({ row }) => row)
      .filter(isTopLevelLeaf)
      .map((row) => row.blockId),
  );

  for (const operation of operations) {
    if (operation.type === "create") {
      if (!LEAF_BLOCK_TYPES.has(operation.blockType || "paragraph")) return false;
      if (operation.afterBlockId && !knownTopLevelIds.has(operation.afterBlockId)) return false;
      if (operation.blockId) {
        if (knownTopLevelIds.has(operation.blockId)) return false;
        knownTopLevelIds.add(operation.blockId);
      }
      continue;
    }
    if (operation.type === "delete") {
      if (!knownTopLevelIds.has(operation.blockId)) return false;
      knownTopLevelIds.delete(operation.blockId);
      continue;
    }
    if (
      operation.blockId === operation.targetBlockId
      || !knownTopLevelIds.has(operation.blockId)
      || !knownTopLevelIds.has(operation.targetBlockId)
    ) {
      return false;
    }
  }
  return true;
}

function validateMixedBase(
  analysis: TiptapAnalysis,
  leaf: LeafPatchOperation[],
  structural: StructuralPatchOperation[],
): boolean {
  if (!validateLeafBase(analysis, leaf) || !validateStructuralBase(analysis, structural)) return false;
  const deleted = new Set(
    structural.filter((operation) => operation.type === "delete").map((operation) => operation.blockId),
  );
  if (leaf.some((operation) => deleted.has(operation.blockId))) return false;
  for (const operation of structural) {
    if (operation.type === "move" && (
      deleted.has(operation.blockId) || deleted.has(operation.targetBlockId)
    )) return false;
    if (operation.type === "create" && operation.afterBlockId && deleted.has(operation.afterBlockId)) {
      return false;
    }
  }
  return true;
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

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)];
}

function classifyStructuralDelta(
  analysis: TiptapAnalysis,
  existing: ExistingIndexRow[],
  operations: StructuralPatchOperation[],
): StructuralDelta | null {
  const existingById = new Map(existing.map((row) => [row.blockId, row]));
  const postIds = new Set(analysis.blocks.map(({ row }) => row.blockId));
  const addedBlockIds = analysis.blocks
    .map(({ row }) => row.blockId)
    .filter((blockId) => !existingById.has(blockId));
  const deletedBlockIds = existing
    .map((row) => row.blockId)
    .filter((blockId) => !postIds.has(blockId));
  const createOperations = operations.filter((operation) => operation.type === "create");
  const deleteOperations = operations.filter((operation) => operation.type === "delete");

  if (addedBlockIds.length !== createOperations.length || deletedBlockIds.length !== deleteOperations.length) {
    return null;
  }
  const requestedDeleted = new Set(deleteOperations.map((operation) => operation.blockId));
  if (deletedBlockIds.some((blockId) => !requestedDeleted.has(blockId))) return null;
  for (const operation of createOperations) {
    if (operation.blockId && !addedBlockIds.includes(operation.blockId)) return null;
  }
  for (const blockId of addedBlockIds) {
    const row = analysis.byId.get(blockId)?.row;
    if (!row || !isTopLevelLeaf(row)) return null;
  }
  for (const blockId of deletedBlockIds) {
    const row = existingById.get(blockId);
    if (!row || !isTopLevelLeaf(row)) return null;
  }

  return { existing, existingById, addedBlockIds, deletedBlockIds };
}

function linksForSources(
  db: Database.Database,
  noteId: string,
  analysis: TiptapAnalysis,
  sourceBlockIds: string[],
): NoteLinkEntry[] | null {
  const links: NoteLinkEntry[] = [];
  for (const blockId of uniqueIds(sourceBlockIds)) {
    const block = analysis.byId.get(blockId);
    if (!block || !LEAF_BLOCK_TYPES.has(block.row.blockType)) return null;
    links.push(...extractLinksFromLeaf(block.node, blockId, block.row.plainText));
  }
  return filterExistingTargets(db, noteId, links);
}

function planLeafIndexes(
  db: Database.Database,
  noteId: string,
  analysis: TiptapAnalysis,
  operations: LeafPatchOperation[],
): IncrementalPatchIndexPlan | null {
  const linkBlockIds = uniqueIds(operations.map((operation) => operation.blockId));
  if (!validateLeafBase(analysis, operations)) return null;
  const indexedBlockIds = collectIndexedAncestors(analysis, linkBlockIds);
  if (!structuresMatch(loadExistingRows(db, noteId), analysis, new Set(indexedBlockIds))) return null;
  const links = linksForSources(db, noteId, analysis, linkBlockIds);
  if (!links) return null;

  return {
    mode: "incremental",
    kind: "leaf",
    contentText: analysis.contentText,
    affectedRows: indexedBlockIds.map((blockId) => (analysis.byId.get(blockId) as AnalyzedBlock).row),
    deletedBlockIds: [],
    links,
    indexedBlockIds,
    linkBlockIds,
  };
}

function planStructuralIndexes(
  db: Database.Database,
  noteId: string,
  analysis: TiptapAnalysis,
  operations: StructuralPatchOperation[],
): IncrementalPatchIndexPlan | null {
  const delta = classifyStructuralDelta(analysis, loadExistingRows(db, noteId), operations);
  if (!delta) return null;

  const affectedRows: NoteBlockIndexRow[] = [];
  for (const { row } of analysis.blocks) {
    const previous = delta.existingById.get(row.blockId);
    if (!previous) {
      affectedRows.push(row);
      continue;
    }
    if (
      previous.blockType !== row.blockType
      || previous.parentBlockId !== row.parentBlockId
      || previous.plainText !== row.plainText
      || previous.contentHash !== row.contentHash
    ) {
      return null;
    }
    if (previous.blockOrder !== row.blockOrder || previous.path !== row.path) {
      if (!isTopLevelLeaf(previous) || !isTopLevelLeaf(row)) return null;
      affectedRows.push(row);
    }
  }

  const links = linksForSources(db, noteId, analysis, delta.addedBlockIds);
  if (!links) return null;
  const linkBlockIds = uniqueIds([...delta.deletedBlockIds, ...delta.addedBlockIds]);
  const indexedBlockIds = uniqueIds([
    ...delta.deletedBlockIds,
    ...affectedRows.map((row) => row.blockId),
  ]);

  return {
    mode: "incremental",
    kind: "structural",
    contentText: analysis.contentText,
    affectedRows,
    deletedBlockIds: delta.deletedBlockIds,
    links,
    indexedBlockIds,
    linkBlockIds,
  };
}

function planMixedIndexes(
  db: Database.Database,
  noteId: string,
  analysis: TiptapAnalysis,
  leaf: LeafPatchOperation[],
  structural: StructuralPatchOperation[],
): IncrementalPatchIndexPlan | null {
  const delta = classifyStructuralDelta(analysis, loadExistingRows(db, noteId), structural);
  if (!delta) return null;

  const leafBlockIds = uniqueIds(leaf.map((operation) => operation.blockId));
  const deletedSet = new Set(delta.deletedBlockIds);
  for (const blockId of leafBlockIds) {
    const previous = delta.existingById.get(blockId);
    const current = analysis.byId.get(blockId)?.row;
    if (
      deletedSet.has(blockId)
      || !previous
      || !current
      || !LEAF_BLOCK_TYPES.has(previous.blockType)
      || !LEAF_BLOCK_TYPES.has(current.blockType)
    ) {
      return null;
    }
  }

  const contentRowIds = collectIndexedAncestors(analysis, leafBlockIds);
  const contentRowSet = new Set(contentRowIds);
  const affectedRows: NoteBlockIndexRow[] = [];
  for (const { row } of analysis.blocks) {
    const previous = delta.existingById.get(row.blockId);
    if (!previous) {
      affectedRows.push(row);
      continue;
    }

    const contentChanged = previous.blockType !== row.blockType
      || previous.plainText !== row.plainText
      || previous.contentHash !== row.contentHash;
    const structureChanged = previous.parentBlockId !== row.parentBlockId
      || previous.blockOrder !== row.blockOrder
      || previous.path !== row.path;

    if (contentChanged) {
      if (!contentRowSet.has(row.blockId)) return null;
      if (previous.blockType !== row.blockType && row.parentBlockId !== null) return null;
    }
    if (structureChanged) {
      if (previous.parentBlockId !== row.parentBlockId) return null;
      if (!isTopLevelLeaf(previous) || !isTopLevelLeaf(row)) return null;
    }
    if (contentRowSet.has(row.blockId) || structureChanged) affectedRows.push(row);
  }

  const postLinkSources = uniqueIds([...delta.addedBlockIds, ...leafBlockIds]);
  const links = linksForSources(db, noteId, analysis, postLinkSources);
  if (!links) return null;
  const linkBlockIds = uniqueIds([
    ...delta.deletedBlockIds,
    ...delta.addedBlockIds,
    ...leafBlockIds,
  ]);
  const indexedBlockIds = uniqueIds([
    ...delta.deletedBlockIds,
    ...affectedRows.map((row) => row.blockId),
  ]);

  return {
    mode: "incremental",
    kind: "mixed",
    contentText: analysis.contentText,
    affectedRows,
    deletedBlockIds: delta.deletedBlockIds,
    links,
    indexedBlockIds,
    linkBlockIds,
  };
}

/**
 * Check whether the persisted Block index is a complete mirror of the current Tiptap document and
 * the requested operation class has a fail-closed incremental implementation.
 */
export function canUseIncrementalPatchIndexes(
  db: Database.Database,
  noteId: string,
  content: string,
  operations: TiptapBlockPatchOperation[],
): boolean {
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis || !structuresMatch(loadExistingRows(db, noteId), analysis, new Set())) return false;
  const groups = splitOperations(operations);
  if (groups.leaf.length > 0 && groups.structural.length > 0) {
    return validateMixedBase(analysis, groups.leaf, groups.structural);
  }
  if (groups.leaf.length > 0) return validateLeafBase(analysis, groups.leaf);
  if (groups.structural.length > 0) return validateStructuralBase(analysis, groups.structural);
  return false;
}

/** Build a post-patch incremental update plan without mutating persistence. */
export function planIncrementalPatchIndexes(
  db: Database.Database,
  _userId: string,
  noteId: string,
  content: string,
  operations: TiptapBlockPatchOperation[],
): IncrementalPatchIndexPlan | null {
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis) return null;
  const groups = splitOperations(operations);
  if (groups.leaf.length > 0 && groups.structural.length > 0) {
    return planMixedIndexes(db, noteId, analysis, groups.leaf, groups.structural);
  }
  if (groups.leaf.length > 0) return planLeafIndexes(db, noteId, analysis, groups.leaf);
  if (groups.structural.length > 0) return planStructuralIndexes(db, noteId, analysis, groups.structural);
  return null;
}

/** Apply one previously validated incremental plan inside the caller's SQLite transaction. */
export function applyIncrementalPatchIndexes(
  db: Database.Database,
  userId: string,
  noteId: string,
  plan: IncrementalPatchIndexPlan,
): void {
  if (plan.deletedBlockIds.length > 0) {
    const placeholders = plan.deletedBlockIds.map(() => "?").join(",");
    db.prepare(`
      DELETE FROM note_blocks_index
      WHERE noteId = ? AND blockId IN (${placeholders})
    `).run(noteId, ...plan.deletedBlockIds);
  }

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

  if (plan.linkBlockIds.length > 0) {
    const placeholders = plan.linkBlockIds.map(() => "?").join(",");
    db.prepare(`
      DELETE FROM note_links
      WHERE sourceNoteId = ? AND sourceBlockId IN (${placeholders})
    `).run(noteId, ...plan.linkBlockIds);
  }

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
