import { createHash } from "node:crypto";

import bcrypt from "bcryptjs";
import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { signFolderUnlockToken } from "../lib/knowledgeTreePasswordAccess";
import { KnowledgeTreeMutationError } from "../repositories/knowledgeTreeMutationRepository";
import { createKnowledgeTreePasswordMutationRepository } from "../repositories/knowledgeTreePasswordMutationRepository";
import { createKnowledgeTreeSurfaceReadRepository } from "../repositories/knowledgeTreeSurfaceReadRepository";

function userIdOf(c: Context): string {
  return c.req.header("X-User-Id") || "";
}

function workspaceIdOf(c: Context): string | null {
  const value = c.req.query("workspaceId");
  return !value || value === "personal" ? null : value;
}

function unauthenticated(c: Context): Response | null {
  return userIdOf(c)
    ? null
    : c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
}

function runtimeError(c: Context, error: unknown): Response {
  if (error instanceof KnowledgeTreeMutationError) {
    return c.json(
      { error: error.message, code: error.code, ...error.details },
      error.status,
    );
  }
  console.error(
    "[knowledge-tree-surfaces-runtime] request failed:",
    error instanceof Error ? error.message : error,
  );
  return c.json(
    { error: "知识树操作失败", code: "KNOWLEDGE_TREE_SURFACE_FAILED" },
    500,
  );
}

function passwordDigest(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

export default function createKnowledgeTreeSurfacesRuntimeRouter(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
) {
  const app = new Hono();
  const surfaceRepository = createKnowledgeTreeSurfaceReadRepository(adapter, dialect);
  const passwordRepository = createKnowledgeTreePasswordMutationRepository(adapter, dialect);

  app.get("/shared-with-me", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      return c.json({
        nodes: await surfaceRepository.listSharedWithMe({
          userId: userIdOf(c),
          workspaceId: workspaceIdOf(c),
        }),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  });

  app.get("/nodes/:nodeId/history", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      return c.json({
        history: await surfaceRepository.listHistory({
          actorUserId: userIdOf(c),
          nodeId: c.req.param("nodeId"),
        }),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  });

  app.post("/nodes/:nodeId/unlock", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const actorUserId = userIdOf(c);
      const nodeId = c.req.param("nodeId");
      const target = await passwordRepository.readForUnlock({ actorUserId, nodeId });
      const body = await c.req.json().catch(() => ({}));
      const password = typeof body.password === "string" ? body.password : "";

      if (
        target.passwordHash
        && (!password || !(await bcrypt.compare(passwordDigest(password), target.passwordHash)))
      ) {
        return c.json(
          { error: "密码错误", code: "FOLDER_PASSWORD_INVALID" },
          403,
        );
      }

      return c.json({
        success: true,
        isPasswordProtected: Boolean(target.passwordHash),
        unlockToken: signFolderUnlockToken({
          userId: actorUserId,
          nodeId,
          notebookId: target.notebookId,
          passwordVersion: target.passwordVersion,
        }),
      });
    } catch (error) {
      return runtimeError(c, error);
    }
  });

  app.put("/nodes/:nodeId/password", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const actorUserId = userIdOf(c);
      const nodeId = c.req.param("nodeId");
      const body = await c.req.json().catch(() => ({}));
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (newPassword.length < 4 || newPassword.length > 64 || !newPassword.trim()) {
        return c.json(
          { error: "密码长度需为 4–64 个字符", code: "FOLDER_PASSWORD_INVALID_LENGTH" },
          400,
        );
      }

      const target = await passwordRepository.readForUpdate({ actorUserId, nodeId });
      if (
        target.passwordHash
        && (
          !currentPassword
          || !(await bcrypt.compare(passwordDigest(currentPassword), target.passwordHash))
        )
      ) {
        return c.json(
          { error: "当前密码错误", code: "FOLDER_PASSWORD_CURRENT_INVALID" },
          403,
        );
      }

      const passwordHash = await bcrypt.hash(passwordDigest(newPassword), 10);
      await passwordRepository.setPassword({
        actorUserId,
        nodeId,
        passwordHash,
        expectedPasswordHash: target.passwordHash,
        expectedPasswordVersion: target.passwordVersion,
      });
      return c.json({ success: true, isPasswordProtected: true });
    } catch (error) {
      return runtimeError(c, error);
    }
  });

  return app;
}
