import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import {
  createNoteCollectionRuntime,
  type NoteCollectionCreateInput,
} from "../services/note-collection-runtime";
import {
  createNoteCoreRuntime,
  NoteCoreRuntimeError,
  type NoteCoreSaveInput,
} from "../services/note-core-runtime";
import {
  createNoteDeletionRuntime,
  type NoteDeletionRuntimeOptions,
} from "../services/note-deletion-runtime";
import type {
  NoteRuntimeMutationEvent,
  RealtimeNoteSnapshot,
} from "../services/note-deletion-realtime-runtime";
import {
  createNoteLifecycleRuntime,
  type NoteLifecycleInput,
  type NoteReorderItem,
} from "../services/note-lifecycle-runtime";

export interface NoteRuntimeRealtimeOptions {
  publishMutation?: (event: NoteRuntimeMutationEvent) => Promise<void> | void;
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof NoteCoreRuntimeError) {
    return c.json({
      error: error.message,
      code: error.code,
      ...(error.details || {}),
    }, error.status);
  }
  console.error("[notes-runtime] request failed:", error);
  return c.json({
    error: "PostgreSQL note runtime request failed",
    code: "POSTGRES_NOTE_RUNTIME_FAILED",
  }, 500);
}

function setRuntimeWarningHeader(c: Context, ...groups: string[][]): void {
  const count = groups.reduce((total, warnings) => total + warnings.length, 0);
  if (count > 0) c.header("X-Nowen-Runtime-Warnings", String(count));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function realtimeSnapshot(note: Record<string, unknown>): RealtimeNoteSnapshot {
  return {
    id: stringValue(note.id),
    workspaceId: note.workspaceId ? stringValue(note.workspaceId) : null,
    version: numberValue(note.version),
    updatedAt: stringValue(note.updatedAt),
    title: typeof note.title === "string" ? note.title : undefined,
    contentText: typeof note.contentText === "string" ? note.contentText : undefined,
    notebookId: typeof note.notebookId === "string" ? note.notebookId : undefined,
  };
}

function lifecycleMutationKind(
  body: Record<string, unknown>,
): "note.updated" | "note.trashed" | "note.restored" | "note.moved" {
  if (body.isTrashed !== undefined) {
    return body.isTrashed === true || body.isTrashed === 1 || body.isTrashed === "1"
      ? "note.trashed"
      : "note.restored";
  }
  if (body.notebookId !== undefined) return "note.moved";
  return "note.updated";
}

export function createNotesRuntimeRouter(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
  deletionOptions: NoteDeletionRuntimeOptions = {},
  realtimeOptions: NoteRuntimeRealtimeOptions = {},
) {
  const app = new Hono();
  const core = createNoteCoreRuntime(adapter, dialect);
  const collection = createNoteCollectionRuntime(adapter, dialect);
  const lifecycle = createNoteLifecycleRuntime(adapter);
  const deletion = createNoteDeletionRuntime(adapter, deletionOptions);
  const publishMutation = realtimeOptions.publishMutation ?? (() => {});

  async function publishMutationSafely(event: NoteRuntimeMutationEvent): Promise<string[]> {
    try {
      await publishMutation(event);
      return [];
    } catch (error) {
      return [`realtime mutation event failed: ${errorMessage(error)}`];
    }
  }

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    try {
      const notes = await collection.listNotes(userId, {
        workspaceId: c.req.query("workspaceId"),
        notebookId: c.req.query("notebookId"),
        isFavorite: c.req.query("isFavorite"),
        isTrashed: c.req.query("isTrashed"),
        search: c.req.query("search"),
        tagId: c.req.query("tagId"),
        tagIds: c.req.query("tagIds"),
        tagMode: c.req.query("tagMode"),
        dateFrom: c.req.query("dateFrom"),
        dateTo: c.req.query("dateTo"),
        sortBy: c.req.query("sortBy"),
        sortOrder: c.req.query("sortOrder"),
      });
      return c.json(notes);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    let body: NoteCollectionCreateInput;
    try {
      body = await c.req.json<NoteCollectionCreateInput>();
    } catch {
      return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
    }

    try {
      const note = await collection.createNote(userId, body);
      const realtimeWarnings = await publishMutationSafely({
        kind: "note.created",
        actorUserId: userId,
        actorConnectionId: c.req.header("X-Connection-Id") || null,
        note: realtimeSnapshot(note),
      });
      setRuntimeWarningHeader(c, realtimeWarnings);
      return c.json({
        ...note,
        ...(realtimeWarnings.length > 0 ? { runtimeWarnings: realtimeWarnings } : {}),
      }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.put("/reorder/batch", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    let body: { items?: NoteReorderItem[] };
    try {
      body = await c.req.json<{ items?: NoteReorderItem[] }>();
    } catch {
      return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
    }
    try {
      const items = body.items as NoteReorderItem[];
      const result = await lifecycle.reorderNotes(userId, items);
      const skipped = new Set(result.skipped);
      const noteIds = Array.isArray(items)
        ? items.map((item) => item?.id).filter((id): id is string => Boolean(id) && !skipped.has(id))
        : [];
      const realtimeWarnings = await publishMutationSafely({
        kind: "notes.reordered",
        actorUserId: userId,
        actorConnectionId: c.req.header("X-Connection-Id") || null,
        noteIds,
      });
      setRuntimeWarningHeader(c, realtimeWarnings);
      return c.json({
        ...result,
        ...(realtimeWarnings.length > 0 ? { runtimeWarnings: realtimeWarnings } : {}),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/trash/summary", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    try {
      return c.json(await lifecycle.getTrashSummary(userId, c.req.query("workspaceId")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // 必须在 /:id 之前注册，否则 trash 会被当成笔记 ID。
  app.delete("/trash/empty", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    try {
      const result = await deletion.emptyTrash(userId, c.req.query("workspaceId"));
      setRuntimeWarningHeader(c, result.cleanupWarnings, result.sideEffectWarnings);
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    try {
      const note = await core.getNote(userId, c.req.param("id"), {
        slim: c.req.query("slim") === "1",
      });
      return c.json(note);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.put("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
    }

    try {
      const lifecycleFields = ["isTrashed", "sortOrder", "notebookId"];
      const hasLifecycleWrite = lifecycleFields.some((field) => body[field] !== undefined);
      if (hasLifecycleWrite) {
        const hasCoreWrite = Object.keys(body).some(
          (field) => field !== "version" && !lifecycleFields.includes(field),
        );
        if (hasCoreWrite) {
          throw new NoteCoreRuntimeError(
            "PostgreSQL Runtime 暂不支持内容与生命周期字段混合保存",
            "POSTGRES_NOTE_MIXED_WRITE_PENDING",
            503,
          );
        }
        await lifecycle.updateNote(userId, c.req.param("id"), body as NoteLifecycleInput);
        const note = await core.getNote(userId, c.req.param("id"));
        const realtimeWarnings = await publishMutationSafely({
          kind: lifecycleMutationKind(body),
          actorUserId: userId,
          actorConnectionId: c.req.header("X-Connection-Id") || null,
          note: realtimeSnapshot(note),
        });
        setRuntimeWarningHeader(c, realtimeWarnings);
        return c.json({
          ...note,
          ...(realtimeWarnings.length > 0 ? { runtimeWarnings: realtimeWarnings } : {}),
        });
      }

      const result = await core.saveNote(userId, c.req.param("id"), body as NoteCoreSaveInput);
      const realtimeWarnings = await publishMutationSafely({
        kind: "note.updated",
        actorUserId: userId,
        actorConnectionId: c.req.header("X-Connection-Id") || null,
        note: realtimeSnapshot(result.note),
      });
      const warnings = [...result.warnings, ...realtimeWarnings];
      setRuntimeWarningHeader(c, warnings);
      return c.json({
        ...result.note,
        ...(warnings.length > 0 ? { runtimeWarnings: warnings } : {}),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete("/:id", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    try {
      const result = await deletion.permanentDeleteNote(userId, c.req.param("id"));
      setRuntimeWarningHeader(c, result.cleanupWarnings, result.sideEffectWarnings);
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.all("*", (c) => c.json({
    error: "该笔记操作尚未迁移到 PostgreSQL Runtime",
    code: "POSTGRES_NOTE_ROUTE_MIGRATION_PENDING",
  }, 503));

  return app;
}

export default createNotesRuntimeRouter;
