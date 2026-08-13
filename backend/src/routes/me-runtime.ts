import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";

function toBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  return value === 1 || value === "1" || value === "true";
}

export function createMeRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();

  app.get("/", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const user = await adapter.queryOne<Record<string, any>>(
      `SELECT id, username, email,
              "avatarUrl" AS "avatarUrl",
              "displayName" AS "displayName",
              role,
              "isDemo" AS "isDemo",
              "personalExportEnabled" AS "personalExportEnabled",
              "personalImportEnabled" AS "personalImportEnabled",
              "createdAt" AS "createdAt"
         FROM users WHERE id = ?`,
      [userId],
    );

    if (!user) return c.json({ error: "用户不存在", code: "USER_NOT_FOUND" }, 404);

    return c.json({
      ...user,
      role: user.role || "user",
      isDemo: toBoolean(user.isDemo),
      personalExportEnabled: toBoolean(user.personalExportEnabled, true),
      personalImportEnabled: toBoolean(user.personalImportEnabled, true),
    });
  });

  return app;
}

export default createMeRuntimeRouter;
