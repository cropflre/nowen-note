import { Hono } from "hono";
import {
  NoteTransferError,
  previewNoteTransfer,
  type NoteTransferMode,
  type NoteTransferRequest,
} from "../services/noteTransfer.js";
import { executeNoteTransferSafe } from "../services/noteTransferSafety.js";

const app = new Hono();

function normalizeWorkspaceId(value: unknown): string | null {
  if (value == null || value === "" || value === "personal") return null;
  return String(value);
}

function rejectNonInteractiveCredential(c: any) {
  if (c.req.header("X-Auth-Mode") !== "api-token") return null;
  return c.json(
    {
      error: "跨空间复制和移动涉及权限边界与数据归属变更，请使用已登录的交互式会话操作",
      code: "INTERACTIVE_LOGIN_REQUIRED",
    },
    403,
  );
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
  const credentialError = rejectNonInteractiveCredential(c);
  if (credentialError) return credentialError;
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await previewNoteTransfer(parseRequest(c, body)));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const credentialError = rejectNonInteractiveCredential(c);
  if (credentialError) return credentialError;
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await executeNoteTransferSafe(parseRequest(c, body));
    return c.json(result, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default app;
