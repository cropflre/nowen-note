import { Hono } from "hono";
import type { Context } from "hono";

import { getDb } from "../db/schema.js";
import {
  ensureNoteBlockTables,
  getNoteBlock,
  plainTextFromNoteContent,
  syncNoteBlocks,
} from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import {
  applyTiptapBlockPatch,
  TiptapBlockPatchError,
  validateTiptapBlockPatchOperations,
  type TiptapBlockPatchOperation,
} from "../lib/tiptapBlockPatch.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { logAudit } from "../services/audit.js";

const BLOCK_PATCH_ROUTE = Symbol.for("nowen.blocks.batchPatchRoute");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

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

function readNote(noteId: string): NoteRecord | null {
  return (getDb().prepare(`
    SELECT id, userId, notebookId, title, content, contentText, contentFormat,
           version, isLocked, isTrashed
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
  return null;
}

function readIdempotentResult(userId: string, noteId: string, operationId: string): unknown | null {
  ensureNoteBlockTables(getDb());
  const row = getDb().prepare(`
    SELECT resultJson FROM block_operations
    WHERE userId = ? AND noteId = ? AND operationId = ?
  `).get(userId, noteId, operationId) as { resultJson: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.resultJson);
  } catch {
    return null;
  }
}

function storeIdempotentResult(userId: string, noteId: string, operationId: string, result: unknown): void {
  getDb().prepare(`
    INSERT INTO block_operations (userId, operationId, noteId, resultJson, createdAt)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(userId, operationId, noteId, JSON.stringify(result));
}

function mapPatchError(c: Context, error: unknown): Response | null {
  if (error instanceof BlockPatchRouteError) {
    const message = error.code === "VERSION_CONFLICT"
      ? "Version conflict"
      : error.code === "NOTE_LOCKED"
        ? "Note is locked"
        : error.code === "BLOCK_FORMAT_UNSUPPORTED"
          ? "当前仅支持富文本 Block Patch"
          : "笔记不存在或无权限";
    return c.json({ error: message, code: error.code, ...error.details }, error.status);
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
  const { userId } = required;

  const cached = readIdempotentResult(userId, noteId, body.operationId);
  if (cached) return c.json({ ...(cached as any), idempotentReplay: true });

  let operations: TiptapBlockPatchOperation[];
  try {
    operations = validateTiptapBlockPatchOperations(body.operations);
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
      if (note.contentFormat !== "tiptap-json") {
        throw new BlockPatchRouteError("BLOCK_FORMAT_UNSUPPORTED", 400);
      }
      if (note.version !== body.expectedNoteVersion) {
        throw new BlockPatchRouteError("VERSION_CONFLICT", 409, { currentVersion: note.version });
      }

      // Materialize missing/duplicate stable IDs inside the same transaction. If any later operation
      // fails, both this normalization and every patch operation roll back together.
      const normalizedBefore = syncNoteBlocks(db, noteId, note.content, note.contentFormat);
      const patch = applyTiptapBlockPatch(normalizedBefore.content, operations);
      const contentText = plainTextFromNoteContent(patch.content, note.contentFormat);
      const nextVersion = note.version + 1;
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

      const synced = syncNoteBlocks(db, noteId, patch.content, note.contentFormat);
      syncNoteLinks(db, userId, noteId, synced.content);

      const deletedBlockIds = operations
        .filter((operation) => operation.type === "delete")
        .map((operation) => operation.blockId);
      const blocks = patch.affectedBlockIds
        .map((blockId) => getNoteBlock(db, noteId, blockId))
        .filter(Boolean);
      const result = {
        success: true,
        noteId,
        version: nextVersion,
        operationCount: operations.length,
        affectedBlockIds: patch.affectedBlockIds,
        deletedBlockIds,
        createdBlocks: patch.createdBlocks,
        blocks,
        contentChangedByNormalization: normalizedBefore.changed || synced.changed,
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
    }, { targetType: "note", targetId: noteId });
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
