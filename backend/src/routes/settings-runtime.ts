import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { verifyLoginToken } from "../lib/auth-security";
import {
  PUBLIC_WEB_ORIGIN_KEY,
  PUBLIC_WEB_ORIGIN_SOURCE_KEY,
  readPublicWebOriginEnv,
  resolvePublicWebOriginSettingUpdate,
  resolveRuntimePublicWebOrigin,
} from "../lib/public-web-origin";
import { createSystemSettingsRepository } from "../repositories/systemSettingsRepository";

export interface RuntimeSiteSettings {
  site_title: string;
  site_favicon: string;
  site_icp_beian: string;
  site_public_web_origin: string;
  site_public_web_origin_source: string;
  editor_font_family: string;
  feature_personal_export_enabled: string;
  feature_personal_import_enabled: string;
  debug_files_query: string;
  web_ui_enabled: string;
}

const DEFAULTS: RuntimeSiteSettings = {
  site_title: "nowen-note",
  site_favicon: "",
  site_icp_beian: "",
  site_public_web_origin: "",
  site_public_web_origin_source: "current",
  editor_font_family: "",
  feature_personal_export_enabled: "true",
  feature_personal_import_enabled: "true",
  debug_files_query: "false",
  web_ui_enabled: "true",
};

type AuthenticatedUser = {
  id: string;
  role: string;
};

function booleanSetting(value: unknown): string {
  return value === true || value === "true" || value === 1 || value === "1"
    ? "true"
    : "false";
}

function timestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function resolveAuthenticatedUser(
  adapter: DatabaseAdapter,
  c: Context,
): Promise<AuthenticatedUser | Response> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
  }

  const payload = verifyLoginToken(authHeader.slice(7));
  if (!payload?.userId) {
    return c.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, 401);
  }

  const user = await adapter.queryOne<{
    id: string;
    role: string | null;
    tokenVersion: number;
    isDisabled: boolean | number;
  }>(
    `SELECT id, role, "tokenVersion" AS "tokenVersion", "isDisabled" AS "isDisabled"
       FROM users WHERE id = ?`,
    [payload.userId],
  );

  if (!user) {
    return c.json({ error: "账号不存在或已被删除", code: "USER_NOT_FOUND" }, 401);
  }
  if (user.isDisabled === true || user.isDisabled === 1) {
    return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);
  }
  if ((payload.tver ?? 0) !== (user.tokenVersion ?? 0)) {
    return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
  }

  if (payload.jti) {
    const session = await adapter.queryOne<{
      revokedAt: string | Date | null;
      expiresAt: string | Date | null;
    }>(
      `SELECT "revokedAt" AS "revokedAt", "expiresAt" AS "expiresAt"
         FROM user_sessions WHERE id = ? AND "userId" = ?`,
      [payload.jti, payload.userId],
    );
    if (!session) {
      return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
    }
    if (session.revokedAt) {
      return c.json({ error: "该会话已被下线", code: "SESSION_REVOKED" }, 401);
    }
    const expiresAt = timestampMs(session.expiresAt);
    if (expiresAt != null && expiresAt <= Date.now()) {
      return c.json({ error: "会话已过期，请重新登录", code: "SESSION_EXPIRED" }, 401);
    }
  }

  return { id: user.id, role: user.role || "user" };
}

export function createSettingsRuntimeRouter(
  adapter: DatabaseAdapter,
  env: NodeJS.ProcessEnv = process.env,
) {
  const settings = new Hono();
  const repository = createSystemSettingsRepository(adapter, "CURRENT_TIMESTAMP");

  async function synchronizeRuntimeSettings(): Promise<void> {
    const storedRows = await repository.getManyAsync([
      PUBLIC_WEB_ORIGIN_KEY,
      PUBLIC_WEB_ORIGIN_SOURCE_KEY,
    ]);
    const stored = new Map(storedRows.map((row) => [row.key, row.value]));
    const resolvedOrigin = resolveRuntimePublicWebOrigin({
      storedOrigin: stored.get(PUBLIC_WEB_ORIGIN_KEY),
      storedSource: stored.get(PUBLIC_WEB_ORIGIN_SOURCE_KEY),
      envOrigin: readPublicWebOriginEnv(env),
    });

    const icpBeian = String(env.NOWEN_ICP_BEIAN ?? env.ICP_BEIAN ?? "")
      .trim()
      .slice(0, 80);

    await repository.setManyAsync([
      { key: PUBLIC_WEB_ORIGIN_KEY, value: resolvedOrigin.origin },
      { key: PUBLIC_WEB_ORIGIN_SOURCE_KEY, value: resolvedOrigin.source },
      { key: "site_icp_beian", value: icpBeian },
    ]);
  }

  async function readSettings(): Promise<Record<string, string>> {
    await synchronizeRuntimeSettings();
    const [rows, webUiSetting] = await Promise.all([
      repository.getByPrefixesAsync(["site_", "editor_", "feature_", "debug_"]),
      repository.getAsync("web_ui_enabled"),
    ]);
    const result: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) result[row.key] = row.value;
    if (webUiSetting) result[webUiSetting.key] = webUiSetting.value;
    return result;
  }

  settings.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await readSettings());
  });

  settings.put("/", async (c) => {
    const authenticated = await resolveAuthenticatedUser(adapter, c);
    if (authenticated instanceof Response) return authenticated;

    const body = await c.req.json().catch(() => ({})) as Partial<RuntimeSiteSettings>;
    const wantsAdminSetting =
      body.site_title !== undefined
      || body.site_favicon !== undefined
      || body.site_public_web_origin !== undefined
      || body.debug_files_query !== undefined
      || body.web_ui_enabled !== undefined;

    if (wantsAdminSetting && authenticated.role !== "admin") {
      return c.json({ error: "仅管理员可修改该设置", code: "FORBIDDEN" }, 403);
    }

    const entries: Array<{ key: string; value: string }> = [];
    if (body.site_title !== undefined) {
      entries.push({ key: "site_title", value: String(body.site_title).trim().slice(0, 20) });
    }
    if (body.site_favicon !== undefined) {
      entries.push({ key: "site_favicon", value: String(body.site_favicon) });
    }
    if (body.site_public_web_origin !== undefined) {
      const resolved = resolvePublicWebOriginSettingUpdate(body.site_public_web_origin, env);
      if ("error" in resolved) {
        return c.json({ error: resolved.error, code: "INVALID_PUBLIC_WEB_ORIGIN" }, 400);
      }
      entries.push(...resolved.entries);
    }
    if (body.editor_font_family !== undefined) {
      entries.push({ key: "editor_font_family", value: String(body.editor_font_family) });
    }
    if (body.debug_files_query !== undefined) {
      entries.push({ key: "debug_files_query", value: booleanSetting(body.debug_files_query) });
    }
    if (body.web_ui_enabled !== undefined) {
      entries.push({ key: "web_ui_enabled", value: booleanSetting(body.web_ui_enabled) });
    }

    // site_icp_beian is intentionally ignored: it is environment-managed in both runtimes.
    if (entries.length > 0) await repository.setManyAsync(entries);
    return c.json(await readSettings());
  });

  return settings;
}

export default createSettingsRuntimeRouter;
