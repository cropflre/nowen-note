import { createHash, randomUUID } from "node:crypto";

import * as Y from "yjs";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { buildNoteBlockIndexPlan } from "../lib/noteBlocksRuntime";

interface NoteRow {
  content: string;
  contentFormat: string;
  contentText: string;
  title: string;
  userId: string;
  version: number;
}

interface ManifestRow {
  rootGuid: string;
  rootSnapshot: unknown;
  contentHash: string;
  sectionCount: number;
  generation: number;
  structureVersion: number;
  status: string;
}

interface SectionRow {
  sectionId: string;
  guid: string;
  blockStart: number;
  blockEnd: number;
  snapshotBlob: unknown;
  payloadHash: string;
}

interface StructureOperationRow {
  operationId: string;
  contentHash: string;
  resultGeneration: number;
  resultStructureVersion: number;
  resultVersion: number;
}

export interface PostgresYjsSubdocumentSection {
  id: string;
  guid: string;
  startBlock: number;
  endBlock: number;
}

interface PlannedSection extends PostgresYjsSubdocumentSection {
  content: string;
}

export interface PostgresYjsSubdocumentManifest {
  rootGuid: string;
  generation: number;
  structureVersion: number;
  sections: PostgresYjsSubdocumentSection[];
}

export interface PostgresYjsSubdocumentApplyResult {
  content: string;
  contentText: string;
  sectionGuid: string;
  version: number;
  generation: number;
  structureVersion: number;
}

export interface PostgresYjsSubdocumentStructureResult {
  content: string;
  contentText: string;
  version: number;
  generation: number;
  structureVersion: number;
  manifest: PostgresYjsSubdocumentManifest;
  operationId: string;
  replayed: boolean;
}

export class PostgresYjsSubdocumentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PostgresYjsSubdocumentRuntimeError";
  }
}

export interface PostgresYjsSubdocumentRuntime {
  prepare(noteId: string, maxBlocks?: number): Promise<PostgresYjsSubdocumentManifest | null>;
  getState(noteId: string, sectionId: string): Promise<{ guid: string; snapshot: Uint8Array } | null>;
  applyUpdate(
    noteId: string,
    sectionId: string,
    update: Uint8Array,
    actorUserId: string | null,
    expectedGeneration: number,
  ): Promise<PostgresYjsSubdocumentApplyResult>;
  applyStructureChange(
    noteId: string,
    content: string,
    actorUserId: string | null,
    expectedGeneration: number,
    operationId: string,
  ): Promise<PostgresYjsSubdocumentStructureResult>;
}

const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_STRUCTURE_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_OPERATION_ID_LENGTH = 200;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stablePart(value: unknown): string {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new PostgresYjsSubdocumentRuntimeError(
    "SUBDOCUMENT_INVALID_STORED_BINARY",
    "Stored subdocument binary is invalid",
  );
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

function splitSections(noteId: string, content: string, maxBlocks = 250): PlannedSection[] | null {
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

function sameStructure(
  previous: ReadonlyArray<PostgresYjsSubdocumentSection>,
  next: ReadonlyArray<PlannedSection>,
): boolean {
  return previous.length === next.length && previous.every((section, index) => (
    section.id === next[index]?.id
    && section.startBlock === next[index]?.startBlock
    && section.endBlock === next[index]?.endBlock
  ));
}

function encodeSection(section: Pick<PlannedSection, "guid" | "content">): Buffer {
  const doc = new Y.Doc({ guid: section.guid });
  try {
    doc.getText("content").insert(0, section.content);
    return Buffer.from(Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
}

function decodeSection(guid: string, snapshot: unknown): string {
  const doc = new Y.Doc({ guid });
  try {
    Y.applyUpdate(doc, toUint8Array(snapshot));
    const content = doc.getText("content").toString();
    if (!parseDocument(content)) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Stored subdocument content is invalid",
      );
    }
    return content;
  } catch (error) {
    if (error instanceof PostgresYjsSubdocumentRuntimeError) throw error;
    throw new PostgresYjsSubdocumentRuntimeError(
      "SUBDOCUMENT_INVALID_STORED_BINARY",
      "Stored subdocument snapshot could not be applied",
    );
  } finally {
    doc.destroy();
  }
}

function buildRootSnapshot(noteId: string, sections: ReadonlyArray<PlannedSection>): {
  rootGuid: string;
  rootSnapshot: Buffer;
} {
  const rootGuid = `nowen-root-${stablePart(noteId)}`;
  const root = new Y.Doc({ guid: rootGuid });
  try {
    root.getArray<string>("sectionOrder").insert(0, sections.map((section) => section.id));
    const guids = root.getMap<string>("sectionGuids");
    for (const section of sections) guids.set(section.id, section.guid);
    return { rootGuid, rootSnapshot: Buffer.from(Y.encodeStateAsUpdate(root)) };
  } finally {
    root.destroy();
  }
}

function manifestFromRows(manifest: ManifestRow, rows: ReadonlyArray<SectionRow>): PostgresYjsSubdocumentManifest {
  return {
    rootGuid: manifest.rootGuid,
    generation: Number(manifest.generation),
    structureVersion: Number(manifest.structureVersion),
    sections: rows.map((row) => ({
      id: row.sectionId,
      guid: row.guid,
      startBlock: Number(row.blockStart),
      endBlock: Number(row.blockEnd),
    })),
  };
}

function inferMaxBlocks(content: string, sections: ReadonlyArray<PostgresYjsSubdocumentSection>): number {
  const doc = parseDocument(content);
  if (!doc) return 250;
  const nonHeadingSizes = sections.slice(1).flatMap((section, index) => {
    const node = doc.content[section.startBlock];
    const headingBoundary = node?.type === "heading" && Number(node?.attrs?.level) <= 2;
    return headingBoundary ? [] : [sections[index]!.endBlock - sections[index]!.startBlock];
  });
  return nonHeadingSizes.length > 0 ? Math.max(10, ...nonHeadingSizes) : 250;
}

export function createPostgresYjsSubdocumentContentUpdate(
  guid: string,
  snapshot: Uint8Array,
  content: string,
): Uint8Array {
  if (!parseDocument(content)) {
    throw new PostgresYjsSubdocumentRuntimeError(
      "SUBDOCUMENT_INVALID_CONTENT",
      "Subdocument content must be a Tiptap document",
    );
  }
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

export function createPostgresYjsSubdocumentRuntime(
  adapter: DatabaseAdapter,
): PostgresYjsSubdocumentRuntime {
  async function readRows(noteId: string): Promise<SectionRow[]> {
    return adapter.queryMany<SectionRow>(
      `SELECT "sectionId" AS "sectionId", guid, "blockStart" AS "blockStart",
              "blockEnd" AS "blockEnd", "snapshotBlob" AS "snapshotBlob",
              "payloadHash" AS "payloadHash"
         FROM note_y_subdocuments
        WHERE "noteId" = ?
        ORDER BY "blockStart" ASC`,
      [noteId],
    );
  }

  async function readManifest(noteId: string): Promise<ManifestRow | undefined> {
    return adapter.queryOne<ManifestRow>(
      `SELECT "rootGuid" AS "rootGuid", "rootSnapshot" AS "rootSnapshot",
              "contentHash" AS "contentHash", "sectionCount" AS "sectionCount",
              generation, "structureVersion" AS "structureVersion", status
         FROM note_y_subdocument_manifests
        WHERE "noteId" = ?`,
      [noteId],
    );
  }

  async function prepare(noteId: string, maxBlocks = 250): Promise<PostgresYjsSubdocumentManifest | null> {
    const note = await adapter.queryOne<NoteRow>(
      `SELECT content, "contentFormat" AS "contentFormat", "contentText" AS "contentText",
              title, "userId" AS "userId", version
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!note) {
      throw new PostgresYjsSubdocumentRuntimeError("SUBDOCUMENT_NOTE_NOT_FOUND", "Note not found");
    }
    if (note.contentFormat !== "tiptap-json") return null;

    const blockPlan = buildNoteBlockIndexPlan(noteId, note.content, "tiptap-json");
    if (!blockPlan) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Tiptap note content is invalid",
      );
    }
    if (blockPlan.changed) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_NORMALIZATION_REQUIRED",
        "Tiptap blocks require stable block IDs before subdocuments can be prepared",
      );
    }

    const sections = splitSections(noteId, note.content, maxBlocks);
    if (!sections) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Tiptap note could not be split into subdocuments",
      );
    }

    const previous = await readManifest(noteId);
    const previousRows = previous ? await readRows(noteId) : [];
    if (
      previous
      && previous.status === "healthy"
      && previous.contentHash === hash(note.content)
      && Number(previous.sectionCount) === previousRows.length
      && previousRows.length === sections.length
    ) {
      let valid = true;
      for (let index = 0; index < previousRows.length; index += 1) {
        const row = previousRows[index]!;
        const section = sections[index]!;
        try {
          valid = row.sectionId === section.id
            && row.guid === section.guid
            && Number(row.blockStart) === section.startBlock
            && Number(row.blockEnd) === section.endBlock
            && decodeSection(row.guid, row.snapshotBlob) === section.content
            && row.payloadHash === hash(section.content);
        } catch {
          valid = false;
        }
        if (!valid) break;
      }
      if (valid) return manifestFromRows(previous, previousRows);
    }

    const previousManifest = previous && previousRows.length > 0
      ? manifestFromRows(previous, previousRows)
      : null;
    const structureChanged = previousManifest != null && !sameStructure(previousManifest.sections, sections);
    const generation = previous ? Number(previous.generation) + 1 : 1;
    const structureVersion = previous
      ? Number(previous.structureVersion) + (structureChanged ? 1 : 0)
      : 1;
    const { rootGuid, rootSnapshot } = buildRootSnapshot(noteId, sections);

    const statements: DbStatement[] = [
      { sql: `DELETE FROM note_y_subdocument_updates WHERE "noteId" = ?`, params: [noteId] },
      { sql: `DELETE FROM note_y_subdocuments WHERE "noteId" = ?`, params: [noteId] },
    ];
    for (const section of sections) {
      statements.push({
        sql: `INSERT INTO note_y_subdocuments (
                "noteId", "sectionId", guid, "blockStart", "blockEnd",
                "snapshotBlob", "payloadHash", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        params: [
          noteId,
          section.id,
          section.guid,
          section.startBlock,
          section.endBlock,
          encodeSection(section),
          hash(section.content),
        ],
      });
    }
    statements.push({
      sql: `INSERT INTO note_y_subdocument_manifests (
              "noteId", "rootGuid", "rootSnapshot", "contentHash", "sectionCount",
              generation, "structureVersion", status, "mismatchReason", "updatedAt"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'healthy', NULL, CURRENT_TIMESTAMP)
            ON CONFLICT ("noteId") DO UPDATE SET
              "rootGuid" = EXCLUDED."rootGuid",
              "rootSnapshot" = EXCLUDED."rootSnapshot",
              "contentHash" = EXCLUDED."contentHash",
              "sectionCount" = EXCLUDED."sectionCount",
              generation = EXCLUDED.generation,
              "structureVersion" = EXCLUDED."structureVersion",
              status = 'healthy',
              "mismatchReason" = NULL,
              "updatedAt" = CURRENT_TIMESTAMP`,
      params: [
        noteId,
        rootGuid,
        rootSnapshot,
        hash(note.content),
        sections.length,
        generation,
        structureVersion,
      ],
    });
    await adapter.executeStatements(statements);

    return {
      rootGuid,
      generation,
      structureVersion,
      sections: sections.map(({ id, guid, startBlock, endBlock }) => ({
        id,
        guid,
        startBlock,
        endBlock,
      })),
    };
  }

  async function getState(noteId: string, sectionId: string) {
    const row = await adapter.queryOne<{ guid: string; snapshotBlob: unknown }>(
      `SELECT guid, "snapshotBlob" AS "snapshotBlob"
         FROM note_y_subdocuments
        WHERE "noteId" = ? AND "sectionId" = ?`,
      [noteId, sectionId],
    );
    return row ? { guid: row.guid, snapshot: toUint8Array(row.snapshotBlob) } : null;
  }

  async function applyUpdate(
    noteId: string,
    sectionId: string,
    update: Uint8Array,
    actorUserId: string | null,
    expectedGeneration: number,
  ): Promise<PostgresYjsSubdocumentApplyResult> {
    if (update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_UPDATE_SIZE",
        `Subdocument update must be between 1 and ${MAX_UPDATE_BYTES} bytes`,
      );
    }

    const manifest = await readManifest(noteId);
    const rows = manifest ? await readRows(noteId) : [];
    if (!manifest || rows.length === 0) {
      throw new PostgresYjsSubdocumentRuntimeError("SUBDOCUMENT_NOT_FOUND", "Subdocument manifest not found");
    }
    if (Number(manifest.generation) !== expectedGeneration) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_GENERATION_CONFLICT",
        "Subdocument generation changed; prepare and rejoin before writing",
        { currentManifest: manifestFromRows(manifest, rows) },
      );
    }

    const note = await adapter.queryOne<NoteRow>(
      `SELECT content, "contentFormat" AS "contentFormat", "contentText" AS "contentText",
              title, "userId" AS "userId", version
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!note) {
      throw new PostgresYjsSubdocumentRuntimeError("SUBDOCUMENT_NOTE_NOT_FOUND", "Note not found");
    }
    if (note.contentFormat !== "tiptap-json") {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_UNSUPPORTED_CONTENT_FORMAT",
        "Subdocument writes require Tiptap JSON notes",
      );
    }

    const target = rows.find((row) => row.sectionId === sectionId);
    if (!target) {
      throw new PostgresYjsSubdocumentRuntimeError("SUBDOCUMENT_NOT_FOUND", "Subdocument section not found");
    }

    const sectionDoc = new Y.Doc({ guid: target.guid });
    let nextSectionContent = "";
    let nextSectionSnapshot: Buffer;
    try {
      Y.applyUpdate(sectionDoc, toUint8Array(target.snapshotBlob));
      Y.applyUpdate(sectionDoc, update);
      nextSectionContent = sectionDoc.getText("content").toString();
      if (!parseDocument(nextSectionContent)) {
        throw new PostgresYjsSubdocumentRuntimeError(
          "SUBDOCUMENT_INVALID_CONTENT",
          "Updated section is not a Tiptap document",
        );
      }
      nextSectionSnapshot = Buffer.from(Y.encodeStateAsUpdate(sectionDoc));
    } catch (error) {
      if (error instanceof PostgresYjsSubdocumentRuntimeError) throw error;
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_UPDATE",
        "Subdocument update could not be applied",
      );
    } finally {
      sectionDoc.destroy();
    }

    const materializedNodes: any[] = [];
    for (const row of rows) {
      const sectionContent = row.sectionId === sectionId
        ? nextSectionContent
        : decodeSection(row.guid, row.snapshotBlob);
      const section = parseDocument(sectionContent);
      if (!section) {
        throw new PostgresYjsSubdocumentRuntimeError(
          "SUBDOCUMENT_MATERIALIZATION_FAILED",
          `Section ${row.sectionId} could not be materialized`,
        );
      }
      materializedNodes.push(...section.content);
    }
    const materialized = JSON.stringify({ type: "doc", content: materializedNodes });
    const currentManifest = manifestFromRows(manifest, rows);
    const nextSections = splitSections(noteId, materialized, inferMaxBlocks(note.content, currentManifest.sections));
    if (!nextSections || !sameStructure(currentManifest.sections, nextSections)) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_STRUCTURE_CHANGE_PENDING",
        "This update changes section boundaries; PostgreSQL structure-changing writes are not migrated yet",
      );
    }

    const blockPlan = buildNoteBlockIndexPlan(noteId, materialized, "tiptap-json");
    if (!blockPlan) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Materialized Tiptap content is invalid",
      );
    }
    if (blockPlan.changed) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_NORMALIZATION_REQUIRED",
        "Updated sections must preserve stable block IDs",
      );
    }

    const version = Number(note.version) + 1;
    const statements: DbStatement[] = [
      {
        sql: `UPDATE notes
                 SET content = ?, "contentText" = ?, version = ?, "updatedAt" = CURRENT_TIMESTAMP
               WHERE id = ? AND version = ? AND "contentFormat" = 'tiptap-json'`,
        params: [blockPlan.content, blockPlan.contentText, version, noteId, note.version],
        requireChanges: 1,
      },
      {
        sql: `UPDATE note_y_subdocuments
                 SET "snapshotBlob" = ?, "payloadHash" = ?, "updatedAt" = CURRENT_TIMESTAMP
               WHERE "noteId" = ? AND "sectionId" = ?
                 AND EXISTS (
                   SELECT 1 FROM note_y_subdocument_manifests
                    WHERE "noteId" = ? AND generation = ?
                 )`,
        params: [
          nextSectionSnapshot,
          hash(nextSectionContent),
          noteId,
          sectionId,
          noteId,
          expectedGeneration,
        ],
        requireChanges: 1,
      },
      {
        sql: `INSERT INTO note_y_subdocument_updates (
                "noteId", "sectionId", "userId", "updateBlob", "createdAt"
              ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        params: [noteId, sectionId, actorUserId, Buffer.from(update)],
        requireChanges: 1,
      },
      {
        sql: `UPDATE note_y_subdocument_manifests
                 SET "contentHash" = ?, status = 'healthy', "mismatchReason" = NULL,
                     "updatedAt" = CURRENT_TIMESTAMP
               WHERE "noteId" = ? AND generation = ?`,
        params: [hash(blockPlan.content), noteId, expectedGeneration],
        requireChanges: 1,
      },
      {
        sql: `INSERT INTO note_versions (
                id, "noteId", "userId", title, content, "contentText",
                "contentFormat", version, "changeType", "changeSummary", "createdAt"
              ) VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', ?, 'edit', ?, CURRENT_TIMESTAMP)`,
        params: [
          randomUUID(),
          noteId,
          actorUserId || note.userId,
          note.title,
          note.content,
          note.contentText,
          note.version,
          `Yjs subdocument update: ${sectionId}`,
        ],
      },
      { sql: `DELETE FROM note_blocks_index WHERE "noteId" = ?`, params: [noteId] },
    ];

    for (const block of blockPlan.rows) {
      statements.push({
        sql: `INSERT INTO note_blocks_index (
                "noteId", "blockId", "blockType", "parentBlockId", "blockOrder",
                "plainText", "contentHash", path, "startOffset", "endOffset",
                "createdAt", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        params: [
          block.noteId,
          block.blockId,
          block.blockType,
          block.parentBlockId,
          block.blockOrder,
          block.plainText,
          block.contentHash,
          block.path,
          block.startOffset,
          block.endOffset,
        ],
      });
    }

    // Tiptap subdocuments become the authoritative CRDT history for this note.
    statements.push(
      { sql: `DELETE FROM note_yupdates WHERE "noteId" = ?`, params: [noteId] },
      { sql: `DELETE FROM note_ysnapshots WHERE "noteId" = ?`, params: [noteId] },
    );

    try {
      await adapter.executeStatements(statements);
    } catch (error) {
      if (error instanceof DbStatementChangeError) {
        const latest = await adapter.queryOne<{ version: number; generation: number }>(
          `SELECT n.version, m.generation
             FROM notes n
             LEFT JOIN note_y_subdocument_manifests m ON m."noteId" = n.id
            WHERE n.id = ?`,
          [noteId],
        );
        throw new PostgresYjsSubdocumentRuntimeError(
          "SUBDOCUMENT_WRITE_CONFLICT",
          "The note or subdocument generation changed; prepare and rejoin before writing",
          {
            currentVersion: latest?.version ?? null,
            currentGeneration: latest?.generation ?? null,
          },
        );
      }
      throw error;
    }

    return {
      content: blockPlan.content,
      contentText: blockPlan.contentText,
      sectionGuid: target.guid,
      version,
      generation: expectedGeneration,
      structureVersion: Number(manifest.structureVersion),
    };
  }


  async function readStructureOperation(
    noteId: string,
    operationId: string,
  ): Promise<StructureOperationRow | undefined> {
    return adapter.queryOne<StructureOperationRow>(
      `SELECT "operationId" AS "operationId", "contentHash" AS "contentHash",
              "resultGeneration" AS "resultGeneration",
              "resultStructureVersion" AS "resultStructureVersion",
              "resultVersion" AS "resultVersion"
         FROM note_y_subdocument_structure_operations
        WHERE "noteId" = ? AND "operationId" = ?`,
      [noteId, operationId],
    );
  }

  async function replayStructureOperation(
    noteId: string,
    operationId: string,
    requestedContentHash: string,
    operation: StructureOperationRow,
  ): Promise<PostgresYjsSubdocumentStructureResult> {
    if (operation.contentHash !== requestedContentHash) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_OPERATION_REUSED",
        "The structure operation ID was already used with different content",
        { operationId },
      );
    }
    const manifest = await readManifest(noteId);
    const rows = manifest ? await readRows(noteId) : [];
    const note = await adapter.queryOne<NoteRow>(
      `SELECT content, "contentFormat" AS "contentFormat", "contentText" AS "contentText",
              title, "userId" AS "userId", version
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!manifest || rows.length === 0 || !note) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_OPERATION_STATE_MISSING",
        "The persisted structure operation no longer has a readable manifest",
        { operationId },
      );
    }
    if (Number(manifest.generation) < Number(operation.resultGeneration)) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_OPERATION_STATE_MISMATCH",
        "The current manifest is older than the persisted operation result",
        { operationId },
      );
    }
    return {
      content: note.content,
      contentText: note.contentText,
      version: Number(note.version),
      generation: Number(manifest.generation),
      structureVersion: Number(manifest.structureVersion),
      manifest: manifestFromRows(manifest, rows),
      operationId,
      replayed: true,
    };
  }

  async function applyStructureChange(
    noteId: string,
    content: string,
    actorUserId: string | null,
    expectedGeneration: number,
    operationId: string,
  ): Promise<PostgresYjsSubdocumentStructureResult> {
    const normalizedOperationId = String(operationId || "").trim();
    if (
      normalizedOperationId.length === 0
      || normalizedOperationId.length > MAX_OPERATION_ID_LENGTH
      || !/^[A-Za-z0-9._:-]+$/u.test(normalizedOperationId)
    ) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_OPERATION_ID_INVALID",
        "Structure operationId must be a stable 1-200 character identifier",
      );
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Structure changes require a complete Tiptap document",
      );
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_STRUCTURE_CONTENT_BYTES) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_STRUCTURE_CONTENT_TOO_LARGE",
        `Structure content must not exceed ${MAX_STRUCTURE_CONTENT_BYTES} bytes`,
        { maxBytes: MAX_STRUCTURE_CONTENT_BYTES, actualBytes: contentBytes },
      );
    }
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_GENERATION_REQUIRED",
        "A positive expected generation is required",
      );
    }

    const requestedContentHash = hash(content);
    const previousOperation = await readStructureOperation(noteId, normalizedOperationId);
    if (previousOperation) {
      return replayStructureOperation(
        noteId,
        normalizedOperationId,
        requestedContentHash,
        previousOperation,
      );
    }

    const manifest = await readManifest(noteId);
    const rows = manifest ? await readRows(noteId) : [];
    if (!manifest || rows.length === 0 || manifest.status !== "healthy") {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_NOT_FOUND",
        "A healthy subdocument manifest is required before changing structure",
      );
    }
    const currentManifest = manifestFromRows(manifest, rows);
    if (Number(manifest.generation) !== expectedGeneration) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_GENERATION_CONFLICT",
        "Subdocument generation changed; reload before changing structure",
        { currentManifest },
      );
    }

    const note = await adapter.queryOne<NoteRow>(
      `SELECT content, "contentFormat" AS "contentFormat", "contentText" AS "contentText",
              title, "userId" AS "userId", version
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!note) {
      throw new PostgresYjsSubdocumentRuntimeError("SUBDOCUMENT_NOTE_NOT_FOUND", "Note not found");
    }
    if (note.contentFormat !== "tiptap-json") {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_UNSUPPORTED_CONTENT_FORMAT",
        "Structure changes require Tiptap JSON notes",
      );
    }

    const blockPlan = buildNoteBlockIndexPlan(noteId, content, "tiptap-json");
    if (!blockPlan) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Structure content is not a valid Tiptap document",
      );
    }
    if (blockPlan.changed) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_NORMALIZATION_REQUIRED",
        "Structure changes must preserve stable block IDs",
      );
    }

    const nextSections = splitSections(
      noteId,
      blockPlan.content,
      inferMaxBlocks(note.content, currentManifest.sections),
    );
    if (!nextSections) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_INVALID_CONTENT",
        "Structure content could not be split into subdocuments",
      );
    }
    if (sameStructure(currentManifest.sections, nextSections)) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_STRUCTURE_UNCHANGED",
        "Use a stable-section update when section boundaries do not change",
      );
    }

    const generation = expectedGeneration + 1;
    const structureVersion = Number(manifest.structureVersion) + 1;
    const version = Number(note.version) + 1;
    const { rootGuid, rootSnapshot } = buildRootSnapshot(noteId, nextSections);
    const nextManifest: PostgresYjsSubdocumentManifest = {
      rootGuid,
      generation,
      structureVersion,
      sections: nextSections.map(({ id, guid, startBlock, endBlock }) => ({
        id,
        guid,
        startBlock,
        endBlock,
      })),
    };

    const statements: DbStatement[] = [
      {
        sql: `UPDATE notes
                 SET content = ?, "contentText" = ?, version = ?, "updatedAt" = CURRENT_TIMESTAMP
               WHERE id = ? AND version = ? AND "contentFormat" = 'tiptap-json'`,
        params: [blockPlan.content, blockPlan.contentText, version, noteId, note.version],
        requireChanges: 1,
      },
      {
        sql: `INSERT INTO note_versions (
                id, "noteId", "userId", title, content, "contentText",
                "contentFormat", version, "changeType", "changeSummary", "createdAt"
              ) VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', ?, 'edit', ?, CURRENT_TIMESTAMP)`,
        params: [
          randomUUID(),
          noteId,
          actorUserId || note.userId,
          note.title,
          note.content,
          note.contentText,
          note.version,
          `Yjs subdocument structure change: ${normalizedOperationId}`,
        ],
      },
      { sql: `DELETE FROM note_blocks_index WHERE "noteId" = ?`, params: [noteId] },
    ];

    for (const block of blockPlan.rows) {
      statements.push({
        sql: `INSERT INTO note_blocks_index (
                "noteId", "blockId", "blockType", "parentBlockId", "blockOrder",
                "plainText", "contentHash", path, "startOffset", "endOffset",
                "createdAt", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        params: [
          block.noteId,
          block.blockId,
          block.blockType,
          block.parentBlockId,
          block.blockOrder,
          block.plainText,
          block.contentHash,
          block.path,
          block.startOffset,
          block.endOffset,
        ],
      });
    }

    statements.push(
      { sql: `DELETE FROM note_y_subdocument_updates WHERE "noteId" = ?`, params: [noteId] },
      { sql: `DELETE FROM note_y_subdocuments WHERE "noteId" = ?`, params: [noteId] },
    );
    for (const section of nextSections) {
      statements.push({
        sql: `INSERT INTO note_y_subdocuments (
                "noteId", "sectionId", guid, "blockStart", "blockEnd",
                "snapshotBlob", "payloadHash", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        params: [
          noteId,
          section.id,
          section.guid,
          section.startBlock,
          section.endBlock,
          encodeSection(section),
          hash(section.content),
        ],
      });
    }
    statements.push(
      {
        sql: `UPDATE note_y_subdocument_manifests
                 SET "rootGuid" = ?, "rootSnapshot" = ?, "contentHash" = ?,
                     "sectionCount" = ?, generation = ?, "structureVersion" = ?,
                     status = 'healthy', "mismatchReason" = NULL,
                     "updatedAt" = CURRENT_TIMESTAMP
               WHERE "noteId" = ? AND generation = ?`,
        params: [
          rootGuid,
          rootSnapshot,
          hash(blockPlan.content),
          nextSections.length,
          generation,
          structureVersion,
          noteId,
          expectedGeneration,
        ],
        requireChanges: 1,
      },
      {
        sql: `INSERT INTO note_y_subdocument_structure_operations (
                "noteId", "operationId", "userId", "baseGeneration",
                "resultGeneration", "resultStructureVersion", "resultVersion",
                "contentHash", "createdAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        params: [
          noteId,
          normalizedOperationId,
          actorUserId,
          expectedGeneration,
          generation,
          structureVersion,
          version,
          requestedContentHash,
        ],
        requireChanges: 1,
      },
      { sql: `DELETE FROM note_yupdates WHERE "noteId" = ?`, params: [noteId] },
      { sql: `DELETE FROM note_ysnapshots WHERE "noteId" = ?`, params: [noteId] },
    );

    try {
      await adapter.executeStatements(statements);
    } catch (error) {
      const concurrentOperation = await readStructureOperation(noteId, normalizedOperationId);
      if (concurrentOperation) {
        return replayStructureOperation(
          noteId,
          normalizedOperationId,
          requestedContentHash,
          concurrentOperation,
        );
      }
      if (error instanceof DbStatementChangeError) {
        const latestManifest = await readManifest(noteId);
        const latestRows = latestManifest ? await readRows(noteId) : [];
        const latestNote = await adapter.queryOne<{ version: number }>(
          `SELECT version FROM notes WHERE id = ?`,
          [noteId],
        );
        throw new PostgresYjsSubdocumentRuntimeError(
          "SUBDOCUMENT_WRITE_CONFLICT",
          "The note or manifest changed while rebuilding subdocuments",
          {
            currentVersion: latestNote?.version ?? null,
            currentManifest: latestManifest && latestRows.length > 0
              ? manifestFromRows(latestManifest, latestRows)
              : null,
          },
        );
      }
      throw error;
    }

    return {
      content: blockPlan.content,
      contentText: blockPlan.contentText,
      version,
      generation,
      structureVersion,
      manifest: nextManifest,
      operationId: normalizedOperationId,
      replayed: false,
    };
  }

  return { prepare, getState, applyUpdate, applyStructureChange };
}

export default createPostgresYjsSubdocumentRuntime;
