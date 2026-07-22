import type { ChangeSet } from "@codemirror/state";
import type * as Y from "yjs";

export interface MarkdownTextChange {
  from: number;
  to: number;
  insert: string;
}

export interface YTextDeltaPart {
  retain?: number;
  insert?: unknown;
  delete?: number;
}

/**
 * Convert one CodeMirror ChangeSet into replacements in the original document coordinate space.
 * ChangeSet.iterChanges already reports non-overlapping ranges sorted from left to right.
 */
export function collectCodeMirrorTextChanges(changes: ChangeSet): MarkdownTextChange[] {
  const replacements: MarkdownTextChange[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    replacements.push({
      from: fromA,
      to: toA,
      insert: inserted.toString(),
    });
  });
  return replacements;
}

/**
 * Apply a local CodeMirror transaction to Y.Text without comparing or replacing the full document.
 * Replacements are replayed from right to left so every range remains valid in the original document.
 */
export function applyCodeMirrorChangesToYText({
  changes,
  yDoc,
  yText,
  origin,
}: {
  changes: ChangeSet;
  yDoc: Y.Doc;
  yText: Y.Text;
  origin: object;
}): number {
  const replacements = collectCodeMirrorTextChanges(changes);
  if (replacements.length === 0) return 0;

  yDoc.transact(() => {
    for (let index = replacements.length - 1; index >= 0; index -= 1) {
      const replacement = replacements[index];
      const deleteCount = replacement.to - replacement.from;
      if (deleteCount > 0) yText.delete(replacement.from, deleteCount);
      if (replacement.insert) yText.insert(replacement.from, replacement.insert);
    }
  }, origin);

  return replacements.length;
}

/**
 * Convert a Y.Text event delta to CodeMirror replacements in the pre-event document coordinates.
 * Consecutive insert/delete entries are coalesced into one replacement. Embedded non-text values
 * are intentionally rejected so the caller can use a full-string safety fallback.
 */
export function yTextDeltaToCodeMirrorChanges(
  delta: readonly YTextDeltaPart[],
): MarkdownTextChange[] | null {
  const replacements: MarkdownTextChange[] = [];
  let oldPosition = 0;
  let segmentStart: number | null = null;
  let segmentDeleteCount = 0;
  let segmentInsert = "";

  const flushSegment = () => {
    if (segmentStart === null) return;
    replacements.push({
      from: segmentStart,
      to: segmentStart + segmentDeleteCount,
      insert: segmentInsert,
    });
    segmentStart = null;
    segmentDeleteCount = 0;
    segmentInsert = "";
  };

  const ensureSegment = () => {
    if (segmentStart === null) segmentStart = oldPosition;
  };

  for (const part of delta) {
    if (part.retain !== undefined) {
      if (!Number.isSafeInteger(part.retain) || part.retain < 0) return null;
      flushSegment();
      oldPosition += part.retain;
    }

    if (part.delete !== undefined) {
      if (!Number.isSafeInteger(part.delete) || part.delete < 0) return null;
      ensureSegment();
      segmentDeleteCount += part.delete;
      oldPosition += part.delete;
    }

    if (part.insert !== undefined) {
      if (typeof part.insert !== "string") return null;
      ensureSegment();
      segmentInsert += part.insert;
    }
  }

  flushSegment();
  return replacements;
}
