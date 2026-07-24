import type Database from "better-sqlite3";

import {
  ensureNoteIndexed,
  getNoteBlock,
  getNoteBlocks,
  type NoteBlockIndexRow,
} from "../lib/noteBlocks.js";
import { planMarkdownNoteSplit } from "../lib/noteSplit.js";
import {
  collectTiptapBlockIds,
  planTiptapNoteSplit,
  type TiptapSplitSection,
} from "../lib/tiptapNoteSplit.js";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const MAX_REDIRECT_HOPS = 8;

interface SplitOperationRow {
  id: string;
  sourceNoteId: string;
  originalContent: string;
  originalContentFormat: string;
  headingLevel: number;
  status: string;
  createdAt: string;
}

interface SplitItemRow {
  noteId: string;
  sortOrder: number;
  title: string;
}

interface SectionDescriptor {
  index: number;
  title: string;
  blockIds: Set<string>;
  headingBlockId: string | null;
}

interface AssignedSection {
  section: SectionDescriptor;
  item: SplitItemRow;
  targetBlockIds: Set<string>;
}

export interface ResolvedSplitBlockTarget {
  noteId: string;
  blockId: string | null;
  operationId: string;
  hops: number;
  redirectedFrom: Array<{ noteId: string; blockId: string }>;
}

function markdownBlockIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(/\^(blk_[A-Za-z0-9_-]{6,})\b/g)) ids.add(match[1]);
  return ids;
}

function markdownHeadingBlockId(source: string): string | null {
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  return firstLine.match(/\^(blk_[A-Za-z0-9_-]{6,})\s*$/)?.[1] || null;
}

function tiptapHeadingBlockId(section: TiptapSplitSection): string | null {
  const attrs = section.headingNode?.attrs;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
  const value = (attrs as Record<string, unknown>).blockId;
  return typeof value === "string" && BLOCK_ID_RE.test(value) ? value : null;
}

function describeSections(operation: SplitOperationRow): SectionDescriptor[] {
  const level = operation.headingLevel === 2 ? 2 : 1;
  if (operation.originalContentFormat === "markdown") {
    const plan = planMarkdownNoteSplit(operation.originalContent || "", level);
    return plan.sections.map((section) => {
      const raw = operation.originalContent.slice(section.sourceStart, section.sourceEnd);
      return {
        index: section.index,
        title: section.title,
        blockIds: markdownBlockIds(raw),
        headingBlockId: markdownHeadingBlockId(raw),
      };
    });
  }
  if (operation.originalContentFormat === "tiptap-json") {
    const plan = planTiptapNoteSplit(operation.originalContent || "", level);
    return plan.sections.map((section) => ({
      index: section.index,
      title: section.title,
      blockIds: new Set(collectTiptapBlockIds(section.fullNodes)),
      headingBlockId: tiptapHeadingBlockId(section),
    }));
  }
  return [];
}

function readableSplitItems(db: Database.Database, operationId: string): SplitItemRow[] {
  return db.prepare(`
    SELECT i.noteId, i.sortOrder, i.title
    FROM note_split_items i
    JOIN notes n ON n.id = i.noteId AND n.isTrashed = 0
    WHERE i.operationId = ?
    ORDER BY i.sortOrder ASC
  `).all(operationId) as SplitItemRow[];
}

function targetBlockIds(db: Database.Database, noteId: string): Set<string> {
  ensureNoteIndexed(db, noteId);
  return new Set(getNoteBlocks(db, noteId, 10000).map((row) => row.blockId));
}

function overlapSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function assignSections(
  db: Database.Database,
  operation: SplitOperationRow,
): AssignedSection[] {
  const sections = describeSections(operation);
  const items = readableSplitItems(db, operation.id);
  const remaining = new Set(sections.map((section) => section.index));
  const assigned: AssignedSection[] = [];

  for (const item of items) {
    const ids = targetBlockIds(db, item.noteId);
    let selected: SectionDescriptor | null = null;
    let bestOverlap = 0;

    for (const section of sections) {
      if (!remaining.has(section.index)) continue;
      const overlap = overlapSize(section.blockIds, ids);
      if (overlap > bestOverlap) {
        selected = section;
        bestOverlap = overlap;
      }
    }

    if (!selected) {
      const titleMatches = sections.filter(
        (section) => remaining.has(section.index) && section.title === item.title,
      );
      if (titleMatches.length === 1) selected = titleMatches[0];
    }

    if (!selected) continue;
    remaining.delete(selected.index);
    assigned.push({ section: selected, item, targetBlockIds: ids });
  }

  return assigned;
}

function listCompletedOperations(db: Database.Database, sourceNoteId: string): SplitOperationRow[] {
  try {
    return db.prepare(`
      SELECT id, sourceNoteId, originalContent, originalContentFormat,
             headingLevel, status, createdAt
      FROM note_split_operations
      WHERE sourceNoteId = ? AND status = 'completed'
      ORDER BY createdAt DESC, rowid DESC
      LIMIT 50
    `).all(sourceNoteId) as SplitOperationRow[];
  } catch {
    return [];
  }
}

function resolveSingleHop(
  db: Database.Database,
  sourceNoteId: string,
  sourceBlockId: string,
): { noteId: string; blockId: string | null; operationId: string } | null {
  for (const operation of listCompletedOperations(db, sourceNoteId)) {
    let assignments: AssignedSection[];
    try {
      assignments = assignSections(db, operation);
    } catch {
      continue;
    }
    for (const assignment of assignments) {
      if (!assignment.section.blockIds.has(sourceBlockId)) continue;
      const targetBlockId = assignment.section.headingBlockId === sourceBlockId
        ? null
        : sourceBlockId;
      return {
        noteId: assignment.item.noteId,
        blockId: targetBlockId,
        operationId: operation.id,
      };
    }
  }
  return null;
}

export const noteBlockRedirectsRepository = {
  resolveSplitBlockTarget(
    db: Database.Database,
    sourceNoteId: string,
    sourceBlockId: string,
  ): ResolvedSplitBlockTarget | null {
    if (!BLOCK_ID_RE.test(sourceBlockId)) return null;

    let noteId = sourceNoteId;
    let blockId: string | null = sourceBlockId;
    let operationId = "";
    const redirectedFrom: Array<{ noteId: string; blockId: string }> = [];
    const visited = new Set<string>();

    for (let hops = 1; hops <= MAX_REDIRECT_HOPS && blockId; hops += 1) {
      const key = `${noteId}:${blockId}`;
      if (visited.has(key)) return null;
      visited.add(key);

      ensureNoteIndexed(db, noteId);
      if (getNoteBlock(db, noteId, blockId)) {
        if (redirectedFrom.length === 0) return null;
        return { noteId, blockId, operationId, hops: redirectedFrom.length, redirectedFrom };
      }

      const next = resolveSingleHop(db, noteId, blockId);
      if (!next) return null;
      redirectedFrom.push({ noteId, blockId });
      noteId = next.noteId;
      blockId = next.blockId;
      operationId = next.operationId;

      if (!blockId) {
        return { noteId, blockId: null, operationId, hops, redirectedFrom };
      }
    }

    return null;
  },

  blockExists(
    db: Database.Database,
    noteId: string,
    blockId: string,
  ): NoteBlockIndexRow | null {
    ensureNoteIndexed(db, noteId);
    return getNoteBlock(db, noteId, blockId);
  },
};
