import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { AppError } from "../lib/app-error.js";
import { isSystemAdmin, requireAdmin } from "../middleware/acl.js";
import { userAISettingsRepository } from "../repositories/userAISettingsRepository.js";
import { callAIChat, sanitizeError } from "../services/ai-client.js";
import { redactAICredentials } from "../services/ai-provider-config.js";
import {
  ACTIVE_SHARED_AI_KEY, activateSharedAIProfile, deleteSharedAIProfile, getSharedAIProfile,
  listAdminSharedAIProfiles, listSharedAIProfiles, saveSharedAIProfile, sharedProfileSettings,
  SharedAIProfileError,
} from "../services/shared-ai-profiles.js";
import { activateRemoteSharedProfile, getRemoteSharedSelectionId, listRemoteSharedProfiles } from "../services/remote-shared-ai.js";
import { createSharedAIInvocationResponse } from "../services/shared-ai-invocation.js";
import legacyProfiles, { ensureAIProfiles, publicAIProfile } from "./user-preferences-legacy.js";

const app = new Hono();
const requireProfileSession: MiddlewareHandler = async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ code: "UNAUTHENTICATED", error: "请先登录" }, 401);
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ code: "AI_PROFILE_SESSION_REQUIRED", error: "请使用登录会话管理或选择共享配置" }, 403);
  c.header("Cache-Control", "no-store");
  await next();
};
for (const path of ["/profiles/*", "/shared-profiles", "/shared-profiles/*"]) {
  app.use(path, requireProfileSession);
  app.use(path, bodyLimit({ maxSize: 1_000_000 }));
}
app.onError((error, c) => {
  if (error instanceof AppError) return c.json({ code: error.code, error: error.message }, error.status as 400);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: "INVALID_INPUT", error: "请求参数无效" }, 400);
  return c.json({ code: "AI_SHARED_REQUEST_FAILED", error: "共享配置操作失败，请稍后重试" }, 500);
});

app.get("/profiles/available", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const personal = ensureAIProfiles(userId);
  const sharedProfiles = listSharedAIProfiles(userId);
  const remote = c.req.header("X-Nowen-Shared-Directory") === "local"
    ? { profiles: [] }
    : await listRemoteSharedProfiles(userId);
  const shared = [...sharedProfiles, ...remote.profiles];
  const raw = userAISettingsRepository.get(userId, ACTIVE_SHARED_AI_KEY)?.value || "";
  const sharedId = getRemoteSharedSelectionId(raw) || raw;
  return c.json({
    personalProfiles: personal.profiles.map(publicAIProfile), sharedProfiles: shared,
    active: sharedId ? { scope: "shared", id: sharedId } : { scope: "personal", id: personal.activeProfileId },
    unavailable: !!sharedId && !shared.some((profile) => profile.id === sharedId),
    sharedSupported: true, capabilities: { sharedProfiles: 1 }, isAdmin: isSystemAdmin(userId),
    aiEnabled: userAISettingsRepository.get(userId, "ai_manual_enabled")?.value !== "false",
    ...(remote.error ? { remoteError: remote.error } : {}),
  });
});

app.put("/profiles/active", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const active = z.object({ scope: z.enum(["personal", "shared"]), id: z.string().min(1).max(1000) }).strict().parse(await c.req.json());
  if (active.scope === "shared") {
    if (!await activateRemoteSharedProfile(userId, active.id)) activateSharedAIProfile(userId, active.id);
  } else {
    const response = await legacyProfiles.request(`/ai-profiles/${encodeURIComponent(active.id)}/activate`, {
      method: "PUT", headers: { "X-User-Id": userId, "Content-Type": "application/json" }, body: "{}",
    });
    if (!response.ok) return response;
    userAISettingsRepository.set(userId, ACTIVE_SHARED_AI_KEY, "");
  }
  return c.json({ active });
});

// This model-only channel leaves note access and tool execution at the caller.
app.post("/shared-profiles/:id/invoke", async (c) =>
  createSharedAIInvocationResponse(c.req.header("X-User-Id")!, c.req.param("id"), await c.req.json(), c.req.raw.signal));

app.use("/shared-profiles", requireAdmin);
app.use("/shared-profiles/*", requireAdmin);
app.get("/shared-profiles", (c) => c.json({
  profiles: listAdminSharedAIProfiles(),
  members: getDb().prepare("SELECT id, username, displayName, isDisabled FROM users ORDER BY username, id").all(),
}));
app.post("/shared-profiles", async (c) => c.json({ profile: saveSharedAIProfile(c.req.header("X-User-Id")!, await c.req.json()) }, 201));
app.put("/shared-profiles/:id", async (c) => c.json({ profile: saveSharedAIProfile(c.req.header("X-User-Id")!, await c.req.json(), c.req.param("id")) }));
app.delete("/shared-profiles/:id", async (c) => {
  const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(await c.req.json());
  deleteSharedAIProfile(c.req.param("id"), revision);
  return c.json({ success: true });
});
app.post("/shared-profiles/:id/test", async (c) => {
  const profile = getSharedAIProfile(c.req.param("id"));
  if (!profile) throw new SharedAIProfileError("AI_SHARED_PROFILE_NOT_FOUND", "共享配置不存在", 404);
  try {
    await callAIChat(sharedProfileSettings(profile), [{ role: "user", content: "Hi" }], { max_tokens: 16, timeout_ms: 20_000 });
    return c.json({ success: true, message: "连接成功" });
  } catch (error) {
    return c.json({ success: false, code: "AI_UPSTREAM_ERROR", error: sanitizeError(redactAICredentials(
      error instanceof Error ? error.message : "连接失败", profile.apiKey, profile.customHeadersJson,
    )) }, 502);
  }
});

export default app;
