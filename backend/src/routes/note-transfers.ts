import { Hono } from "hono";
import {
  executeNoteTransfer,
  NoteTransferError,
  previewNoteTransfer,
  type NoteTransferMode,
  type NoteTransferRequest,
} from "../services/noteTransfer.js";

const app = new Hono();

function normalizeWorkspaceId(value: unknown): string | null {
  if (value == null || value === "" || value === "personal") return null;
  return String(value);
}

function parseRequest(c: any, body: any): NoteTransferRequest {
  const sourceNoteIds = Array.isArray(body?.sourceNoteIds)
    ? body.sourceNoteIds.map((id: unknown) => String(id || ""))
    : body?.sourceNoteId
      ? [String(body.sourceNoteId)]
      : [];
  const rawMode = String(body?.mode || "copy") as NoteTransferMode;
  const expectedVersions = body?.expectedVersions && typeof body.expectedVersions === "object"
    ? Object.fromEntries(
        Object.entries(body.expectedVersions)
          .map(([id, version]) => [id, Number(version)])
          .filter(([, version]) => Number.isFinite(version)),
      )
    : undefined;

  return {
    actorUserId: c.req.header("X-User-Id") || "",
    actorConnectionId: c.req.header("X-Connection-Id") || undefined,
    sourceNoteIds,
    targetWorkspaceId: normalizeWorkspaceId(body?.targetWorkspaceId),
    targetNotebookId: String(body?.targetNotebookId || ""),
    mode: rawMode,
    includeAttachments: body?.includeAttachments !== false,
    includeTags: body?.includeTags !== false,
    expectedVersions,
  };
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof NoteTransferError) {
    return c.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status as any,
    );
  }
  console.error("[note-transfer] unexpected error", error);
  return c.json({ error: "笔记转移失败", code: "NOTE_TRANSFER_FAILED" }, 500);
}

app.post("/preview", async (c) => {
  c.header("Cache-Control", "private, no-store");
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(previewNoteTransfer(parseRequest(c, body)));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  try {
    const body = await c.req.json().catch(() => ({}));
    const request = parseRequest(c, body);
    if (request.mode === "move" && !request.expectedVersions) {
      return c.json(
        {
          error: "移动前必须先调用预检接口并提交 sourceVersions",
          code: "TRANSFER_PREVIEW_REQUIRED",
        },
        409,
      );
    }
    const result = executeNoteTransfer(request);
    return c.json(result, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default app;
