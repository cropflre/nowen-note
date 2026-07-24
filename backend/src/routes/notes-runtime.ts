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

export function createNotesRuntimeRouter(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const app = new Hono();
  const core = createNoteCoreRuntime(adapter, dialect);
  const collection = createNoteCollectionRuntime(adapter, dialect);

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
      return c.json(await collection.createNote(userId, body), 201);
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
    let body: NoteCoreSaveInput;
    try {
      body = await c.req.json<NoteCoreSaveInput>();
    } catch {
      return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
    }

    try {
      const result = await core.saveNote(userId, c.req.param("id"), body);
      if (result.warnings.length > 0) {
        c.header("X-Nowen-Runtime-Warnings", String(result.warnings.length));
      }
      return c.json({
        ...result.note,
        ...(result.warnings.length > 0 ? { runtimeWarnings: result.warnings } : {}),
      });
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
