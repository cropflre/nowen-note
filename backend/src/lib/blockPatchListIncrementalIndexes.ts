import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type { NoteBlockIndexRow, NoteBlockType } from "./noteBlocks.js";
import type { IncrementalPatchIndexPlan } from "./blockPatchIncrementalIndexes.js";
import type { TiptapBlockPatchOperation } from "./tiptapBlockPatch.js";

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

type ListMoveOperation = Extract<TiptapBlockPatchOperation, { type: "move" }> & {
  scope: "listItem";
};

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
}

interface TiptapAnalysis {
  blocks: AnalyzedBlock[];
  byId: Map<string, AnalyzedBlock>;
  contentText: string;
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function isListMove(operation: TiptapBlockPatchOperation): operation is ListMoveOperation {
  return operation.type === "move" && operation.scope === "listItem";
}

function oneListMove(operations: TiptapBlockPatchOperation[]): ListMoveOperation | null {
  return operations.length === 1 && isListMove(operations[0]) ? operations[0] : null;
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
  byId: Map<string, { row: Pick<ExistingIndexRow, "blockId" | "parentBlockId"> }>,
  startIds: string[],
): Set<string> {
  const output = new Set<string>();
  for (const startId of startIds) {
    let current: string | null = startId;
    while (current && !output.has(current)) {
      output.add(current);
      current = byId.get(current)?.row.parentBlockId || null;
    }
  }
  return output;
}

/**
 * Permit skipping the legacy pre-patch full reindex only for one controlled list-item move whose
 * persisted index is an exact mirror of the authoritative pre-patch document.
 */
export function canUseIncrementalListMoveIndexes(
  db: Database.Database,
  noteId: string,
  content: string,
  operations: TiptapBlockPatchOperation[],
): boolean {
  const operation = oneListMove(operations);
  if (!operation) return false;
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis || !rowsMirrorAnalysis(loadExistingRows(db, noteId), analysis)) return false;
  const source = analysis.byId.get(operation.blockId)?.row;
  const target = analysis.byId.get(operation.targetBlockId)?.row;
  return Boolean(
    source
    && target
    && LIST_ITEM_TYPES.has(source.blockType)
    && source.blockType === target.blockType,
  );
}

/**
 * Build a minimal post-patch index plan for one already-validated list move. Leaf content and link
 * sources must remain unchanged; only aggregate ancestors and structural coordinates may differ.
 */
export function planIncrementalListMoveIndexes(
  db: Database.Database,
  noteId: string,
  content: string,
  operations: TiptapBlockPatchOperation[],
): IncrementalPatchIndexPlan | null {
  const operation = oneListMove(operations);
  if (!operation) return null;
  const analysis = analyzeTiptap(noteId, content);
  if (!analysis) return null;

  const existing = loadExistingRows(db, noteId);
  if (existing.length !== analysis.blocks.length) return null;
  const existingById = new Map(existing.map((row) => [row.blockId, row]));
  if (existingById.size !== analysis.blocks.length) return null;
  if (analysis.blocks.some(({ row }) => !existingById.has(row.blockId))) return null;

  const sourceBefore = existingById.get(operation.blockId);
  const sourceAfter = analysis.byId.get(operation.blockId)?.row;
  const targetBefore = existingById.get(operation.targetBlockId);
  const targetAfter = analysis.byId.get(operation.targetBlockId)?.row;
  if (
    !sourceBefore
    || !sourceAfter
    || !targetBefore
    || !targetAfter
    || !LIST_ITEM_TYPES.has(sourceBefore.blockType)
    || sourceBefore.blockType !== sourceAfter.blockType
    || sourceBefore.blockType !== targetBefore.blockType
    || targetBefore.blockType !== targetAfter.blockType
  ) {
    return null;
  }

  const existingAncestorMap = new Map(
    existing.map((row) => [row.blockId, { row: { blockId: row.blockId, parentBlockId: row.parentBlockId } }]),
  );
  const postAncestorMap = new Map(
    analysis.blocks.map(({ row }) => [
      row.blockId,
      { row: { blockId: row.blockId, parentBlockId: row.parentBlockId } },
    ]),
  );
  const aggregateIds = new Set([
    ...collectAncestorIds(existingAncestorMap, [operation.blockId, operation.targetBlockId]),
    ...collectAncestorIds(postAncestorMap, [operation.blockId, operation.targetBlockId]),
  ]);

  const affectedRows: NoteBlockIndexRow[] = [];
  let sourceStructureChanged = false;
  for (const { row } of analysis.blocks) {
    const previous = existingById.get(row.blockId);
    if (!previous || previous.blockType !== row.blockType) return null;

    const contentChanged = previous.plainText !== row.plainText
      || previous.contentHash !== row.contentHash;
    const parentChanged = previous.parentBlockId !== row.parentBlockId;
    const orderChanged = previous.blockOrder !== row.blockOrder;
    const pathChanged = previous.path !== row.path;

    // Moving a subtree must never alter actual leaf content, marks or links.
    if (contentChanged && LEAF_BLOCK_TYPES.has(row.blockType)) return null;
    if (contentChanged && !aggregateIds.has(row.blockId)) return null;
    if (parentChanged && row.blockId !== operation.blockId) return null;

    if (row.blockId === operation.blockId && (parentChanged || orderChanged || pathChanged)) {
      sourceStructureChanged = true;
    }
    if (contentChanged || parentChanged || orderChanged || pathChanged) affectedRows.push(row);
  }
  if (!sourceStructureChanged || affectedRows.length === 0) return null;

  const indexedBlockIds = affectedRows.map((row) => row.blockId);
  return {
    mode: "incremental",
    // Reuse the established structural apply path; the route exposes the more precise
    // `list-subtree` observation kind to clients and audit logs.
    kind: "structural",
    contentText: analysis.contentText,
    affectedRows,
    deletedBlockIds: [],
    links: [],
    indexedBlockIds,
    linkBlockIds: [],
  };
}
