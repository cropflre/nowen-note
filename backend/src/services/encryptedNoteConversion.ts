import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ENCRYPTED_NOTE_FORMAT, encryptedBlocksInContent, parseEncryptedNote } from "../lib/encryptedNotes.js";
import { rebuildNormalizedSearchFts } from "../lib/searchIndex.js";
import { inspectEncryptedNoteConversion } from "./encryptedNoteConversionPreflight.js";
import { getYjsStats } from "./yjs.js";

export class EncryptedNoteConversionError extends Error {
  constructor(readonly code: "FORBIDDEN" | "VERSION_CONFLICT" | "CONVERSION_BLOCKED" | "INVALID_CONVERSION", readonly blockers: string[] = []) {
    super(code); // Never include source bodies, digests or envelopes in errors.
  }
}
export interface EncryptedNoteConversionInput {
  noteId: string;
  userId: string;
  version: number;
  sourceDigest: string;
  content: string;
  discardHistory: true;
}

// Match the current text-only encrypted editor boundary before destroying its source.
function isTextOnlySource(content: string, format: string): boolean {
  if (format === "markdown") return !/!\[|<(?:img|audio|video|iframe|object|embed)\b|\/api\/attachments\/|data:(?:image|audio|video)\//i.test(content);
  if (format !== "tiptap-json") return false;
  const nodes = new Set(["doc", "paragraph", "heading", "text", "bulletList", "orderedList", "listItem", "blockquote", "hardBreak", "codeBlock", "horizontalRule"]);
  const marks = new Set(["bold", "italic", "strike", "code"]);
  const supported = (node: any, depth: number): boolean => Boolean(node && typeof node === "object" && depth <= 100 && nodes.has(node.type)
    && (node.marks === undefined || (Array.isArray(node.marks) && node.marks.every((mark: any) => marks.has(mark?.type))))
    && (node.content === undefined || (Array.isArray(node.content) && node.content.every((child: any) => supported(child, depth + 1)))));
  try { const doc = JSON.parse(content); return doc?.type === "doc" && supported(doc, 0); } catch { return false; }
}

/** Internal storage primitive only. No API/UI conversion is enabled by this function. */
export function convertEncryptedNoteStorage(db: Database.Database, input: EncryptedNoteConversionInput) {
  if (db.inTransaction || input.discardHistory !== true || !Number.isSafeInteger(input.version)
    || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
  const envelope = parseEncryptedNote(input.content);
  return db.transaction(() => {
    const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(input.noteId) as
      { userId: string; version: number; content: string; contentFormat: string; title: string } | undefined;
    if (!note || !input.userId || note.userId !== input.userId) throw new EncryptedNoteConversionError("FORBIDDEN");
    if (note.version !== input.version || createHash("sha256").update(note.content).digest("hex") !== input.sourceDigest) {
      throw new EncryptedNoteConversionError("VERSION_CONFLICT");
    }
    const audit = inspectEncryptedNoteConversion(db, input.noteId)!;
    const blockers = audit.blockers.filter((blocker) => blocker !== "conversion_not_enabled");
    if (!isTextOnlySource(note.content, note.contentFormat) || envelope.originalFormat !== note.contentFormat
      || encryptedBlocksInContent(note.content, note.contentFormat).length) blockers.push("unsupported_format");
    if (audit.copies.some((copy) => copy.kind === "links" && copy.records > 0)) blockers.push("links");
    // Idle rooms can still have pending plaintext updates/timers. Never discard
    // them as part of conversion or mutate them before a transaction commits.
    if (getYjsStats().details.some((room) => room.noteId === input.noteId)) blockers.push("collaboration_room");
    // Converting a remote plaintext note needs a separate Sync protocol. Neither
    // disabled profiles nor a locally empty outbox prove no remote copy exists.
    if (db.prepare("SELECT 1 FROM sync_profiles LIMIT 1").get()) blockers.push("sync_conversion_not_supported");
    if (db.prepare("SELECT 1 FROM encrypted_note_conversion_permits WHERE noteId = ?").get(input.noteId)) blockers.push("stale_conversion_permit");
    if (db.prepare("SELECT 1 FROM embedding_queue WHERE noteId = ? AND status = 'processing'").get(input.noteId)) blockers.push("embedding_in_progress");
    if (blockers.length) throw new EncryptedNoteConversionError("CONVERSION_BLOCKED", [...new Set(blockers)]);

    const remove = (table: string, where = "noteId = ?") => db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(input.noteId);
    remove("note_versions");
    for (const table of ["note_block_attachment_refs", "note_block_operations", "block_operations", "note_block_records", "note_block_documents", "note_blocks_index"]) remove(table);
    for (const table of ["note_y_subdocument_updates", "note_y_subdocuments", "note_y_subdocument_manifests", "note_yupdates", "note_ysnapshots", "yjs_operation_receipts"]) remove(table);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_note_chunks'").get()) {
      db.prepare("DELETE FROM vec_note_chunks WHERE rowid IN (SELECT id FROM note_embeddings WHERE noteId = ?)").run(input.noteId);
    }
    for (const table of ["embedding_queue", "note_embeddings", "note_import_origins"]) remove(table);
    for (const table of ["sync_outbox", "sync_outbox_legacy_unbound", "sync_conflicts"]) remove(table, "entityType = 'note' AND entityId = ?");

    db.prepare("INSERT INTO encrypted_note_conversion_permits (noteId,sourceVersion,sourceFormat,content) VALUES (?,?,?,?)")
      .run(input.noteId, note.version, note.contentFormat, input.content);
    const changed = db.prepare(`UPDATE notes SET content = ?, contentFormat = ?, contentText = '', version = version + 1,
      updatedAt = datetime('now') WHERE id = ? AND version = ?`).run(input.content, ENCRYPTED_NOTE_FORMAT, input.noteId, input.version);
    if (changed.changes !== 1) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
    // The ordinary overwrite safety trigger may snapshot OLD plaintext before
    // the UPDATE. Purge its transactional pre-image too, before committing.
    remove("note_versions");
    db.prepare("DELETE FROM encrypted_note_conversion_permits WHERE noteId = ?").run(input.noteId);
    // Rebuild from current projections, also removing logically stale terms that
    // may not match the old contentText used by the normal FTS update triggers.
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    rebuildNormalizedSearchFts(db);
    db.prepare(`INSERT INTO note_versions (id,noteId,userId,title,content,contentText,contentFormat,version,changeType)
      VALUES (?,?,?,?,?,'',?,?,'edit')`).run(randomUUID(), input.noteId, input.userId, note.title, input.content, ENCRYPTED_NOTE_FORMAT, input.version + 1);
    return { noteId: input.noteId, version: input.version + 1, logicalCleanup: true as const, physicalErasure: "not_verified" as const };
  }).immediate();
}
