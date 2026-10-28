import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isEncryptedNoteFormat, parseEncryptedNote, encryptedBlocksInContent } from "../lib/encryptedNotes.js";
import { parseEncryptedContentV2, parseEncryptedHistoryV2 } from "../lib/encryptedContentV2.js";
import { extractSearchableText } from "../lib/searchIndex.js";
import { EncryptedNoteConversionError, encryptedHistorySourceDigest, isTextOnlySource } from "./encryptedNoteConversion.js";
import { getYjsStats } from "./yjs.js";

type History = { id: string; noteId: string; userId: string; title: string | null; content: string; contentFormat: string; version: number; changeType: string | null; changeSummary: string | null; createdAt: string };
export type DecryptionInput = {
  noteId: string; userId: string; version: number; sourceDigest: string;
  content: string; contentFormat: "markdown" | "tiptap-json";
  decryptedHistory: Array<{ id: string; sourceDigest: string; content: string; contentFormat: "markdown" | "tiptap-json"; changeSummary: string | null }>;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const envelope = (note: { content: string; contentFormat: string }) => note.contentFormat === "encrypted-note-v2" ? parseEncryptedContentV2(note.content) : parseEncryptedNote(note.content);

export function readNoteDecryptionSource(db: Database.Database, noteId: string) {
  return db.transaction(() => {
    const note = db.prepare("SELECT * FROM notes WHERE id=?").get(noteId) as any;
    const size = db.prepare("SELECT count(*) AS count, COALESCE(sum(length(CAST(content AS BLOB))),0) AS bytes FROM note_versions WHERE noteId=?").get(noteId) as { count: number; bytes: number };
    if (size.count > 1000 || size.bytes + Buffer.byteLength(note.content) > 32 * 1024 * 1024) throw new EncryptedNoteConversionError("CONVERSION_BLOCKED", ["source_too_large"]);
    const history = db.prepare("SELECT * FROM note_versions WHERE noteId=? ORDER BY id").all(noteId) as History[];
    note.tags = db.prepare("SELECT t.* FROM tags t JOIN note_tags nt ON nt.tagId=t.id WHERE nt.noteId=?").all(noteId);
    note.isFavorite = db.prepare("SELECT 1 FROM favorites WHERE noteId=? AND userId=?").get(noteId, note.userId) ? 1 : 0;
    return { note, history };
  })();
}

/** Decrypt in the client; apply the verified complete replacement atomically (DCC-002/004). */
export function decryptEncryptedNoteStorage(db: Database.Database, input: DecryptionInput) {
  if (db.inTransaction || !Number.isSafeInteger(input.version) || typeof input.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceDigest)
    || !Array.isArray(input.decryptedHistory) || input.decryptedHistory.length > 1000 || typeof input.content !== "string"
    || !["markdown", "tiptap-json"].includes(input.contentFormat)) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
  const validate = (content: string, format: string) => {
    if (typeof content !== "string" || Buffer.byteLength(content) > 4 * 1024 * 1024 || !isTextOnlySource(content, format)
      || encryptedBlocksInContent(content, format).length) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
  };
  validate(input.content, input.contentFormat);
  return db.transaction(() => {
    const { note, history } = readNoteDecryptionSource(db, input.noteId);
    if (!input.userId || note.userId !== input.userId) throw new EncryptedNoteConversionError("FORBIDDEN");
    if (!isEncryptedNoteFormat(note.contentFormat) || note.version !== input.version || digest(note.content) !== input.sourceDigest) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
    const original = envelope(note);
    if (original.originalFormat !== input.contentFormat) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
    const blockers: string[] = [];
    if (note.workspaceId) blockers.push("shared_workspace");
    if (note.isLocked || note.isTrashed) blockers.push("note_unavailable");
    if (db.prepare("SELECT 1 FROM sync_profiles LIMIT 1").get()) blockers.push("sync_conversion_not_supported");
    for (const table of ["sync_outbox", "sync_outbox_legacy_unbound", "sync_conflicts"]) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE entityType='note' AND entityId=? LIMIT 1`).get(input.noteId)) blockers.push("pending_writes");
    }
    if (getYjsStats().details.some(room => room.noteId === input.noteId)) blockers.push("collaboration_room");
    if (blockers.length) throw new EncryptedNoteConversionError("CONVERSION_BLOCKED", [...new Set(blockers)]);
    if (history.length !== input.decryptedHistory.length) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
    const replacements = new Map<string, DecryptionInput["decryptedHistory"][number]>();
    let bytes = Buffer.byteLength(input.content);
    for (const replacement of input.decryptedHistory) {
      if (!replacement || typeof replacement.id !== "string" || replacements.has(replacement.id)
        || (replacement.changeSummary !== null && typeof replacement.changeSummary !== "string")) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
      const stored = history.find(row => row.id === replacement.id);
      if (!stored || replacement.sourceDigest !== encryptedHistorySourceDigest(stored)) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
      if (stored.contentFormat === "encrypted-history-v2") {
        parseEncryptedHistoryV2(stored.content, parseEncryptedContentV2(note.content), stored.id, stored.version, replacement.contentFormat);
      }
      const source = stored.contentFormat === "encrypted-history-v2" ? JSON.parse(stored.content) : envelope(stored);
      if (source.objectId !== original.objectId || source.originalFormat !== replacement.contentFormat) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
      validate(replacement.content, replacement.contentFormat);
      bytes += Buffer.byteLength(replacement.content) + Buffer.byteLength(replacement.changeSummary || "");
      if (bytes > 32 * 1024 * 1024) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
      replacements.set(stored.id, replacement);
    }
    const contentText = extractSearchableText(input.content, input.contentFormat);
    db.prepare("INSERT INTO encrypted_note_decryption_permits(noteId,sourceVersion,sourceContent,content,contentFormat,contentText) VALUES (?,?,?,?,?,?)")
      .run(input.noteId, note.version, note.content, input.content, input.contentFormat, contentText);
    db.prepare("UPDATE notes SET content=?,contentFormat=?,contentText=?,version=version+1,updatedAt=datetime('now') WHERE id=? AND version=?")
      .run(input.content, input.contentFormat, contentText, input.noteId, input.version);
    db.prepare("DELETE FROM encrypted_note_decryption_permits WHERE noteId=?").run(input.noteId);
    // Replace the complete verified set, including any implicit pre-update ciphertext snapshot.
    db.prepare("DELETE FROM note_versions WHERE noteId=?").run(input.noteId);
    const insert = db.prepare("INSERT INTO note_versions(id,noteId,userId,title,content,contentText,contentFormat,version,changeType,changeSummary,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const row of history) {
      const plain = replacements.get(row.id)!;
      insert.run(row.id, row.noteId, row.userId, row.title, plain.content, extractSearchableText(plain.content, plain.contentFormat), plain.contentFormat, row.version, row.changeType, plain.changeSummary, row.createdAt);
    }
    insert.run(randomUUID(), input.noteId, input.userId, note.title, input.content, contentText, input.contentFormat, input.version + 1, "edit", null, new Date().toISOString());
    return readNoteDecryptionSource(db, input.noteId).note;
  }).immediate();
}
