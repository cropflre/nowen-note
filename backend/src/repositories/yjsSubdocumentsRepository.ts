import { getDb } from "../db/schema";
import {
  applyYjsSubdocumentUpdate,
  assertYjsSubdocumentGeneration,
  getYjsSubdocumentSnapshot,
  prepareYjsSubdocuments,
  type YjsSubdocumentManifest,
} from "../services/yjs-subdocuments";
import { noteYsnapshotsRepository } from "./noteYsnapshotsRepository";
import { noteYupdatesRepository } from "./noteYupdatesRepository";

export interface YjsSubdocumentApplyResult {
  content: string;
  contentText: string;
  sectionGuid: string;
  version: number;
  generation: number;
  structureVersion: number;
}

export const yjsSubdocumentsRepository = {
  prepareManifest(noteId: string): YjsSubdocumentManifest | null {
    const db = getDb();
    const note = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(noteId) as
      | { content: string; contentFormat: string }
      | undefined;
    if (!note || note.contentFormat !== "tiptap-json") return null;
    return prepareYjsSubdocuments(db, noteId, note.content);
  },

  getState(noteId: string, sectionId: string): { guid: string; snapshot: Uint8Array } | null {
    return getYjsSubdocumentSnapshot(getDb(), noteId, sectionId);
  },

  assertGeneration(noteId: string, expectedGeneration: number): YjsSubdocumentManifest {
    return assertYjsSubdocumentGeneration(getDb(), noteId, expectedGeneration);
  },

  applyUpdate(
    noteId: string,
    sectionId: string,
    update: Uint8Array,
    userId: string | null,
    expectedGeneration: number,
  ): YjsSubdocumentApplyResult {
    const db = getDb();
    const result = applyYjsSubdocumentUpdate(
      db,
      noteId,
      sectionId,
      update,
      userId,
      expectedGeneration,
    );
    try {
      db.transaction(() => {
        noteYupdatesRepository.deleteByNoteId(noteId);
        noteYsnapshotsRepository.deleteByNoteId(noteId);
      })();
    } catch (error) {
      console.warn(`[yjs] retire legacy history failed for ${noteId}:`, error);
    }
    return result;
  },
};
