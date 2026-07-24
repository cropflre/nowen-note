import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import * as Y from "yjs";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";

export interface YjsSubdocumentSection {
  id: string;
  guid: string;
  startBlock: number;
  endBlock: number;
  content: string;
}

export interface YjsSubdocumentManifest {
  rootGuid: string;
  sections: Array<Pick<YjsSubdocumentSection, "id" | "guid" | "startBlock" | "endBlock">>;
}

export function isYjsSubdocumentsEnabled(): boolean {
  return process.env.NOWEN_YJS_SUBDOCUMENTS === "1";
}

export function rebuildYjsSubdocumentsIfEnabled(
  db: Database.Database,
  noteId: string,
  content: string,
  contentFormat: string,
): boolean {
  if (!isYjsSubdocumentsEnabled() || contentFormat !== "tiptap-json") return false;
  rebuildYjsSubdocuments(db, noteId, content);
  return true;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stablePart(value: unknown): string {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function parseDocument(content: string): { type: "doc"; content: any[] } | null {
  try {
    const value = JSON.parse(content);
    return value?.type === "doc" && Array.isArray(value.content)
      ? { type: "doc", content: value.content }
      : null;
  } catch {
    return null;
  }
}

export function splitYjsSubdocumentSections(noteId: string, content: string, maxBlocks = 250): YjsSubdocumentSection[] | null {
  const doc = parseDocument(content);
  if (!doc || !Number.isInteger(maxBlocks) || maxBlocks < 10) return null;
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 1; index < doc.content.length; index += 1) {
    const node = doc.content[index];
    if ((node?.type === "heading" && Number(node?.attrs?.level) <= 2) || index - start >= maxBlocks) {
      ranges.push({ start, end: index });
      start = index;
    }
  }
  ranges.push({ start, end: doc.content.length });
  const used = new Set<string>();
  return ranges.map((range, index) => {
    const nodes = doc.content.slice(range.start, range.end);
    const blockId = nodes.find((node) => typeof node?.attrs?.blockId === "string")?.attrs?.blockId;
    const baseId = blockId ? `section-${stablePart(blockId)}` : `section-${index}`;
    const id = used.has(baseId) ? `${baseId}-${index}` : baseId;
    used.add(id);
    return {
      id,
      guid: `nowen-subdoc-${stablePart(noteId)}-${id}`,
      startBlock: range.start,
      endBlock: range.end,
      content: JSON.stringify({ type: "doc", content: nodes }),
    };
  });
}

export function ensureYjsSubdocumentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_y_subdocument_manifests (
      noteId TEXT PRIMARY KEY,
      rootGuid TEXT NOT NULL,
      rootSnapshot BLOB NOT NULL,
      contentHash TEXT NOT NULL,
      sectionCount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'healthy',
      mismatchReason TEXT,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS note_y_subdocuments (
      noteId TEXT NOT NULL,
      sectionId TEXT NOT NULL,
      guid TEXT NOT NULL,
      blockStart INTEGER NOT NULL,
      blockEnd INTEGER NOT NULL,
      snapshotBlob BLOB NOT NULL,
      payloadHash TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (noteId, sectionId),
      UNIQUE (noteId, guid),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_y_subdocuments_order
      ON note_y_subdocuments(noteId, blockStart);
    CREATE TABLE IF NOT EXISTS note_y_subdocument_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId TEXT NOT NULL,
      sectionId TEXT NOT NULL,
      userId TEXT,
      updateBlob BLOB NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId, sectionId) REFERENCES note_y_subdocuments(noteId, sectionId) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_y_subdocument_updates_section
      ON note_y_subdocument_updates(noteId, sectionId, id);
  `);
}

function encodeSection(section: YjsSubdocumentSection): Buffer {
  const doc = new Y.Doc({ guid: section.guid });
  doc.getText("content").insert(0, section.content);
  const result = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return result;
}

function decodeSection(guid: string, snapshot: Buffer): string | null {
  const doc = new Y.Doc({ guid });
  try {
    Y.applyUpdate(doc, new Uint8Array(snapshot));
    const content = doc.getText("content").toString();
    return parseDocument(content) ? content : null;
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

export function rebuildYjsSubdocuments(
  db: Database.Database,
  noteId: string,
  content: string,
  maxBlocks = 250,
): { rootGuid: string; sections: YjsSubdocumentSection[] } {
  ensureYjsSubdocumentTables(db);
  const sections = splitYjsSubdocumentSections(noteId, content, maxBlocks);
  if (!sections) throw new Error("INVALID_TIPTAP_SUBDOCUMENT_SOURCE");
  const rootGuid = `nowen-root-${stablePart(noteId)}`;
  const root = new Y.Doc({ guid: rootGuid });
  root.getArray<string>("sectionOrder").insert(0, sections.map((section) => section.id));
  const meta = root.getMap<string>("sectionGuids");
  for (const section of sections) meta.set(section.id, section.guid);
  const rootSnapshot = Buffer.from(Y.encodeStateAsUpdate(root));
  root.destroy();

  db.transaction(() => {
    db.prepare("DELETE FROM note_y_subdocuments WHERE noteId = ?").run(noteId);
    const insert = db.prepare(`
      INSERT INTO note_y_subdocuments (
        noteId, sectionId, guid, blockStart, blockEnd, snapshotBlob, payloadHash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const section of sections) {
      insert.run(
        noteId,
        section.id,
        section.guid,
        section.startBlock,
        section.endBlock,
        encodeSection(section),
        hash(section.content),
      );
    }
    db.prepare(`
      INSERT INTO note_y_subdocument_manifests (
        noteId, rootGuid, rootSnapshot, contentHash, sectionCount, status, mismatchReason, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 'healthy', NULL, datetime('now'))
      ON CONFLICT(noteId) DO UPDATE SET
        rootGuid = excluded.rootGuid,
        rootSnapshot = excluded.rootSnapshot,
        contentHash = excluded.contentHash,
        sectionCount = excluded.sectionCount,
        status = 'healthy', mismatchReason = NULL, updatedAt = datetime('now')
    `).run(noteId, rootGuid, rootSnapshot, hash(content), sections.length);
  })();
  return { rootGuid, sections };
}

/** 读取健康清单；只有缺失或与 notes.content 漂移时才重建，普通 GET 不得改写 Y.js 历史。 */
export function prepareYjsSubdocuments(
  db: Database.Database,
  noteId: string,
  content: string,
  maxBlocks = 250,
): YjsSubdocumentManifest {
  ensureYjsSubdocumentTables(db);
  const manifest = db.prepare(`
    SELECT rootGuid, rootSnapshot, contentHash, sectionCount, status
    FROM note_y_subdocument_manifests WHERE noteId = ?
  `).get(noteId) as {
    rootGuid: string;
    rootSnapshot: Buffer;
    contentHash: string;
    sectionCount: number;
    status: string;
  } | undefined;
  const rows = db.prepare(`
    SELECT sectionId, guid, blockStart, blockEnd
    FROM note_y_subdocuments WHERE noteId = ? ORDER BY blockStart
  `).all(noteId) as Array<{
    sectionId: string;
    guid: string;
    blockStart: number;
    blockEnd: number;
  }>;
  let rootMatches = false;
  if (manifest && manifest.status === "healthy" && manifest.contentHash === hash(content)) {
    const root = new Y.Doc({ guid: manifest.rootGuid });
    try {
      Y.applyUpdate(root, new Uint8Array(manifest.rootSnapshot));
      const order = root.getArray<string>("sectionOrder").toArray();
      const guids = root.getMap<string>("sectionGuids");
      rootMatches = order.length === rows.length
        && order.every((sectionId, index) => (
          sectionId === rows[index]?.sectionId
          && guids.get(sectionId) === rows[index]?.guid
        ));
    } catch {
      rootMatches = false;
    } finally {
      root.destroy();
    }
  }
  if (manifest && rootMatches && rows.length === manifest.sectionCount) {
    return {
      rootGuid: manifest.rootGuid,
      sections: rows.map((row) => ({
        id: row.sectionId,
        guid: row.guid,
        startBlock: row.blockStart,
        endBlock: row.blockEnd,
      })),
    };
  }
  const rebuilt = rebuildYjsSubdocuments(db, noteId, content, maxBlocks);
  return {
    rootGuid: rebuilt.rootGuid,
    sections: rebuilt.sections.map((section) => ({
      id: section.id,
      guid: section.guid,
      startBlock: section.startBlock,
      endBlock: section.endBlock,
    })),
  };
}

export function readYjsSubdocumentBundle(
  db: Database.Database,
  noteId: string,
  notesContent: string,
): { source: "subdocuments" | "notes"; content: string; status: "healthy" | "missing" | "mismatch" } {
  ensureYjsSubdocumentTables(db);
  const manifest = db.prepare(`
    SELECT contentHash, sectionCount, status FROM note_y_subdocument_manifests WHERE noteId = ?
  `).get(noteId) as { contentHash: string; sectionCount: number; status: string } | undefined;
  if (!manifest) return { source: "notes", content: notesContent, status: "missing" };
  const rows = db.prepare(`
    SELECT sectionId, guid, snapshotBlob, payloadHash
    FROM note_y_subdocuments WHERE noteId = ? ORDER BY blockStart
  `).all(noteId) as Array<{ sectionId: string; guid: string; snapshotBlob: Buffer; payloadHash: string }>;
  const nodes: any[] = [];
  let reason: string | null = null;
  if (manifest.status !== "healthy" || rows.length !== manifest.sectionCount || hash(notesContent) !== manifest.contentHash) {
    reason = "manifest_mismatch";
  } else {
    for (const row of rows) {
      const content = decodeSection(row.guid, row.snapshotBlob);
      const section = content ? parseDocument(content) : null;
      if (!content || !section || hash(content) !== row.payloadHash) {
        reason = `section_mismatch:${row.sectionId}`;
        break;
      }
      nodes.push(...section.content);
    }
  }
  const materialized = JSON.stringify({ type: "doc", content: nodes });
  if (!reason && hash(materialized) !== manifest.contentHash) reason = "materialized_mismatch";
  if (reason) {
    db.prepare(`UPDATE note_y_subdocument_manifests
      SET status = 'mismatch', mismatchReason = ?, updatedAt = datetime('now') WHERE noteId = ?`)
      .run(reason, noteId);
    return { source: "notes", content: notesContent, status: "mismatch" };
  }
  return { source: "subdocuments", content: materialized, status: "healthy" };
}

export function getYjsSubdocumentSnapshot(
  db: Database.Database,
  noteId: string,
  sectionId: string,
): { guid: string; snapshot: Uint8Array } | null {
  ensureYjsSubdocumentTables(db);
  const row = db.prepare(`SELECT guid, snapshotBlob FROM note_y_subdocuments WHERE noteId = ? AND sectionId = ?`)
    .get(noteId, sectionId) as { guid: string; snapshotBlob: Buffer } | undefined;
  return row ? { guid: row.guid, snapshot: new Uint8Array(row.snapshotBlob) } : null;
}

export function createYjsSubdocumentContentUpdate(
  guid: string,
  snapshot: Uint8Array,
  content: string,
): Uint8Array {
  if (!parseDocument(content)) throw new Error("INVALID_SUBDOCUMENT_CONTENT");
  const doc = new Y.Doc({ guid });
  try {
    Y.applyUpdate(doc, snapshot);
    const vector = Y.encodeStateVector(doc);
    const text = doc.getText("content");
    doc.transact(() => {
      if (text.length > 0) text.delete(0, text.length);
      text.insert(0, content);
    }, "subdocument-replace");
    return Y.encodeStateAsUpdate(doc, vector);
  } finally {
    doc.destroy();
  }
}

export function applyYjsSubdocumentUpdate(
  db: Database.Database,
  noteId: string,
  sectionId: string,
  update: Uint8Array,
  userId: string | null,
): { content: string; contentText: string; sectionGuid: string; version: number } {
  if (update.byteLength === 0 || update.byteLength > 1024 * 1024) throw new Error("INVALID_SUBDOCUMENT_UPDATE_SIZE");
  ensureYjsSubdocumentTables(db);
  const current = db.prepare(`
    SELECT guid, snapshotBlob FROM note_y_subdocuments WHERE noteId = ? AND sectionId = ?
  `).get(noteId, sectionId) as { guid: string; snapshotBlob: Buffer } | undefined;
  if (!current) throw new Error("SUBDOCUMENT_NOT_FOUND");
  const sectionDoc = new Y.Doc({ guid: current.guid });
  let sectionContent = "";
  let nextSnapshot: Buffer;
  try {
    Y.applyUpdate(sectionDoc, new Uint8Array(current.snapshotBlob));
    Y.applyUpdate(sectionDoc, update);
    sectionContent = sectionDoc.getText("content").toString();
    if (!parseDocument(sectionContent)) throw new Error("INVALID_SUBDOCUMENT_CONTENT");
    nextSnapshot = Buffer.from(Y.encodeStateAsUpdate(sectionDoc));
  } finally {
    sectionDoc.destroy();
  }

  let materialized = "";
  let contentText = "";
  let version = 0;
  db.transaction(() => {
    db.prepare(`UPDATE note_y_subdocuments
      SET snapshotBlob = ?, payloadHash = ?, updatedAt = datetime('now')
      WHERE noteId = ? AND sectionId = ?`)
      .run(nextSnapshot, hash(sectionContent), noteId, sectionId);
    db.prepare(`INSERT INTO note_y_subdocument_updates (noteId, sectionId, userId, updateBlob)
      VALUES (?, ?, ?, ?)`)
      .run(noteId, sectionId, userId, Buffer.from(update));
    const rows = db.prepare(`SELECT guid, snapshotBlob FROM note_y_subdocuments WHERE noteId = ? ORDER BY blockStart`)
      .all(noteId) as Array<{ guid: string; snapshotBlob: Buffer }>;
    const nodes: any[] = [];
    for (const row of rows) {
      const payload = decodeSection(row.guid, row.snapshotBlob);
      const doc = payload ? parseDocument(payload) : null;
      if (!doc) throw new Error("SUBDOCUMENT_MATERIALIZATION_FAILED");
      nodes.push(...doc.content);
    }
    materialized = JSON.stringify({ type: "doc", content: nodes });
    const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(noteId) as
      | { version: number }
      | undefined;
    if (!current) throw new Error("SUBDOCUMENT_NOTE_NOT_FOUND");
    const synced = syncNoteBlocks(db, noteId, materialized, "tiptap-json");
    // Subdocument 章节必须已经携带稳定 Block ID；若仍需规范化，章节快照会与整篇内容分叉。
    if (synced.changed) throw new Error("SUBDOCUMENT_NORMALIZATION_REQUIRED");
    materialized = synced.content;
    contentText = synced.contentText;
    version = current.version + 1;
    const updated = db.prepare(`UPDATE notes
      SET content = ?, contentText = ?, version = ?, updatedAt = datetime('now')
      WHERE id = ? AND version = ?`)
      .run(materialized, contentText, version, noteId, current.version);
    if (updated.changes !== 1) throw new Error("SUBDOCUMENT_VERSION_CONFLICT");
    db.prepare(`UPDATE note_y_subdocument_manifests
      SET contentHash = ?, status = 'healthy', mismatchReason = NULL, updatedAt = datetime('now') WHERE noteId = ?`)
      .run(hash(materialized), noteId);
    rebuildBlockAuthorityStore(db, noteId, materialized, "tiptap-json", {
      noteVersion: version,
      operationType: "yjs-subdocument-update",
      operationJson: { sectionId },
    });
  })();
  return { content: materialized, contentText, sectionGuid: current.guid, version };
}
