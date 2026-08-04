import { getDb } from "../db/schema";
import { noteYsnapshotsRepository } from "./noteYsnapshotsRepository";
import { noteYupdatesRepository } from "./noteYupdatesRepository";

export interface YjsNoteSeedRecord {
  content: string;
  contentText: string;
  contentFormat: string;
}

export interface YjsCheckpointNoteRecord {
  id: string;
  userId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
}

export interface YjsNoteVersionRecord {
  version: number;
  content: string;
  contentText: string;
}

export const yjsPersistenceRepository = {
  getCheckpointNote(noteId: string): YjsCheckpointNoteRecord | undefined {
    return getDb()
      .prepare(
        `SELECT id, userId, title, content, contentText, contentFormat, version
           FROM notes WHERE id = ?`,
      )
      .get(noteId) as YjsCheckpointNoteRecord | undefined;
  },

  hasVersionCheckpoint(noteId: string, version: number): boolean {
    return Boolean(
      getDb()
        .prepare(`SELECT id FROM note_versions WHERE "noteId" = ? AND version = ? LIMIT 1`)
        .get(noteId, version),
    );
  },

  getNoteSeed(noteId: string): YjsNoteSeedRecord | undefined {
    return getDb()
      .prepare("SELECT content, contentText, contentFormat FROM notes WHERE id = ?")
      .get(noteId) as YjsNoteSeedRecord | undefined;
  },

  writeSnapshot(noteId: string, snapshot: Buffer): number {
    const db = getDb();
    let mergedTo = 0;
    const tx = db.transaction(() => {
      const maxRow = noteYupdatesRepository.getMaxId(noteId);
      mergedTo = maxRow?.maxId || 0;
      noteYsnapshotsRepository.upsert(noteId, snapshot, mergedTo);
    });
    tx();
    return mergedTo;
  },

  getNoteVersion(noteId: string): YjsNoteVersionRecord | undefined {
    return getDb()
      .prepare("SELECT version, content, contentText FROM notes WHERE id = ?")
      .get(noteId) as YjsNoteVersionRecord | undefined;
  },

  updateNoteContent(
    noteId: string,
    markdown: string,
    contentText: string,
    bumpVersion: boolean,
  ): void {
    const db = getDb();
    if (bumpVersion) {
      db.prepare(
        `UPDATE notes
           SET content = ?,
               contentText = ?,
               version = version + 1,
               updatedAt = datetime('now')
         WHERE id = ?`,
      ).run(markdown, contentText, noteId);
      return;
    }

    db.prepare(
      `UPDATE notes
         SET content = ?,
             contentText = ?,
             updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(markdown, contentText, noteId);
  },
};
