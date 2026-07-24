import type { NoteBlockIndexRow } from "./noteBlocks.js";
import {
  noteBlockRedirectsRepository,
  type ResolvedSplitBlockTarget,
} from "../repositories/noteBlockRedirectsRepository.js";

export type { ResolvedSplitBlockTarget };

type NoteBlockRedirectDatabase = Parameters<
  typeof noteBlockRedirectsRepository.resolveSplitBlockTarget
>[0];

/** Resolve an old noteId + blockId through one or more completed split operations. */
export function resolveSplitBlockTarget(
  db: NoteBlockRedirectDatabase,
  sourceNoteId: string,
  sourceBlockId: string,
): ResolvedSplitBlockTarget | null {
  return noteBlockRedirectsRepository.resolveSplitBlockTarget(
    db,
    sourceNoteId,
    sourceBlockId,
  );
}

export function blockExists(
  db: NoteBlockRedirectDatabase,
  noteId: string,
  blockId: string,
): NoteBlockIndexRow | null {
  return noteBlockRedirectsRepository.blockExists(db, noteId, blockId);
}
