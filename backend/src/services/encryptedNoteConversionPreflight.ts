import type Database from "better-sqlite3";
import { getYjsStats } from "./yjs.js";

// Counts are possible source-related copies, never a claim of physical erasure.
const groups = {
  history: [["note_versions", "noteId = ?"]],
  blocks: ["note_blocks_index", "note_block_documents", "note_block_records", "note_block_operations", "block_operations", "note_block_attachment_refs"].map((table) => [table, "noteId = ?"]),
  collaboration: ["note_yupdates", "note_ysnapshots", "note_y_subdocuments", "note_y_subdocument_updates", "note_y_subdocument_manifests", "yjs_operation_receipts"].map((table) => [table, "noteId = ?"]),
  search: ["notes_fts_docsize", "notes_search_fts_docsize"].map((table) => [table, "id = (SELECT rowid FROM notes WHERE id = ?)"]),
  embeddings: [["note_embeddings", "noteId = ?"], ["embedding_queue", "noteId = ?"]],
  sync: ["sync_outbox", "sync_outbox_legacy_unbound", "sync_conflicts"].map((table) => [table, "entityType = 'note' AND entityId = ?"]),
  attachments: ["attachments", "attachment_references", "attachment_embedding_queue"].map((table) => [table, "noteId = ?"]),
  sharing: [["shares", "noteId = ?"], ["share_comments", "noteId = ?"], ["note_acl", "noteId = ?"]],
  templates: [["note_templates", "sourceNoteId = ?"]],
  links: [["note_links", "sourceNoteId = ? OR targetNoteId = ?"]],
  imports: [["note_import_origins", "noteId = ?"]],
  folderSync: [["folder_sync_files", "noteId = ?"]],
  embeddedData: [["sheets", "noteId = ?"]],
  aiReferences: [["ai_chat_messages", "CASE WHEN json_valid(referencesJson) THEN EXISTS (SELECT 1 FROM json_tree(referencesJson) WHERE value = ?) ELSE instr(COALESCE(referencesJson, ''), ?) > 0 END"]],
};
const metadataTables = new Set(["notes", "note_tags", "favorites", "workspace_journals", "offline_sync_changes", "sync_changes_v2", "sync_v2_applied_mutations", "encrypted_block_write_permits", "encrypted_note_conversion_permits"]);
const referenceColumns = ["noteId", "note_id", "sourceNoteId", "targetNoteId", "entityId"];
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** Read-only snapshot: no envelope creation, deletion, index rebuild, or maintenance. */
export function inspectEncryptedNoteConversion(db: Database.Database, noteId: string) {
  return db.transaction(() => {
    const note = db.prepare("SELECT id, version, contentFormat, contentText, workspaceId, isTrashed, isLocked FROM notes WHERE id = ?").get(noteId) as
      { id: string; version: number; contentFormat: string; contentText: string; workspaceId: string | null; isTrashed: number; isLocked: number } | undefined;
    if (!note) return null;
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    const covered = new Set(metadataTables);
    const count = (table: string, where: string) => (db.prepare(`SELECT count(*) AS count FROM ${quote(table)} WHERE ${where}`)
      .get(...Array.from(where.matchAll(/\?/g), () => noteId)) as { count: number }).count;
    const copies = Object.entries(groups).map(([kind, sources]) => {
      let records = 0; const unavailable: string[] = [];
      for (const [table, where] of sources) {
        covered.add(table);
        if (!tables.has(table)) unavailable.push(table);
        else records += count(table, where);
      }
      return { kind, records, complete: unavailable.length === 0 };
    });
    if (tables.has("vec_note_chunks")) {
      covered.add("vec_note_chunks");
      copies.find((copy) => copy.kind === "embeddings")!.records += count("vec_note_chunks", "rowid IN (SELECT id FROM note_embeddings WHERE noteId = ?)");
    }
    const unreviewed: Array<{ table: string; records: number }> = [];
    for (const table of tables) {
      if (covered.has(table)) continue;
      const columns = (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((column) => column.name);
      const references = referenceColumns.filter((column) => columns.includes(column));
      if (!references.length) continue;
      const records = count(table, references.map((column) => column === "entityId" && columns.includes("entityType") ? "entityType = 'note' AND entityId = ?" : `${quote(column)} = ?`).join(" OR "));
      if (records) unreviewed.push({ table, records });
    }
    const activeCollaborators = getYjsStats().details.find((room) => room.noteId === noteId)?.refCount || 0;
    const blockers = ["conversion_not_enabled"];
    if (!["markdown", "tiptap-json", "richtext"].includes(note.contentFormat)) blockers.push("unsupported_format");
    if (note.workspaceId) blockers.push("shared_workspace");
    if (note.isTrashed || note.isLocked) blockers.push("note_unavailable");
    if (activeCollaborators) blockers.push("active_collaboration");
    for (const kind of ["attachments", "sharing", "templates", "folderSync", "aiReferences", "embeddedData"]) {
      if (copies.find((copy) => copy.kind === kind)?.records) blockers.push(kind);
    }
    if (copies.some((copy) => !copy.complete) || unreviewed.length) blockers.push("audit_incomplete");
    return {
      noteId, version: note.version, contentFormat: note.contentFormat,
      canConvert: false as const, blockers, copies, unreviewed,
      previewPresent: Boolean(note.contentText), activeCollaborators,
      physicalErasure: "not_verified" as const,
      externalCopies: "not_inspectable" as const,
    };
  })();
}
