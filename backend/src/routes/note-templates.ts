import { Hono } from "hono";

import {
  createNoteFromTemplate,
  createNoteTemplateFromNote,
  deleteNoteTemplate,
  listNoteTemplates,
  NoteTemplateError,
} from "../services/noteTemplates.js";
import { KnowledgeTreeError } from "../services/knowledgeTree.js";

const app = new Hono();

function userIdOf(c: any): string {
  return c.req.header("X-User-Id") || "";
}

function workspaceIdOf(c: any): string | null {
  const value = c.req.query("workspaceId");
  return !value || value === "personal" || value === "null" ? null : value;
}

function mapError(c: any, error: unknown): Response {
  if (error instanceof NoteTemplateError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof KnowledgeTreeError) {
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  }
  console.error("[note-templates] request failed:", error);
  return c.json({ error: "笔记模板操作失败", code: "NOTE_TEMPLATE_FAILED" }, 500);
}

app.get("/", (c) => {
  try {
    return c.json({
      templates: listNoteTemplates({
        userId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
      }),
    });
  } catch (error) {
    return mapError(c, error);
  }
});

app.post("/from-note/:noteId", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const template = await createNoteTemplateFromNote({
      userId: userIdOf(c),
      workspaceId: workspaceIdOf(c),
      noteId: c.req.param("noteId"),
      name: typeof body.name === "string" ? body.name : "",
    });
    return c.json({ template }, 201);
  } catch (error) {
    return mapError(c, error);
  }
});

app.delete("/:templateId", async (c) => {
  try {
    return c.json(await deleteNoteTemplate({
      userId: userIdOf(c),
      workspaceId: workspaceIdOf(c),
      templateId: c.req.param("templateId"),
    }));
  } catch (error) {
    return mapError(c, error);
  }
});

app.post("/:templateId/create-note", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    if (body.parentId !== null && body.parentId !== undefined && typeof body.parentId !== "string") {
      return c.json({ error: "parentId 必须是字符串或 null", code: "NOTE_TEMPLATE_PARENT_INVALID" }, 400);
    }
    const result = await createNoteFromTemplate({
      userId: userIdOf(c),
      workspaceId: workspaceIdOf(c),
      templateId: c.req.param("templateId"),
      parentId: typeof body.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : null,
    });
    return c.json(result, 201);
  } catch (error) {
    return mapError(c, error);
  }
});

export default app;
