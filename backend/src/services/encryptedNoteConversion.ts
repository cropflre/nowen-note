import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ENCRYPTED_NOTE_FORMAT, encryptedBlocksInContent, parseEncryptedNote } from "../lib/encryptedNotes.js";
import { rebuildNormalizedSearchFts } from "../lib/searchIndex.js";
import { inspectEncryptedNoteConversion } from "./encryptedNoteConversionPreflight.js";
import { getYjsStats } from "./yjs.js";
import { ENCRYPTED_HISTORY_V2_FORMAT, ENCRYPTED_NOTE_V2_FORMAT, parseEncryptedContentV2, parseEncryptedHistoryV2 } from "../lib/encryptedContentV2.js";

export class EncryptedNoteConversionError extends Error {
  constructor(readonly code: "FORBIDDEN" | "VERSION_CONFLICT" | "CONVERSION_BLOCKED" | "INVALID_CONVERSION", readonly blockers: string[] = []) {
    super(code); // Never include source bodies, digests or envelopes in errors.
  }
}
interface ConversionBase {
  noteId: string;
  userId: string;
  version: number;
  sourceDigest: string;
  content: string;
}
export type EncryptedNoteConversionInput = ConversionBase & (
  | { discardHistory: true; encryptedHistory?: never }
  | { discardHistory?: never; encryptedHistory: Array<{ id: string; sourceDigest: string; content: string }> }
);
export function encryptedHistorySourceDigest(source: { content: string; contentFormat: string; version: number; changeSummary: string | null }): string {
  return createHash("sha256").update(JSON.stringify([source.content, source.contentFormat, source.version, source.changeSummary])).digest("hex");
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
  const preserveHistory = Array.isArray(input.encryptedHistory) && input.discardHistory === undefined;
  if (db.inTransaction || (!preserveHistory && (input.discardHistory !== true || input.encryptedHistory !== undefined)) || !Number.isSafeInteger(input.version)
    || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
  let v2: boolean;
  try { v2 = JSON.parse(input.content).version === 2; } catch { throw new EncryptedNoteConversionError("INVALID_CONVERSION"); }
  if (preserveHistory && !v2) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
  const envelope = v2 ? parseEncryptedContentV2(input.content) : parseEncryptedNote(input.content);
  const targetFormat = v2 ? ENCRYPTED_NOTE_V2_FORMAT : ENCRYPTED_NOTE_FORMAT;
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

    // Prepare all replacements before deleting anything. A changed history set
    // or digest aborts the same IMMEDIATE transaction that performs the switch.
    const history = db.prepare("SELECT id,noteId,userId,title,contentFormat,version,changeType,createdAt FROM note_versions WHERE noteId = ? ORDER BY id").all(input.noteId) as Array<{
      id: string; noteId: string; userId: string; title: string | null; contentFormat: string; version: number;
      changeType: string | null; createdAt: string;
    }>;
    const replacements = new Map<string, string>();
    if (preserveHistory) {
      if (input.encryptedHistory!.length !== history.length || input.encryptedHistory!.length > 10000) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
      if (input.encryptedHistory!.reduce((size, row) => size + (typeof row?.content === "string" ? row.content.length : 0), 0) > 64 * 1024 * 1024) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
      const byId = new Map(history.map((row) => [row.id, row]));
      const readSource = db.prepare("SELECT content,contentFormat,version,changeSummary FROM note_versions WHERE id = ? AND noteId = ?");
      for (const replacement of input.encryptedHistory!) {
        if (!replacement || typeof replacement.id !== "string" || replacements.has(replacement.id)) throw new EncryptedNoteConversionError("INVALID_CONVERSION");
        const original = byId.get(replacement.id);
        const source = readSource.get(replacement.id, input.noteId) as { content: string; contentFormat: string; version: number; changeSummary: string | null } | undefined;
        if (!original || !source || typeof source.content !== "string" || encryptedHistorySourceDigest(source) !== replacement.sourceDigest) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
        if (!isTextOnlySource(source.content, source.contentFormat) || encryptedBlocksInContent(source.content, source.contentFormat).length) throw new EncryptedNoteConversionError("CONVERSION_BLOCKED", ["unsupported_history"]);
        parseEncryptedHistoryV2(replacement.content, parseEncryptedContentV2(input.content), original.id, original.version, original.contentFormat);
        replacements.set(original.id, replacement.content);
      }
    }

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
      updatedAt = datetime('now') WHERE id = ? AND version = ?`).run(input.content, targetFormat, input.noteId, input.version);
    if (changed.changes !== 1) throw new EncryptedNoteConversionError("VERSION_CONFLICT");
    // The ordinary overwrite safety trigger may snapshot OLD plaintext before
    // the UPDATE. Purge its transactional pre-image too, before committing.
    remove("note_versions");
    db.prepare("DELETE FROM encrypted_note_conversion_permits WHERE noteId = ?").run(input.noteId);
    // Rebuild from current projections, also removing logically stale terms that
    // may not match the old contentText used by the normal FTS update triggers.
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    rebuildNormalizedSearchFts(db);
    if (preserveHistory) {
      const insert = db.prepare(`INSERT INTO note_versions (id,noteId,userId,title,content,contentText,contentFormat,version,changeType,changeSummary,createdAt)
        VALUES (?,?,?,?,?,'',?,?,?,?,?)`);
      for (const original of history) insert.run(original.id, original.noteId, original.userId, original.title, replacements.get(original.id),
        ENCRYPTED_HISTORY_V2_FORMAT, original.version, original.changeType, null, original.createdAt);
      // changeSummary can contain source text; do not carry it outside the cipher.
    }
    db.prepare(`INSERT INTO note_versions (id,noteId,userId,title,content,contentText,contentFormat,version,changeType)
      VALUES (?,?,?,?,?,'',?,?,'edit')`).run(randomUUID(), input.noteId, input.userId, note.title, input.content, targetFormat, input.version + 1);
    return { noteId: input.noteId, version: input.version + 1, historyPreserved: preserveHistory ? history.length : 0, logicalCleanup: true as const, physicalErasure: "not_verified" as const };
  }).immediate();
}
