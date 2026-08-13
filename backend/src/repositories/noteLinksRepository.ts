/**
 * Note links repository.
 *
 * Links belong to the source note, not to the user who happened to save it.
 * The legacy userId column is retained for schema compatibility and auditing,
 * but reads and replacement are keyed by sourceNoteId.
 */
import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";
import { v4 as uuid } from "uuid";
import type { BacklinkItem, NoteLinkEntry } from "./types";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

export const noteLinksRepository = {
  getSourceNoteUserId(noteId: string): string | null {
    const row = getDb().prepare("SELECT userId FROM notes WHERE id = ?").get(noteId) as
      | { userId?: string }
      | undefined;
    return row?.userId ? String(row.userId) : null;
  },

  getBacklinks(
    _userId: string,
    targetNoteId: string,
    limit = 50,
  ): BacklinkItem[] {
    try {
      return getDb().prepare(`
        SELECT
          nl.sourceNoteId,
          nl.sourceBlockId,
          n.title,
          n.notebookId AS sourceNotebookId,
          n.updatedAt,
          nl.linkText,
          nl.linkType,
          nl.targetBlockId,
          nl.excerpt
        FROM note_links nl
        JOIN notes n ON n.id = nl.sourceNoteId
        WHERE nl.targetNoteId = ?
          AND n.isTrashed = 0
        ORDER BY n.updatedAt DESC
        LIMIT ?
      `).all(targetNoteId, limit) as BacklinkItem[];
    } catch (error) {
      console.warn("[noteLinksRepository.getBacklinks] failed:", error instanceof Error ? error.message : error);
      return [];
    }
  },

  replaceLinksForSource(
    userId: string,
    sourceNoteId: string,
    links: NoteLinkEntry[],
  ): void {
    const db = getDb();
    const validEntries: NoteLinkEntry[] = [];
    const check = db.prepare("SELECT id FROM notes WHERE id = ?");
    for (const link of links) if (check.get(link.targetNoteId)) validEntries.push(link);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO note_links (
        id, userId, sourceNoteId, targetNoteId, targetBlockId, sourceBlockId,
        linkType, linkText, excerpt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    db.transaction(() => {
      db.prepare("DELETE FROM note_links WHERE sourceNoteId = ?").run(sourceNoteId);
      for (const link of validEntries) {
        insert.run(
          uuid(), userId, sourceNoteId, link.targetNoteId, link.targetBlockId,
          link.sourceBlockId, link.linkType, link.linkText, link.excerpt,
        );
      }
    })();
  },

  async replaceLinksForSourceAsync(
    userId: string,
    sourceNoteId: string,
    links: NoteLinkEntry[],
  ): Promise<void> {
    const db = getDb();
    const validEntries: NoteLinkEntry[] = [];
    const check = db.prepare("SELECT id FROM notes WHERE id = ?");
    for (const link of links) if (check.get(link.targetNoteId)) validEntries.push(link);
    await getAdapter().executeStatements([
      { sql: "DELETE FROM note_links WHERE sourceNoteId = ?", params: [sourceNoteId] },
      ...validEntries.map((link) => ({
        sql: `INSERT OR IGNORE INTO note_links (
                id, userId, sourceNoteId, targetNoteId, targetBlockId, sourceBlockId,
                linkType, linkText, excerpt, createdAt, updatedAt
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        params: [
          uuid(), userId, sourceNoteId, link.targetNoteId, link.targetBlockId,
          link.sourceBlockId, link.linkType, link.linkText, link.excerpt,
        ],
      })),
    ]);
  },

  deleteByNoteId(noteId: string): void {
    getDb().prepare("DELETE FROM note_links WHERE sourceNoteId = ? OR targetNoteId = ?").run(noteId, noteId);
  },

  async getBacklinksAsync(
    userId: string,
    targetNoteId: string,
    limit = 50,
  ): Promise<BacklinkItem[]> {
    return this.getBacklinks(userId, targetNoteId, limit);
  },

  async deleteByNoteIdAsync(noteId: string): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM note_links WHERE sourceNoteId = ? OR targetNoteId = ?",
      [noteId, noteId],
    );
  },
};
