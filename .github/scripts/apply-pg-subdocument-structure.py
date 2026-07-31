#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} matches, found {count}")
    return text.replace(old, new)


migration = '''CREATE TABLE IF NOT EXISTS note_y_subdocument_structure_operations (
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "operationId" TEXT NOT NULL,
  "userId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "baseGeneration" INTEGER NOT NULL,
  "resultGeneration" INTEGER NOT NULL,
  "resultStructureVersion" INTEGER NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("noteId", "operationId"),
  CONSTRAINT note_y_subdocument_structure_generation_order
    CHECK ("resultGeneration" > "baseGeneration"),
  CONSTRAINT note_y_subdocument_structure_versions_positive
    CHECK (
      "baseGeneration" >= 1
      AND "resultGeneration" >= 2
      AND "resultStructureVersion" >= 2
      AND "resultVersion" >= 1
    )
);

CREATE INDEX IF NOT EXISTS idx_note_y_subdocument_structure_operations_created
  ON note_y_subdocument_structure_operations ("noteId", "createdAt" DESC);
'''
write("backend/src/db/postgres/migrations/0014_yjs_subdocument_structure_operations.sql", migration)

runtime_path = "backend/src/services/postgres-yjs-subdocuments-runtime.ts"
runtime = read(runtime_path)

runtime = replace_once(
    runtime,
    '''interface SectionRow {
  sectionId: string;
  guid: string;
  blockStart: number;
  blockEnd: number;
  snapshotBlob: unknown;
  payloadHash: string;
}
''',
    '''interface SectionRow {
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
''',
    "runtime structure operation row",
)

runtime = replace_once(
    runtime,
    '''export interface PostgresYjsSubdocumentApplyResult {
  content: string;
  contentText: string;
  sectionGuid: string;
  version: number;
  generation: number;
  structureVersion: number;
}
''',
    '''export interface PostgresYjsSubdocumentApplyResult {
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
''',
    "runtime structure result",
)

runtime = replace_once(
    runtime,
    '''  applyUpdate(
    noteId: string,
    sectionId: string,
    update: Uint8Array,
    actorUserId: string | null,
    expectedGeneration: number,
  ): Promise<PostgresYjsSubdocumentApplyResult>;
}

const MAX_UPDATE_BYTES = 1024 * 1024;
''',
    '''  applyUpdate(
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
''',
    "runtime interface",
)

structure_function = r'''
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

'''

runtime = replace_once(
    runtime,
    '''  return { prepare, getState, applyUpdate };
''',
    structure_function + '''  return { prepare, getState, applyUpdate, applyStructureChange };
''',
    "runtime structure function",
)
write(runtime_path, runtime)

ws_path = "backend/src/services/postgres-yjs-subdocuments-websocket-runtime.ts"
ws = read(ws_path)
ws = replace_once(
    ws,
    '''  update?: string;
  generation?: number;
}
''',
    '''  update?: string;
  content?: string;
  operationId?: string;
  generation?: number;
}
''',
    "ws client message",
)
ws = replace_once(
    ws,
    '''  maxUpdateBytes?: number;
  publishMutation?: (event: PostgresYjsSubdocumentMutationEvent) => Promise<void>;
''',
    '''  maxUpdateBytes?: number;
  maxStructureContentBytes?: number;
  publishMutation?: (event: PostgresYjsSubdocumentMutationEvent) => Promise<void>;
''',
    "ws options",
)
ws = replace_once(
    ws,
    '''    updates: number;
    invalidations: number;
''',
    '''    updates: number;
    structureChanges: number;
    invalidations: number;
''',
    "ws stats interface",
)
ws = replace_once(
    ws,
    '''const DEFAULT_MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 200;
''',
    '''const DEFAULT_MAX_UPDATE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STRUCTURE_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 200;
''',
    "ws constants",
)
ws = replace_once(
    ws,
    '''  const maxUpdateBytes = options.maxUpdateBytes ?? DEFAULT_MAX_UPDATE_BYTES;
  const repository = createPostgresSubdocumentWebsocketRepository(adapter);
''',
    '''  const maxUpdateBytes = options.maxUpdateBytes ?? DEFAULT_MAX_UPDATE_BYTES;
  const maxStructureContentBytes = options.maxStructureContentBytes
    ?? DEFAULT_MAX_STRUCTURE_CONTENT_BYTES;
  const repository = createPostgresSubdocumentWebsocketRepository(adapter);
''',
    "ws max structure",
)
ws = replace_once(
    ws,
    '''  let updates = 0;
  let invalidations = 0;
''',
    '''  let updates = 0;
  let structureChanges = 0;
  let invalidations = 0;
''',
    "ws counters",
)

handle_structure = r'''
  async function handleStructureChange(
    client: RuntimeClient,
    message: ClientMessage,
    noteId: string,
  ): Promise<void> {
    if (!client.joinedNotes.has(noteId)) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_NOT_JOINED",
        error: "Join the manifest before changing structure",
      });
      return;
    }
    if (!(await canWrite(noteId, client))) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "FORBIDDEN",
        error: "Write permission required",
      });
      return;
    }
    if (!Number.isInteger(message.generation) || Number(message.generation) < 1) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_GENERATION_REQUIRED",
        error: "Missing generation",
      });
      return;
    }
    if (!validId(message.operationId)) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_OPERATION_ID_INVALID",
        error: "Missing or invalid operationId",
      });
      return;
    }
    if (typeof message.content !== "string" || message.content.length === 0) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_INVALID_CONTENT",
        error: "Missing structure content",
      });
      return;
    }
    const contentBytes = Buffer.byteLength(message.content, "utf8");
    if (contentBytes > maxStructureContentBytes) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_STRUCTURE_CONTENT_TOO_LARGE",
        error: `Structure content must not exceed ${maxStructureContentBytes} bytes`,
        details: { maxBytes: maxStructureContentBytes, actualBytes: contentBytes },
      });
      return;
    }

    try {
      const persisted = await subdocuments.applyStructureChange(
        noteId,
        message.content,
        client.userId,
        Number(message.generation),
        message.operationId,
      );
      if (!persisted.replayed) structureChanges += 1;
      knownGenerations.set(noteId, persisted.generation);
      send(client.ws, {
        type: "y:subdoc:structure-ack",
        noteId,
        operationId: persisted.operationId,
        version: persisted.version,
        generation: persisted.generation,
        structureVersion: persisted.structureVersion,
        manifest: persisted.manifest,
        replayed: persisted.replayed,
      });
      invalidateNote(
        noteId,
        persisted.replayed ? "structure-operation-replayed" : "structure-changed",
        persisted.manifest,
      );
      try {
        await publishNoteMutation(noteId, client, persisted.version, persisted.contentText);
      } catch (publishError) {
        console.warn(
          "[postgres-subdocument-ws] structure mutation publish failed:",
          errorMessage(publishError),
        );
      }
    } catch (error) {
      if (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && ["SUBDOCUMENT_GENERATION_CONFLICT", "SUBDOCUMENT_WRITE_CONFLICT"].includes(error.code)
      ) {
        invalidateNote(
          noteId,
          error.code,
          error.details?.currentManifest as PostgresYjsSubdocumentManifest | undefined,
        );
      }
      sendError(client, error, noteId);
    }
  }

'''
ws = replace_once(
    ws,
    '''  async function handleMessage(client: RuntimeClient, data: RawData): Promise<void> {
''',
    handle_structure + '''  async function handleMessage(client: RuntimeClient, data: RawData): Promise<void> {
''',
    "ws structure handler",
)
ws = replace_once(
    ws,
    '''    if (message.type === "y:subdoc:update") {
      if (!noteId || !sectionId) {
''',
    '''    if (message.type === "y:subdoc:structure") {
      if (!noteId) {
        send(client.ws, {
          type: "error",
          code: "SUBDOCUMENT_NOTE_ID_REQUIRED",
          error: "Missing noteId",
        });
        return;
      }
      await handleStructureChange(client, message, noteId);
      return;
    }

    if (message.type === "y:subdoc:update") {
      if (!noteId || !sectionId) {
''',
    "ws structure dispatch",
)
ws = replace_once(
    ws,
    '''            "yjs-subdocument-stable-section-write",
          ],
          pendingCapabilities: ["yjs-subdocument-structure-change"],
''',
    '''            "yjs-subdocument-stable-section-write",
            "yjs-subdocument-structure-change",
            "yjs-subdocument-idempotent-structure-operations",
          ],
          pendingCapabilities: [],
''',
    "ws capabilities",
)
ws = replace_once(
    ws,
    '''      updates,
      invalidations,
''',
    '''      updates,
      structureChanges,
      invalidations,
''',
    "ws stats return",
)
ws = ws.replace(
    "[postgres-subdocument-ws] stable-section protocol attached at",
    "[postgres-subdocument-ws] stable-section and structure protocol attached at",
)
write(ws_path, ws)

index_path = "backend/src/index.postgres-runtime.ts"
index = read(index_path)
index = replace_once(
    index,
    '''        "WS /ws/subdocuments (Tiptap manifest/state and stable-section Yjs writes)",
''',
    '''        "WS /ws/subdocuments (Tiptap manifest/state, stable-section and structure-changing Yjs writes)",
''',
    "runtime route description",
)
index = replace_once(
    index,
    '''        "Yjs subdocument manifest/state and stable-section write protocol",
''',
    '''        "Yjs subdocument manifest/state and stable-section write protocol",
        "Yjs subdocument idempotent structure changes and root manifest rebuild",
''',
    "runtime capability",
)
index = replace_once(
    index,
    '''        "notes full-text search (#252)",
        "Yjs subdocument structure-changing writes",
''',
    '''        "notes full-text search (#252)",
''',
    "runtime pending capability",
)
index = replace_once(
    index,
    '''console.warn("[db] Notes runtime includes PostgreSQL-safe rooms, Yjs read/write sync, snapshot compaction and stable-section subdocument writes; structure-changing subdocument writes remain disabled until #249 completes");
''',
    '''console.warn("[db] Notes runtime includes PostgreSQL-safe rooms, Yjs read/write sync, snapshot compaction, stable-section writes and idempotent subdocument structure rebuilds; production cutover remains disabled until the remaining PostgreSQL phases complete");
''',
    "runtime warning",
)
write(index_path, index)

structure_test = r'''import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createPostgresYjsSubdocumentRuntime,
  PostgresYjsSubdocumentRuntimeError,
} from "../src/services/postgres-yjs-subdocuments-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-yjs-structure-user";
const NOTEBOOK = "pg-yjs-structure-notebook";
const NOTE = "f8888888-8888-4888-8888-888888888888";

function text(value: string) {
  return { type: "text", text: value };
}

function heading(blockId: string, value: string, level = 2) {
  return { type: "heading", attrs: { level, blockId }, content: [text(value)] };
}

function paragraph(blockId: string, value: string) {
  return { type: "paragraph", attrs: { blockId }, content: [text(value)] };
}

function document(nodes: unknown[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

const baseContent = document([
  heading("blk_structure_one", "One", 1),
  paragraph("blk_structure_alpha", "Alpha"),
  heading("blk_structure_two", "Two", 2),
  paragraph("blk_structure_beta", "Beta"),
]);

const expandedContent = document([
  heading("blk_structure_one", "One", 1),
  paragraph("blk_structure_alpha", "Alpha"),
  heading("blk_structure_two", "Two", 2),
  paragraph("blk_structure_beta", "Beta"),
  heading("blk_structure_three", "Three", 2),
  paragraph("blk_structure_gamma", "Gamma"),
]);

const movedAndMergedContent = document([
  heading("blk_structure_three", "Three", 1),
  paragraph("blk_structure_gamma", "Gamma"),
  heading("blk_structure_one", "One", 2),
  paragraph("blk_structure_alpha", "Alpha"),
]);

test("PostgreSQL Yjs subdocument structure changes rebuild atomically and retry idempotently", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Yjs structure')`,
    [NOTEBOOK, USER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Structure', $4, 'One Alpha Two Beta', 'tiptap-json', 1)`,
    [NOTE, USER, NOTEBOOK, baseContent],
  );

  const runtime = createPostgresYjsSubdocumentRuntime(new PostgresAdapter(pool));
  try {
    const initial = await runtime.prepare(NOTE);
    assert.ok(initial);
    assert.equal(initial.generation, 1);
    assert.equal(initial.structureVersion, 1);
    assert.equal(initial.sections.length, 2);

    const expanded = await runtime.applyStructureChange(
      NOTE,
      expandedContent,
      USER,
      initial.generation,
      "structure-add-third",
    );
    assert.equal(expanded.replayed, false);
    assert.equal(expanded.version, 2);
    assert.equal(expanded.generation, 2);
    assert.equal(expanded.structureVersion, 2);
    assert.equal(expanded.manifest.sections.length, 3);
    assert.deepEqual(
      expanded.manifest.sections.map((section) => section.id),
      [
        "section-blk_structure_one",
        "section-blk_structure_two",
        "section-blk_structure_three",
      ],
    );

    const firstManifest = (await pool.query(
      `SELECT generation, "structureVersion", "sectionCount", octet_length("rootSnapshot") AS bytes
         FROM note_y_subdocument_manifests WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(Number(firstManifest.generation), 2);
    assert.equal(Number(firstManifest.structureVersion), 2);
    assert.equal(Number(firstManifest.sectionCount), 3);
    assert.ok(Number(firstManifest.bytes) > 0);

    const replayed = await runtime.applyStructureChange(
      NOTE,
      expandedContent,
      USER,
      initial.generation,
      "structure-add-third",
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.version, 2);
    assert.equal(replayed.generation, 2);
    assert.equal(replayed.manifest.sections.length, 3);

    await assert.rejects(
      runtime.applyStructureChange(
        NOTE,
        movedAndMergedContent,
        USER,
        2,
        "structure-add-third",
      ),
      (error: unknown) => (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && error.code === "SUBDOCUMENT_OPERATION_REUSED"
      ),
    );

    await assert.rejects(
      runtime.applyStructureChange(
        NOTE,
        movedAndMergedContent,
        USER,
        1,
        "structure-stale-generation",
      ),
      (error: unknown) => (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && error.code === "SUBDOCUMENT_GENERATION_CONFLICT"
      ),
    );

    const moved = await runtime.applyStructureChange(
      NOTE,
      movedAndMergedContent,
      USER,
      expanded.generation,
      "structure-move-delete-merge",
    );
    assert.equal(moved.replayed, false);
    assert.equal(moved.version, 3);
    assert.equal(moved.generation, 3);
    assert.equal(moved.structureVersion, 3);
    assert.deepEqual(
      moved.manifest.sections.map((section) => section.id),
      ["section-blk_structure_three", "section-blk_structure_one"],
    );

    const persisted = (await pool.query(
      `SELECT content, "contentText", version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(persisted.content, movedAndMergedContent);
    assert.match(persisted.contentText, /Three/u);
    assert.equal(Number(persisted.version), 3);

    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocuments WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_updates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_structure_operations WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_versions WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_blocks_index WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 4);
  } finally {
    await closePgPool(pool);
  }
});
'''
write("backend/tests/postgres-yjs-subdocument-structure-pg.test.ts", structure_test)

ws_structure_test = r'''import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { WebSocket } from "ws";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { signLoginToken } from "../src/lib/auth-security";
import { createPostgresYjsSubdocumentWebsocketRuntime } from "../src/services/postgres-yjs-subdocuments-websocket-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-subdoc-structure-ws-user";
const NOTEBOOK = "pg-subdoc-structure-ws-notebook";
const NOTE = "f9999999-9999-4999-8999-999999999999";

function text(value: string) {
  return { type: "text", text: value };
}

function heading(blockId: string, value: string, level = 2) {
  return { type: "heading", attrs: { level, blockId }, content: [text(value)] };
}

function paragraph(blockId: string, value: string) {
  return { type: "paragraph", attrs: { blockId }, content: [text(value)] };
}

function document(nodes: unknown[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

const baseContent = document([
  heading("blk_ws_structure_one", "One", 1),
  paragraph("blk_ws_structure_alpha", "Alpha"),
  heading("blk_ws_structure_two", "Two", 2),
  paragraph("blk_ws_structure_beta", "Beta"),
]);

const expandedContent = document([
  heading("blk_ws_structure_one", "One", 1),
  paragraph("blk_ws_structure_alpha", "Alpha"),
  heading("blk_ws_structure_two", "Two", 2),
  paragraph("blk_ws_structure_beta", "Beta"),
  heading("blk_ws_structure_three", "Three", 2),
  paragraph("blk_ws_structure_gamma", "Gamma"),
]);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function waitForMessage(
  messages: Array<Record<string, any>>,
  type: string,
  predicate: (message: Record<string, any>) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<Record<string, any>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = messages.find((entry) => entry.type === type && predicate(entry));
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for websocket message ${type}`);
}

test("PostgreSQL subdocument websocket applies idempotent structure changes and reloads rooms", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Structure websocket')`,
    [NOTEBOOK, USER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Structure websocket', $4, 'One Alpha Two Beta', 'tiptap-json', 1)`,
    [NOTE, USER, NOTEBOOK, baseContent],
  );

  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const runtime = createPostgresYjsSubdocumentWebsocketRuntime(new PostgresAdapter(pool), {
    heartbeatIntervalMs: 50,
    clientTimeoutMs: 2_000,
  });
  let ws: WebSocket | null = null;

  try {
    runtime.attach(server);
    const port = await listen(server);
    const token = signLoginToken({ userId: USER, username: USER, tokenVersion: 0 });
    const messages: Array<Record<string, any>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/subdocuments?token=${encodeURIComponent(token)}`);
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, "open");

    const connected = await waitForMessage(messages, "connected");
    assert.ok(connected.capabilities.includes("yjs-subdocument-structure-change"));
    assert.ok(connected.capabilities.includes("yjs-subdocument-idempotent-structure-operations"));
    assert.deepEqual(connected.pendingCapabilities, []);

    ws.send(JSON.stringify({ type: "y:subdoc:join", noteId: NOTE }));
    const initial = await waitForMessage(messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section === null
    ));
    assert.equal(initial.manifest.generation, 1);

    ws.send(JSON.stringify({
      type: "y:subdoc:structure",
      noteId: NOTE,
      generation: 1,
      operationId: "ws-structure-add-third",
      content: expandedContent,
    }));
    const ack = await waitForMessage(messages, "y:subdoc:structure-ack", (message) => (
      message.operationId === "ws-structure-add-third" && message.replayed === false
    ));
    assert.equal(ack.version, 2);
    assert.equal(ack.generation, 2);
    assert.equal(ack.structureVersion, 2);
    assert.equal(ack.manifest.sections.length, 3);
    await waitForMessage(messages, "y:subdoc:reload", (message) => (
      message.noteId === NOTE && message.reason === "structure-changed"
    ));

    ws.send(JSON.stringify({ type: "y:subdoc:join", noteId: NOTE }));
    await waitForMessage(messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.manifest?.generation === 2
    ));
    ws.send(JSON.stringify({
      type: "y:subdoc:structure",
      noteId: NOTE,
      generation: 1,
      operationId: "ws-structure-add-third",
      content: expandedContent,
    }));
    const replay = await waitForMessage(messages, "y:subdoc:structure-ack", (message) => (
      message.operationId === "ws-structure-add-third" && message.replayed === true
    ));
    assert.equal(replay.version, 2);
    assert.equal(replay.generation, 2);
    await waitForMessage(messages, "y:subdoc:reload", (message) => (
      message.noteId === NOTE && message.reason === "structure-operation-replayed"
    ));

    ws.send(JSON.stringify({ type: "y:subdoc:join", noteId: NOTE }));
    await waitForMessage(messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.manifest?.generation === 2
    ));
    ws.send(JSON.stringify({
      type: "y:subdoc:structure",
      noteId: NOTE,
      generation: 2,
      operationId: "ws-structure-add-third",
      content: baseContent,
    }));
    await waitForMessage(messages, "error", (message) => (
      message.noteId === NOTE && message.code === "SUBDOCUMENT_OPERATION_REUSED"
    ));

    const persisted = (await pool.query(
      `SELECT content, version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(persisted.content, expandedContent);
    assert.equal(Number(persisted.version), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM note_y_subdocument_structure_operations WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 1);

    const stats = runtime.getStats();
    assert.equal(stats.structureChanges, 1);
    assert.equal(stats.invalidations, 2);
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    await runtime.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePgPool(pool);
  }
});
'''
write("backend/tests/postgres-yjs-subdocuments-structure-websocket-pg.test.ts", ws_structure_test)

workflow_path = ".github/workflows/pg-yjs-subdocuments.yml"
workflow = read(workflow_path)
workflow = replace_count(
    workflow,
    '      - "backend/src/db/postgres/migrations/0013_yjs_subdocuments.sql"\n',
    '      - "backend/src/db/postgres/migrations/0013_yjs_subdocuments.sql"\n      - "backend/src/db/postgres/migrations/0014_yjs_subdocument_structure_operations.sql"\n',
    2,
    "workflow migration paths",
)
workflow = replace_count(
    workflow,
    '      - "backend/tests/postgres-yjs-subdocuments-runtime-pg.test.ts"\n',
    '      - "backend/tests/postgres-yjs-subdocuments-runtime-pg.test.ts"\n      - "backend/tests/postgres-yjs-subdocument-structure-pg.test.ts"\n',
    2,
    "workflow runtime test paths",
)
workflow = replace_count(
    workflow,
    '      - "backend/tests/postgres-yjs-subdocuments-websocket-pg.test.ts"\n',
    '      - "backend/tests/postgres-yjs-subdocuments-websocket-pg.test.ts"\n      - "backend/tests/postgres-yjs-subdocuments-structure-websocket-pg.test.ts"\n',
    2,
    "workflow websocket test paths",
)
workflow = replace_once(
    workflow,
    '''      - name: Stable-section subdocument transaction
        run: node --import tsx --test --test-concurrency=1 tests/postgres-yjs-subdocuments-runtime-pg.test.ts
      - name: Subdocument websocket protocol
        run: node --import tsx --test --test-concurrency=1 tests/postgres-yjs-subdocuments-websocket-pg.test.ts
''',
    '''      - name: Stable-section and structure subdocument transactions
        run: |
          node --import tsx --test --test-concurrency=1 tests/postgres-yjs-subdocuments-runtime-pg.test.ts
          node --import tsx --test --test-concurrency=1 tests/postgres-yjs-subdocument-structure-pg.test.ts
      - name: Subdocument websocket protocols
        run: |
          node --import tsx --test --test-concurrency=1 tests/postgres-yjs-subdocuments-websocket-pg.test.ts
          node --import tsx --test --test-concurrency=1 tests/postgres-yjs-subdocuments-structure-websocket-pg.test.ts
''',
    "workflow test steps",
)
workflow = replace_once(
    workflow,
    '''      - name: Verify subdocument migration is packaged
        run: test -f dist/postgres/migrations/0013_yjs_subdocuments.sql
''',
    '''      - name: Verify subdocument migrations are packaged
        run: |
          test -f dist/postgres/migrations/0013_yjs_subdocuments.sql
          test -f dist/postgres/migrations/0014_yjs_subdocument_structure_operations.sql
''',
    "workflow package verification",
)
write(workflow_path, workflow)

print("Applied PostgreSQL subdocument structure migration slice")
