import { Hono } from "hono";
import type { Context } from "hono";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import {
  applyIncrementalPatchIndexes,
  canUseIncrementalPatchIndexes,
  planIncrementalPatchIndexes,
  type IncrementalPatchIndexPlan,
} from "../lib/blockPatchIncrementalIndexes.js";
import {
  canUseIncrementalListMoveIndexes,
  planIncrementalListMoveIndexes,
} from "../lib/blockPatchListIncrementalIndexes.js";
import {
  canUseIncrementalListStructureIndexes,
  planIncrementalListStructureIndexes,
} from "../lib/blockPatchListStructureIncrementalIndexes.js";
import {
  ensureNoteBlockTables,
  getNoteBlock,
  plainTextFromNoteContent,
  syncNoteBlocks,
} from "../lib/noteBlocks.js";
import {
  applyMarkdownBlockPatch,
  MarkdownBlockPatchError,
  validateMarkdownBlockPatchOperations,
  type MarkdownBlockPatchOperation,
} from "../lib/markdownBlockPatch.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import {
  assertBlockAuthorityVersions,
  BlockAuthorityConflictError,
  rebuildBlockAuthorityStore,
} from "../lib/blockAuthorityStore.js";
import {
  applyTiptapBlockPatch,
  TiptapBlockPatchError,
  validateTiptapBlockPatchOperations,
  type TiptapBlockPatchOperation,
} from "../lib/tiptapBlockPatch.js";
import {
  TiptapListItemStructureError,
} from "../lib/tiptapListItemStructure.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { noteVersionsRepository } from "../repositories/noteVersionsRepository.js";
import { logAudit } from "../services/audit.js";
import { broadcastNoteUpdated, broadcastToUser } from "../services/realtime.js";
import { rebuildYjsSubdocumentsIfEnabled } from "../services/yjs-subdocuments.js";

const BLOCK_PATCH_ROUTE = Symbol.for("nowen.blocks.batchPatchRoute");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;
const VERSION_MERGE_WINDOW_MS = 5 * 60 * 1000;

interface NoteRecord {
  id: string;
  userId: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
  isLocked: number;
  isTrashed: number;
  updatedAt: string;
}

interface AppliedPatchResult {
  content: string;
  affectedBlockIds: string[];
  createdBlocks: Array<{ operationIndex: number; clientId: string | null; blockId: string }>;
  deletedBlockIds?: string[];
}

class BlockPatchRouteError extends Error {
  constructor(
    readonly code: "VERSION_CONFLICT" | "NOTE_LOCKED" | "NOT_FOUND" | "BLOCK_FORMAT_UNSUPPORTED",
    readonly status: 400 | 403 | 404 | 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type IdempotencyLookup =
  | { kind: "none" }
  | { kind: "replay"; result: unknown }
  | { kind: "conflict" };

function readNote(noteId: string): NoteRecord | null {
  return (getDb().prepare(`
    SELECT id, userId, notebookId, title, content, contentText, contentFormat,
           version, isLocked, isTrashed, updatedAt
    FROM notes WHERE id = ?
  `).get(noteId) as NoteRecord | undefined) || null;
}

function requireWritableNote(c: Context, noteId: string): { note: NoteRecord; userId: string } | Response {
  const userId = c.req.header("X-User-Id") || "";
  const note = readNote(noteId);
  if (!note || note.isTrashed) return c.json({ error: "笔记不存在", code: "NOT_FOUND" }, 404);
  const permission = resolveNotePermission(noteId, userId).permission;
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "笔记不存在或无权限", code: "NOT_FOUND" }, 404);
  }
  return { note, userId };
}

function validateEnvelope(body: any): string | null {
  if (!Number.isInteger(body?.expectedNoteVersion) || body.expectedNoteVersion < 1) {
    return "expectedNoteVersion 必须是正整数";
  }
  if (typeof body?.operationId !== "string" || body.operationId.length < 8 || body.operationId.length > 128) {
    return "operationId 长度必须为 8-128";
  }
  if (body.expectedStructureVersion !== undefined && (!Number.isInteger(body.expectedStructureVersion) || body.expectedStructureVersion < 1)) {
    return "expectedStructureVersion 必须是正整数";
  }
  if (body.expectedBlockVersions !== undefined) {
    if (!body.expectedBlockVersions || Array.isArray(body.expectedBlockVersions) || typeof body.expectedBlockVersions !== "object") {
      return "expectedBlockVersions 必须是对象";
    }
    const entries = Object.entries(body.expectedBlockVersions);
    if (entries.length > 100 || entries.some(([blockId, version]) => !blockId || !Number.isInteger(version) || Number(version) < 1)) {
      return "expectedBlockVersions 最多包含 100 个正整数版本";
    }
  }
  return null;
}

function readIdempotentResult(userId: string, noteId: string, operationId: string): IdempotencyLookup {
  ensureNoteBlockTables(getDb());
  const row = getDb().prepare(`
    SELECT noteId, resultJson FROM block_operations
    WHERE userId = ? AND operationId = ?
  `).get(userId, operationId) as { noteId: string; resultJson: string } | undefined;
  if (!row) return { kind: "none" };
  if (row.noteId !== noteId) return { kind: "conflict" };
  try {
    return { kind: "replay", result: JSON.parse(row.resultJson) };
  } catch {
    return { kind: "conflict" };
  }
}

function storeIdempotentResult(userId: string, noteId: string, operationId: string, result: unknown): void {
  getDb().prepare(`
    INSERT INTO block_operations (userId, operationId, noteId, resultJson, createdAt)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(userId, operationId, noteId, JSON.stringify(result));
}

function recordVersionSnapshot(note: NoteRecord, userId: string): void {
  const lastEdit = noteVersionsRepository.getLastEditByNoteId(note.id);
  if (lastEdit) {
    const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(lastEdit.createdAt)
      ? lastEdit.createdAt
      : `${lastEdit.createdAt.replace(" ", "T")}Z`;
    const lastTimestamp = new Date(normalized).getTime();
    if (!Number.isNaN(lastTimestamp) && Date.now() - lastTimestamp < VERSION_MERGE_WINDOW_MS) {
      return;
    }
  }

  noteVersionsRepository.create({
    id: uuid(),
    noteId: note.id,
    userId,
    title: note.title,
    content: note.content,
    contentText: note.contentText,
    contentFormat: note.contentFormat,
    version: note.version,
    changeType: "edit",
    changeSummary: "Block Patch save",
  });
}

function mapPatchError(c: Context, error: unknown): Response | null {
  if (error instanceof BlockAuthorityConflictError) {
    return c.json({ error: error.message, code: error.code, ...error.details }, 409);
  }
  if (error instanceof BlockPatchRouteError) {
    const message = error.code === "VERSION_CONFLICT"
      ? "Version conflict"
      : error.code === "NOTE_LOCKED"
        ? "Note is locked"
        : error.code === "BLOCK_FORMAT_UNSUPPORTED"
          ? "当前内容格式不支持 Block Patch"
          : "笔记不存在或无权限";
    return c.json({ error: message, code: error.code, ...error.details }, error.status);
  }
  if (error instanceof TiptapListItemStructureError) {
    const status = error.code === "BLOCK_ID_CONFLICT" ? 409 : error.code === "BLOCK_NOT_FOUND" ? 404 : 400;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof MarkdownBlockPatchError) {
    const status = error.code === "BLOCK_NOT_FOUND"
      ? 404
      : ["BLOCK_ID_CONFLICT", "BLOCK_HASH_CONFLICT"].includes(error.code) ? 409 : 400;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (!(error instanceof TiptapBlockPatchError)) return null;
  if (error.code === "BLOCK_NOT_FOUND") {
    return c.json({ error: error.message, code: error.code }, 404);
  }
  if (error.code === "BLOCK_ID_CONFLICT") {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  return c.json({ error: error.message, code: error.code }, 400);
}

async function patchBlocks(c: Context) {
  const noteId = c.req.param("noteId");
  const body = await c.req.json().catch(() => ({}));
  const envelopeError = validateEnvelope(body);
  if (envelopeError) return c.json({ error: envelopeError, code: "INVALID_BLOCK_PATCH" }, 400);

  const required = requireWritableNote(c, noteId);
  if (required instanceof Response) return required;
  const { userId, note: initialNote } = required;

  const idempotency = readIdempotentResult(userId, noteId, body.operationId);
  if (idempotency.kind === "replay") {
    return c.json({ ...(idempotency.result as any), idempotentReplay: true });
  }
  if (idempotency.kind === "conflict") {
    return c.json({
      error: "operationId 已被当前用户的另一笔记使用，请生成新的幂等键",
      code: "OPERATION_ID_CONFLICT",
    }, 409);
  }

  const isMarkdownPatch = initialNote.contentFormat === "markdown";
  let operations: TiptapBlockPatchOperation[] | MarkdownBlockPatchOperation[];
  try {
    operations = isMarkdownPatch
      ? validateMarkdownBlockPatchOperations(body.operations)
      : validateTiptapBlockPatchOperations(body.operations);
  } catch (error) {
    return mapPatchError(c, error) || c.json({ error: "无效块补丁", code: "INVALID_BLOCK_PATCH" }, 400);
  }

  try {
    const db = getDb();
    const transaction = db.transaction(() => {
      const note = readNote(noteId);
      if (!note || note.isTrashed || !hasPermission(resolveNotePermission(noteId, userId).permission, "write")) {
        throw new BlockPatchRouteError("NOT_FOUND", 404);
      }
      if (note.isLocked) throw new BlockPatchRouteError("NOTE_LOCKED", 403);
      if (!["tiptap-json", "markdown"].includes(note.contentFormat)) {
        throw new BlockPatchRouteError("BLOCK_FORMAT_UNSUPPORTED", 400);
      }
      const authority = assertBlockAuthorityVersions(db, noteId, {
        expectedBlockVersions: body.expectedBlockVersions,
        expectedStructureVersion: body.expectedStructureVersion,
      });
      if (note.version !== body.expectedNoteVersion) {
        const contentOnly = operations.every((operation) => operation.type === "update" || operation.type === "replace");
        const affected = operations.map((operation: any) => String(operation.blockId || "")).filter(Boolean);
        const coveredByBlockVersions = authority
          && contentOnly
          && affected.length > 0
          && affected.every((blockId) => Number.isInteger(body.expectedBlockVersions?.[blockId]));
        if (!coveredByBlockVersions) {
          throw new BlockPatchRouteError("VERSION_CONFLICT", 409, { currentVersion: note.version });
        }
      }

      if (note.contentFormat === "markdown") {
        const normalizedBefore = syncNoteBlocks(db, noteId, note.content, note.contentFormat);
        const patch = applyMarkdownBlockPatch(
          normalizedBefore.content,
          operations as MarkdownBlockPatchOperation[],
        );
        const nextVersion = note.version + 1;
        const contentText = plainTextFromNoteContent(patch.content, note.contentFormat);
        recordVersionSnapshot(note, userId);
        const update = db.prepare(`
          UPDATE notes
          SET content = ?, contentText = ?, version = ?, updatedAt = datetime('now')
          WHERE id = ? AND version = ?
        `).run(patch.content, contentText, nextVersion, noteId, note.version);
        if (update.changes !== 1) {
          const current = readNote(noteId);
          throw new BlockPatchRouteError("VERSION_CONFLICT", 409, { currentVersion: current?.version ?? note.version });
        }
        const synced = syncNoteBlocks(db, noteId, patch.content, note.contentFormat);
        syncNoteLinks(db, userId, noteId, synced.content);
        const authorityState = rebuildBlockAuthorityStore(db, noteId, synced.content, note.contentFormat, {
          noteVersion: nextVersion,
          operationId: body.operationId,
          operationType: "markdown-patch",
          operationJson: operations,
        });
        rebuildYjsSubdocumentsIfEnabled(db, noteId, synced.content, note.contentFormat);
        const persisted = readNote(noteId);
        if (!persisted) throw new BlockPatchRouteError("NOT_FOUND", 404);
        const blocks = patch.affectedBlockIds
          .map((blockId) => getNoteBlock(db, noteId, blockId))
          .filter(Boolean);
        const result = {
          success: true,
          noteId,
          title: persisted.title,
          version: nextVersion,
          updatedAt: persisted.updatedAt,
          content: synced.content,
          contentText: synced.contentText,
          contentFormat: persisted.contentFormat,
          notebookId: persisted.notebookId,
          operationCount: operations.length,
          affectedBlockIds: patch.affectedBlockIds,
          deletedBlockIds: patch.deletedBlockIds,
          createdBlocks: patch.createdBlocks,
          blocks,
          indexUpdateMode: "full" as const,
          indexUpdateKind: "full" as const,
          indexedBlockIds: synced.blocks.map((row) => row.blockId),
          contentChangedByNormalization: normalizedBefore.changed || synced.changed,
          blockVersion: authorityState.blockVersion,
          structureVersion: authorityState.structureVersion,
        };
        storeIdempotentResult(userId, noteId, body.operationId, result);
        return result;
      }

      const tiptapOperations = operations as TiptapBlockPatchOperation[];

      const listStructureBase = canUseIncrementalListStructureIndexes(
        db,
        noteId,
        note.content,
        tiptapOperations,
      );
      const listMoveBase = !listStructureBase && canUseIncrementalListMoveIndexes(
        db,
        noteId,
        note.content,
        tiptapOperations,
      );
      const genericIncrementalBase = !listStructureBase && !listMoveBase && canUseIncrementalPatchIndexes(
        db,
        noteId,
        note.content,
        tiptapOperations,
      );
      const incrementalBase = listStructureBase || listMoveBase || genericIncrementalBase;
      const normalizedBefore = incrementalBase
        ? {
            content: note.content,
            contentText: note.contentText,
            blocks: [],
            changed: false,
          }
        : syncNoteBlocks(db, noteId, note.content, note.contentFormat);

      const patch: AppliedPatchResult = applyTiptapBlockPatch(normalizedBefore.content, tiptapOperations);
      const listStructurePlan = listStructureBase
        ? planIncrementalListStructureIndexes(db, noteId, patch.content, tiptapOperations)
        : null;
      const listMovePlan = listMoveBase
        ? planIncrementalListMoveIndexes(db, noteId, patch.content, tiptapOperations)
        : null;
      const genericPlan = genericIncrementalBase
        ? planIncrementalPatchIndexes(db, userId, noteId, patch.content, tiptapOperations)
        : null;
      const incrementalPlan = (listStructurePlan || listMovePlan || genericPlan) as IncrementalPatchIndexPlan | null;
      const contentText = incrementalPlan?.contentText
        ?? plainTextFromNoteContent(patch.content, note.contentFormat);
      const nextVersion = note.version + 1;

      recordVersionSnapshot(note, userId);

      const update = db.prepare(`
        UPDATE notes
        SET content = ?, contentText = ?, version = ?, updatedAt = datetime('now')
        WHERE id = ? AND version = ?
      `).run(patch.content, contentText, nextVersion, noteId, note.version);
      if (update.changes !== 1) {
        const current = readNote(noteId);
        throw new BlockPatchRouteError("VERSION_CONFLICT", 409, {
          currentVersion: current?.version ?? note.version,
        });
      }

      let persistedContent = patch.content;
      let persistedContentText = contentText;
      let postSyncChanged = false;
      let indexUpdateMode: "incremental" | "full" = "full";
      let indexUpdateKind:
        | "leaf"
        | "structural"
        | "mixed"
        | "list-subtree"
        | "list-structural"
        | "list-mixed"
        | "full" = "full";
      let indexedBlockIds: string[] = [];
      if (incrementalPlan) {
        applyIncrementalPatchIndexes(db, userId, noteId, incrementalPlan);
        indexUpdateMode = "incremental";
        indexUpdateKind = listStructurePlan
          ? incrementalPlan.kind === "mixed" ? "list-mixed" : "list-structural"
          : listMovePlan
            ? "list-subtree"
            : incrementalPlan.kind;
        indexedBlockIds = incrementalPlan.indexedBlockIds;
      } else {
        const synced = syncNoteBlocks(db, noteId, patch.content, note.contentFormat);
        syncNoteLinks(db, userId, noteId, synced.content);
        persistedContent = synced.content;
        persistedContentText = synced.contentText;
        postSyncChanged = synced.changed;
        indexedBlockIds = synced.blocks.map((row) => row.blockId);
      }

      const authorityState = rebuildBlockAuthorityStore(db, noteId, persistedContent, note.contentFormat, {
        noteVersion: nextVersion,
        operationId: body.operationId,
        operationType: "tiptap-patch",
        operationJson: tiptapOperations,
      });
      rebuildYjsSubdocumentsIfEnabled(db, noteId, persistedContent, note.contentFormat);

      const persisted = readNote(noteId);
      if (!persisted) throw new BlockPatchRouteError("NOT_FOUND", 404);

      const deletedBlockIds = patch.deletedBlockIds ?? tiptapOperations
        .filter((operation) => operation.type === "delete")
        .map((operation) => operation.blockId);
      const blocks = patch.affectedBlockIds
        .map((blockId) => getNoteBlock(db, noteId, blockId))
        .filter(Boolean);
      const result = {
        success: true,
        noteId,
        title: persisted.title,
        version: nextVersion,
        updatedAt: persisted.updatedAt,
        content: persistedContent,
        contentText: persistedContentText,
        contentFormat: persisted.contentFormat,
        notebookId: persisted.notebookId,
        operationCount: tiptapOperations.length,
        affectedBlockIds: patch.affectedBlockIds,
        deletedBlockIds,
        createdBlocks: patch.createdBlocks,
        blocks,
        indexUpdateMode,
        indexUpdateKind,
        indexedBlockIds,
        contentChangedByNormalization: normalizedBefore.changed || postSyncChanged,
        blockVersion: authorityState.blockVersion,
        structureVersion: authorityState.structureVersion,
      };
      storeIdempotentResult(userId, noteId, body.operationId, result);
      return result;
    });

    const result = transaction();
    logAudit(userId, "note", "block_patch", {
      noteId,
      version: result.version,
      operationCount: result.operationCount,
      affectedBlockIds: result.affectedBlockIds,
      indexUpdateMode: result.indexUpdateMode,
      indexUpdateKind: result.indexUpdateKind,
      indexedBlockCount: result.indexedBlockIds.length,
    }, { targetType: "note", targetId: noteId });
    broadcastNoteUpdated(noteId, {
      version: result.version,
      updatedAt: result.updatedAt,
      title: result.title,
      contentText: result.contentText,
      actorUserId: userId,
    });
    broadcastToUser(userId, {
      type: "note:list-updated" as any,
      note: {
        id: noteId,
        title: result.title,
        contentText: result.contentText,
        contentFormat: result.contentFormat,
        notebookId: result.notebookId,
        version: result.version,
        updatedAt: result.updatedAt,
      },
      actorUserId: userId,
      actorConnectionId: null,
    } as any);
    return c.json(result);
  } catch (error) {
    const mapped = mapPatchError(c, error);
    if (mapped) return mapped;
    throw error;
  }
}

/** Register POST /api/blocks/:noteId/patch before the existing block router is mounted. */
if (!globals[BLOCK_PATCH_ROUTE]) {
  globals[BLOCK_PATCH_ROUTE] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path !== "/api/blocks") return nativeRoute.call(this, path, subApp);
    const wrapper = new Hono<any>();
    wrapper.post("/:noteId/patch", patchBlocks);
    wrapper.route("/", subApp);
    return nativeRoute.call(this, path, wrapper);
  };
}
