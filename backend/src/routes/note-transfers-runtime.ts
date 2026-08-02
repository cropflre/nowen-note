import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createNoteTransferPreviewRuntime,
  NoteTransferPreviewRuntimeError,
  type NoteTransferPreviewRuntimeRequest,
  type NoteTransferRuntimeMode,
} from "../services/note-transfer-preview-runtime";

function normalizeWorkspaceId(value: unknown): string | null {
  if (value == null || value === "" || value === "personal") return null;
  return String(value);
}

function rejectNonInteractiveCredential(c: Context): Response | null {
  if (c.req.header("X-Auth-Mode") !== "api-token") return null;
  return c.json(
    {
      error: "跨空间复制和移动涉及权限边界与数据归属变更，请使用已登录的交互式会话操作",
      code: "INTERACTIVE_LOGIN_REQUIRED",
    },
    403,
  );
}

function parseRequest(c: Context, body: Record<string, unknown>): NoteTransferPreviewRuntimeRequest {
  const sourceNoteIds = Array.isArray(body.sourceNoteIds)
    ? body.sourceNoteIds.map((id) => String(id || ""))
    : body.sourceNoteId
      ? [String(body.sourceNoteId)]
      : [];
  const expectedVersions = body.expectedVersions && typeof body.expectedVersions === "object"
    ? Object.fromEntries(
      Object.entries(body.expectedVersions)
        .map(([id, version]) => [id, Number(version)])
        .filter(([, version]) => Number.isFinite(version)),
    )
    : undefined;

  return {
    actorUserId: c.req.header("X-User-Id") || "",
    sourceNoteIds,
    targetWorkspaceId: normalizeWorkspaceId(body.targetWorkspaceId),
    targetNotebookId: String(body.targetNotebookId || ""),
    mode: String(body.mode || "copy") as NoteTransferRuntimeMode,
    includeAttachments: body.includeAttachments !== false,
    includeTags: body.includeTags !== false,
    expectedVersions,
  };
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof NoteTransferPreviewRuntimeError) {
    return c.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    );
  }
  console.error(
    "[note-transfers-runtime] request failed:",
    error instanceof Error ? error.message : error,
  );
  return c.json(
    { error: "笔记转移预检失败", code: "NOTE_TRANSFER_PREVIEW_FAILED" },
    500,
  );
}

export default function createNoteTransfersRuntimeRouter(adapter?: DatabaseAdapter) {
  const app = new Hono();
  const runtime = createNoteTransferPreviewRuntime(adapter);

  app.post("/preview", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
      return c.json(await runtime.preview(parseRequest(c, body)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/", (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;
    return c.json(
      {
        error: "PostgreSQL 笔记转移执行事务尚未迁移，请先使用预检接口",
        code: "POSTGRES_NOTE_TRANSFER_EXECUTION_PENDING",
        issue: 249,
      },
      503,
    );
  });

  return app;
}
