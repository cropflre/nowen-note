import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
} from "../repositories/noteTransferOperationRepository";
import { createNoteTransferAttachmentStagingRuntime } from "../services/note-transfer-attachment-staging-runtime";
import { createNoteTransferCommitRuntime } from "../services/note-transfer-commit-runtime";
import { createNoteTransferCleanupRuntime } from "../services/note-transfer-cleanup-runtime";
import {
  createNoteTransferEffectsRuntime,
  type NoteTransferEffectsRuntime,
} from "../services/note-transfer-effects-runtime";
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

function operationKey(c: Context, body: Record<string, unknown>): string {
  return String(c.req.header("Idempotency-Key") || body.idempotencyKey || "").trim();
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof NoteTransferPreviewRuntimeError || error instanceof NoteTransferOperationError) {
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
    { error: "笔记转移操作失败", code: "NOTE_TRANSFER_RUNTIME_FAILED" },
    500,
  );
}

export default function createNoteTransfersRuntimeRouter(
  adapter?: DatabaseAdapter,
  options: { effects?: NoteTransferEffectsRuntime } = {},
) {
  const app = new Hono();
  const runtime = createNoteTransferPreviewRuntime(adapter);
  const operations = createNoteTransferOperationRepository(adapter);
  const attachmentStaging = createNoteTransferAttachmentStagingRuntime(adapter, { operations });
  const commitRuntime = createNoteTransferCommitRuntime(adapter, { operations });
  const cleanupRuntime = createNoteTransferCleanupRuntime(adapter, { operations });
  const effectsRuntime = options.effects || createNoteTransferEffectsRuntime(adapter);

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

  app.post("/prepare", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
      const request = parseRequest(c, body);
      const idempotencyKey = operationKey(c, body);

      // Validate the key and reject expired prepared operations before repeating
      // object checks or generating a new target mapping.
      await operations.getPrepared({
        actorUserId: request.actorUserId,
        idempotencyKey,
      });

      const preview = await runtime.preview(request);
      if (!preview.canExecute) {
        return c.json(
          {
            error: "转移预检未通过",
            code: "NOTE_TRANSFER_PREVIEW_BLOCKED",
            blockers: preview.blockers,
            warnings: preview.warnings,
          },
          409,
        );
      }

      const operation = await operations.prepareOperation({
        actorUserId: request.actorUserId,
        idempotencyKey,
        mode: request.mode,
        sourceWorkspaceId: preview.sourceWorkspaceId,
        targetWorkspaceId: preview.targetWorkspaceId,
        targetNotebookId: preview.targetNotebookId,
        includeAttachments: request.includeAttachments !== false,
        includeTags: request.includeTags !== false,
        sourceNoteIds: preview.notes.map((note) => note.id),
        sourceVersions: preview.sourceVersions,
        attachmentCount: preview.attachmentCount,
        attachmentBytes: preview.attachmentBytes,
        tagCount: preview.tagCount,
        internalNoteLinkCount: preview.internalNoteLinkCount,
        externalNoteLinkCount: preview.externalNoteLinkCount,
      });
      return c.json(operation, operation.reused ? 200 : 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/operations/:idempotencyKey/staging", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const operation = await operations.beginStaging({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(operation, operation.reused ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/operations/:idempotencyKey/staging/resume", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const result = await attachmentStaging.resume({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(result, result.summary.complete ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/operations/:idempotencyKey/cancel", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const operation = await operations.cancelOperation({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(operation, operation.reused ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/operations/:idempotencyKey/cleanup/resume", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const result = await cleanupRuntime.resume({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(result, result.summary.complete ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/operations/:idempotencyKey/commit", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const result = await commitRuntime.commit({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      effectsRuntime.wake();
      return c.json(result, result.reused ? 200 : 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/operations/:idempotencyKey/effects/resume", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const result = await effectsRuntime.resume({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(result, result.summary.complete ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/operations/:idempotencyKey", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const operation = await operations.getPrepared({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      if (!operation) {
        return c.json(
          { error: "转移计划不存在", code: "NOTE_TRANSFER_PLAN_NOT_FOUND" },
          404,
        );
      }
      return c.json(operation);
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
        error: "PostgreSQL 笔记转移复制链路已支持分阶段提交；统一执行入口将在 move 删除与副作用收口后开放",
        code: "POSTGRES_NOTE_TRANSFER_EXECUTION_PENDING",
        issue: 249,
      },
      503,
    );
  });

  return app;
}
