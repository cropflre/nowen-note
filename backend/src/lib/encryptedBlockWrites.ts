import type Database from "better-sqlite3";
import { EncryptedNotePayloadError, encryptedBlocksInContent, guardEncryptedNoteMutation } from "./encryptedNotes.js";

/** Only explicit whole-save/Sync writers may change envelopes; derived writers retain every copy. */
export function withEncryptedBlockWrite<T>(
  db: Database.Database, noteId: string, content: string, contentFormat: string,
  write: () => T, encryptedBlocksVersion?: unknown,
): T {
  return db.transaction(() => {
    const current = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(noteId) as
      { content: string; contentFormat: string } | undefined;
    if (!/nowen-encrypted/i.test(content) && !/nowen-encrypted/i.test(current?.content || "")) return write();
    guardEncryptedNoteMutation({ content, contentFormat }, current);
    if (encryptedBlocksVersion !== 1) {
      const signatures = (body: string, format: string) => encryptedBlocksInContent(body, format).map((block) => block.serialized).sort();
      if (JSON.stringify(signatures(current?.content || "", current?.contentFormat || contentFormat)) !== JSON.stringify(signatures(content, contentFormat))) {
        throw new EncryptedNotePayloadError();
      }
    }
    const previous = db.prepare("SELECT content, contentFormat FROM encrypted_block_write_permits WHERE noteId = ?").get(noteId) as
      { content: string; contentFormat: string } | undefined;
    const permit = db.prepare("INSERT OR REPLACE INTO encrypted_block_write_permits (noteId, content, contentFormat) VALUES (?, ?, ?)");
    permit.run(noteId, content, contentFormat);
    try { return write(); }
    finally {
      if (previous) permit.run(noteId, previous.content, previous.contentFormat);
      else db.prepare("DELETE FROM encrypted_block_write_permits WHERE noteId = ?").run(noteId);
    }
  })();
}

export function assertEncryptedBlockCollaborationAllowed(db: Database.Database, noteId: string): void {
  const note = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(noteId) as
    { content: string; contentFormat: string } | undefined;
  if (note && (note.contentFormat.startsWith("encrypted-") || /nowen-encrypted/i.test(note.content))) {
    throw new Error("ENCRYPTED_NOTE_COLLABORATION_FORBIDDEN");
  }
}
