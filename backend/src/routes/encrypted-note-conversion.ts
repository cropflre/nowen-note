import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { inspectEncryptedNoteConversion } from "../services/encryptedNoteConversionPreflight.js";
import { convertEncryptedNoteStorage, EncryptedNoteConversionError, isTextOnlySource } from "../services/encryptedNoteConversion.js";
import { encryptedBlocksInContent, EncryptedNotePayloadError, isEncryptedNoteFormat } from "../lib/encryptedNotes.js";
import { ENCRYPTED_NOTE_V2_FORMAT, isEncryptedHistoryId } from "../lib/encryptedContentV2.js";
import { canRetireRoomForEncryption, yDestroyDoc } from "../services/yjs.js";
import { broadcastNoteUpdated, getRealtimeStats } from "../services/realtime.js";
import { canViewNoteThroughFolderPasswords, resolveUnlockedFolderNodeIds } from "../lib/knowledgeTreePasswordAccess.js";
import { decryptEncryptedNoteStorage, readNoteDecryptionSource } from "../services/encryptedNoteDecryption.js";

const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  // Conversion is an interactive owner action, never a plugin/API-token mutation.
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ code: "FORBIDDEN" }, 403);
  const note = getDb().prepare("SELECT userId FROM notes WHERE id = ?").get(c.req.param("id")) as { userId: string } | undefined;
  if (!note) return c.json({ code: "NOT_FOUND" }, 404);
  const userId = c.req.header("X-User-Id") || "";
  if (!userId || note.userId !== userId || !hasPermission(resolveNotePermission(c.req.param("id")!, userId).permission, "manage")) {
    return c.json({ code: "FORBIDDEN" }, 403);
  }
  if (!canViewNoteThroughFolderPasswords(getDb(), c.req.param("id")!, resolveUnlockedFolderNodeIds(getDb(), userId, c.req.header("X-Folder-Unlock-Tokens")))) return c.json({ code: "FORBIDDEN" }, 403);
  await next();
});

function readSource(id: string) {
  const db = getDb();
  return db.transaction(() => {
    const note = db.prepare(`SELECT *, CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = notes.userId) THEN 1 ELSE 0 END AS isFavorite FROM notes WHERE id = ?`).get(id) as any;
    const sizes = db.prepare("SELECT count(*) AS count, COALESCE(sum(length(CAST(content AS BLOB)) + length(CAST(COALESCE(changeSummary,'') AS BLOB))),0) AS bytes FROM note_versions WHERE noteId = ?").get(id) as { count: number; bytes: number };
    if (!isEncryptedNoteFormat(note.contentFormat) && (sizes.count > 100 || Buffer.byteLength(note.content) + sizes.bytes > 8 * 1024 * 1024)) return { canConvert: false, blockers: ["source_too_large"] };
    const history = db.prepare("SELECT id,content,contentFormat,version,changeSummary,createdAt FROM note_versions WHERE noteId = ? ORDER BY id").all(id) as any[];
    note.tags = db.prepare("SELECT t.* FROM tags t JOIN note_tags nt ON nt.tagId = t.id WHERE nt.noteId = ?").all(id);
    if (isEncryptedNoteFormat(note.contentFormat)) return { note, history, canConvert: false, blockers: ["already_encrypted"] };
    const audit = inspectEncryptedNoteConversion(db, id)!;
    const blockers = audit.blockers.filter((value) => value !== "conversion_not_enabled");
    const supported = (row: any) => isTextOnlySource(row.content, row.contentFormat) && !encryptedBlocksInContent(row.content, row.contentFormat).length;
    if (!supported(note)) blockers.push("unsupported_format");
    if (history.some((row) => !supported(row) || !isEncryptedHistoryId(row.id))) blockers.push("unsupported_history");
    if (history.length > 100 || Buffer.byteLength(note.content) + history.reduce((size, row) => size + Buffer.byteLength(row.content) + Buffer.byteLength(row.changeSummary || ""), 0) > 8 * 1024 * 1024) blockers.push("source_too_large");
    if (audit.copies.some((copy) => copy.kind === "links" && copy.records)) blockers.push("links");
    if (db.prepare("SELECT 1 FROM sync_profiles LIMIT 1").get()) blockers.push("sync_conversion_not_supported");
    if (db.prepare("SELECT 1 FROM embedding_queue WHERE noteId = ? AND status = 'processing'").get(id)) blockers.push("embedding_in_progress");
    if (!canRetireRoomForEncryption(id, note.version, note.content, note.contentFormat)) blockers.push("collaboration_room");
    if (getRealtimeStats().roomDetails.some((room) => room.name === `note:${id}` && room.size > 0)) blockers.push("active_collaboration");
    if (blockers.length) return { canConvert: false, blockers: [...new Set(blockers)] };
    return { note, history, canConvert: true, blockers: [] };
  })();
}

// Private transient source: no GET read repair, Yjs flush, cache, or offline fallback.
app.get("/source", (c) => c.json(readSource(c.req.param("id")!)));

function decryptionError(c: Context, error: unknown): Response {
  if (error instanceof EncryptedNoteConversionError) return c.json({ code: error.code, blockers: error.blockers }, error.code === "FORBIDDEN" ? 403 : error.code === "INVALID_CONVERSION" ? 400 : 409);
  if (error instanceof EncryptedNotePayloadError || error instanceof SyntaxError || error instanceof TypeError) return c.json({ code: "INVALID_CONVERSION" }, 400);
  return c.json({ code: "DECRYPTION_FAILED" }, 500);
}
app.get("/decryption-source", (c) => {
  try { return c.json(readNoteDecryptionSource(getDb(), c.req.param("id")!)); }
  catch (error) { return decryptionError(c, error); }
});
app.post("/decrypt", bodyLimit({ maxSize: 48 * 1024 * 1024, onError: c => c.json({ code: "INVALID_CONVERSION" }, 413) }), async (c) => {
  try {
    const body = await c.req.json();
    if (!body || body.confirmPlaintext !== true) return c.json({ code: "INVALID_CONVERSION" }, 400);
    const note = decryptEncryptedNoteStorage(getDb(), { ...body, noteId: c.req.param("id")!, userId: c.req.header("X-User-Id")! });
    broadcastNoteUpdated(note.id, { version: note.version, updatedAt: note.updatedAt, contentText: note.contentText, actorUserId: c.req.header("X-User-Id")! });
    return c.json(note);
  } catch (error) { return decryptionError(c, error); }
});

app.post("/cancel", async (c) => {
  try {
    const { version } = await c.req.json();
    if (!Number.isSafeInteger(version) || version < 1) return c.json({ code: "INVALID_CONVERSION" }, 400);
    const id = c.req.param("id")!; const db = getDb();
    const cancelled = db.transaction(() => {
      const note = db.prepare("SELECT version,contentFormat FROM notes WHERE id = ?").get(id) as { version: number; contentFormat: string };
      if (isEncryptedNoteFormat(note.contentFormat)) return false;
      if (note.version < version) return false;
      // Advance only the revision: any delayed original conversion must fail CAS.
      if (note.version === version) db.prepare("UPDATE notes SET version = version + 1 WHERE id = ? AND version = ?").run(id, version);
      return true;
    }).immediate();
    return cancelled ? c.json({ cancelled: true }) : c.json({ code: "not_committed" }, 409);
  } catch { return c.json({ code: "CONVERSION_FAILED" }, 500); }
});

app.post("/", bodyLimit({ maxSize: 16 * 1024 * 1024, onError: (c) => c.json({ code: "INVALID_CONVERSION" }, 413) }), async (c) => {
  const id = c.req.param("id")!;
  try {
    const body = await c.req.json();
    if (!body || body.confirmExternalCopies !== true || body.discardHistory !== undefined || !Array.isArray(body.encryptedHistory)
      || typeof body.content !== "string" || JSON.parse(body.content).version !== 2) return c.json({ code: "INVALID_CONVERSION" }, 400);
    const source = readSource(id);
    // Recover a lost response only when the complete committed target still matches.
    if (source.note?.contentFormat === ENCRYPTED_NOTE_V2_FORMAT && source.note.version === body.version + 1 && source.note.content === body.content
      && source.history?.length === body.encryptedHistory.length + 1 && body.encryptedHistory.every((row: any) => source.history!.some((stored: any) => stored.id === row.id && stored.content === row.content))) {
      return c.json({ noteId: id, version: source.note.version, logicalCleanup: true, physicalErasure: "not_verified" });
    }
    if (!source.canConvert) return c.json({ code: "CONVERSION_BLOCKED", blockers: source.blockers }, 409);
    // Synchronous through COMMIT: no join/update can interleave with retiring a settled room.
    yDestroyDoc(id);
    const result = convertEncryptedNoteStorage(getDb(), {
      noteId: id, userId: c.req.header("X-User-Id")!, version: body.version, sourceDigest: body.sourceDigest,
      content: body.content, encryptedHistory: body.encryptedHistory,
    });
    const updatedAt = (getDb().prepare("SELECT updatedAt FROM notes WHERE id = ?").get(id) as { updatedAt: string }).updatedAt;
    broadcastNoteUpdated(id, { version: result.version, updatedAt, contentText: "", actorUserId: c.req.header("X-User-Id")! });
    return c.json(result);
  } catch (error) {
    if (error instanceof EncryptedNoteConversionError) return c.json({ code: error.code, blockers: error.blockers }, error.code === "FORBIDDEN" ? 403 : error.code === "INVALID_CONVERSION" ? 400 : 409);
    if (error instanceof EncryptedNotePayloadError || error instanceof SyntaxError || error instanceof TypeError) return c.json({ code: "INVALID_CONVERSION" }, 400);
    return c.json({ code: "CONVERSION_FAILED" }, 500);
  }
});

export default app;
