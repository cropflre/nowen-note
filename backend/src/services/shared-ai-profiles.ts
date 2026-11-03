import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { AppError } from "../lib/app-error.js";
import { userAISettingsRepository } from "../repositories/userAISettingsRepository.js";
import type { AISettings } from "./ai-client.js";
import { maskAIHeaders, normalizeAIHeaders } from "./ai-provider-config.js";
import { nonChatModelKind } from "./ai-model-kind.js";

export const ACTIVE_SHARED_AI_KEY = "ai_active_shared_profile_id";

export class SharedAIProfileError extends AppError {
  constructor(code: string, message: string, status = 403) {
    super(code, message, { status });
  }
}

export interface SharedAIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  customHeadersJson: string;
  model: string;
  enabled: number;
  revision: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const draftSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  provider: z.string().trim().min(1).max(40).optional(),
  apiUrl: z.string().trim().min(1).max(500).optional(),
  apiKey: z.string().trim().max(2000).optional(),
  customHeaders: z.record(z.string()).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  memberIds: z.array(z.string().min(1).max(100)).max(1000).optional(),
  revision: z.number().int().positive().optional(),
  sourceProfileId: z.string().min(1).max(100).optional(),
}).strict();

export function getSharedAIProfile(id: string): SharedAIProfile | undefined {
  return getDb().prepare("SELECT * FROM shared_ai_profiles WHERE id = ?").get(id) as SharedAIProfile | undefined;
}

function memberIds(profileId: string): string[] {
  return (getDb().prepare("SELECT userId FROM shared_ai_profile_grants WHERE profileId = ? ORDER BY userId")
    .all(profileId) as Array<{ userId: string }>).map((row) => row.userId);
}

export function publicSharedAIProfile(profile: SharedAIProfile) {
  return {
    id: profile.id, name: profile.name, provider: profile.provider, model: profile.model,
    enabled: !!profile.enabled, revision: profile.revision,
    createdAt: profile.createdAt, updatedAt: profile.updatedAt,
  };
}

export function adminSharedAIProfile(profile: SharedAIProfile) {
  return {
    ...publicSharedAIProfile(profile), apiUrl: profile.apiUrl,
    apiKey: profile.apiKey ? "****" : "", apiKeySet: !!profile.apiKey,
    customHeaders: maskAIHeaders(profile.customHeadersJson), memberIds: memberIds(profile.id),
  };
}

export function listSharedAIProfiles(userId: string) {
  return (getDb().prepare(`SELECT p.* FROM shared_ai_profiles p
    JOIN shared_ai_profile_grants g ON g.profileId = p.id
    JOIN users u ON u.id = g.userId
    WHERE g.userId = ? AND p.enabled = 1 AND u.isDisabled = 0 ORDER BY p.name, p.id`)
    .all(userId) as SharedAIProfile[]).map(publicSharedAIProfile);
}

export function listAdminSharedAIProfiles() {
  return (getDb().prepare("SELECT * FROM shared_ai_profiles ORDER BY name, id").all() as SharedAIProfile[])
    .map(adminSharedAIProfile);
}

export function sharedProfileSettings(profile: SharedAIProfile): AISettings {
  return {
    ai_provider: profile.provider, ai_api_url: profile.apiUrl, ai_api_key: profile.apiKey,
    ai_custom_headers: profile.customHeadersJson, ai_model: profile.model,
    ai_embedding_profile_id: "", ai_embedding_url: "", ai_embedding_key: "", ai_embedding_model: "",
  };
}

export function resolveSharedProfileSettings(userId: string, profileId: string): AISettings {
  if (!userId) throw new SharedAIProfileError("UNAUTHENTICATED", "请先登录", 401);
  if (userAISettingsRepository.get(userId, "ai_manual_enabled")?.value === "false") {
    throw new SharedAIProfileError("AI_DISABLED", "AI 已关闭，请先启用 AI");
  }
  const profile = getDb().prepare(`SELECT p.* FROM shared_ai_profiles p
    JOIN shared_ai_profile_grants g ON g.profileId = p.id
    JOIN users u ON u.id = g.userId
    WHERE p.id = ? AND g.userId = ? AND p.enabled = 1 AND u.isDisabled = 0`)
    .get(profileId, userId) as SharedAIProfile | undefined;
  if (!profile) throw new SharedAIProfileError("AI_SHARED_PROFILE_UNAVAILABLE", "当前共享配置不可用，请重新选择模型");
  return sharedProfileSettings(profile);
}

export function resolveSharedChatSettings(userId: string): AISettings | null {
  const id = userAISettingsRepository.get(userId, ACTIVE_SHARED_AI_KEY)?.value;
  return id ? resolveSharedProfileSettings(userId, id) : null;
}

export function activateSharedAIProfile(userId: string, id: string): void {
  // Selection is allowed with AI off, but use still checks the switch.
  const profile = getDb().prepare(`SELECT p.id FROM shared_ai_profiles p
    JOIN shared_ai_profile_grants g ON g.profileId = p.id
    JOIN users u ON u.id = g.userId
    WHERE p.id = ? AND g.userId = ? AND p.enabled = 1 AND u.isDisabled = 0`).get(id, userId);
  if (!profile) throw new SharedAIProfileError("AI_SHARED_PROFILE_UNAVAILABLE", "当前共享配置不可用，请重新选择模型");
  userAISettingsRepository.set(userId, ACTIVE_SHARED_AI_KEY, id);
}

export function saveSharedAIProfile(userId: string, input: unknown, existingId?: string) {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new SharedAIProfileError("INVALID_INPUT", "共享配置参数无效", 400);
  const draft = parsed.data;
  const db = getDb();
  return db.transaction(() => {
    const existing = existingId ? getSharedAIProfile(existingId) : undefined;
    if (existingId && !existing) throw new SharedAIProfileError("AI_SHARED_PROFILE_NOT_FOUND", "共享配置不存在", 404);
    if (existing && draft.revision !== existing.revision) throw new SharedAIProfileError("AI_SHARED_PROFILE_CONFLICT", "共享配置已更新，请刷新后重试", 409);
    if (!existing && (db.prepare("SELECT count(*) AS count FROM shared_ai_profiles").get() as { count: number }).count >= 30) {
      throw new SharedAIProfileError("AI_SHARED_PROFILE_LIMIT", "最多保存 30 个共享配置", 400);
    }
    let source: Record<string, unknown> = {};
    if (draft.sourceProfileId) {
      if (existing) throw new SharedAIProfileError("INVALID_INPUT", "更新时不能重新指定来源配置", 400);
      try {
        const profiles = JSON.parse(userAISettingsRepository.get(userId, "ai_profiles_v1")?.value || "[]");
        source = profiles.find((profile: { id: string }) => profile.id === draft.sourceProfileId);
      } catch { source = {}; }
      if (!source?.id) throw new SharedAIProfileError("AI_PROFILE_NOT_FOUND", "个人配置不存在", 404);
    }
    const value = { ...source, ...draft };
    const field = (name: keyof typeof draft, fallback = "") => typeof value[name] === "string" ? String(value[name]).trim() : fallback;
    const name = field("name", existing?.name);
    const provider = field("provider", existing?.provider || "openai");
    const model = field("model", existing?.model);
    const apiUrl = field("apiUrl", existing?.apiUrl).replace(/\/+$/, "");
    if (!name || !model || !apiUrl || nonChatModelKind(model)) throw new SharedAIProfileError("INVALID_INPUT", "请填写名称、聊天模型和有效服务地址", 400);
    try {
      const url = new URL(apiUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw new SharedAIProfileError("INVALID_INPUT", "AI 地址必须使用 http 或 https，且不能包含用户名密码", 400); }
    let headers: Record<string, string>;
    try { headers = normalizeAIHeaders(value.customHeaders, existing ? normalizeAIHeaders(existing.customHeadersJson) : {}); }
    catch { throw new SharedAIProfileError("INVALID_INPUT", "自定义请求头无效，请检查名称和值", 400); }
    const suppliedKey = field("apiKey", existing?.apiKey);
    const apiKey = suppliedKey.includes("****") ? existing?.apiKey || "" : suppliedKey;
    const enabled = draft.enabled === undefined ? existing?.enabled ?? 1 : Number(draft.enabled);
    const members = [...new Set(draft.memberIds ?? (existing ? memberIds(existing.id) : []))];
    for (const id of members) {
      if (!db.prepare("SELECT id FROM users WHERE id = ? AND isDisabled = 0").get(id)) {
        throw new SharedAIProfileError("INVALID_MEMBER", "共享成员不存在或已停用", 400);
      }
    }
    const now = new Date().toISOString();
    const id = existing?.id || `shared-ai-${randomUUID()}`;
    if (existing) {
      db.prepare(`UPDATE shared_ai_profiles SET name=?, provider=?, apiUrl=?, apiKey=?, customHeadersJson=?, model=?, enabled=?, revision=revision+1, updatedAt=? WHERE id=?`)
        .run(name, provider, apiUrl, apiKey, JSON.stringify(headers), model, enabled, now, id);
    } else {
      db.prepare(`INSERT INTO shared_ai_profiles (id,name,provider,apiUrl,apiKey,customHeadersJson,model,enabled,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, name, provider, apiUrl, apiKey, JSON.stringify(headers), model, enabled, userId, now, now);
    }
    db.prepare("DELETE FROM shared_ai_profile_grants WHERE profileId = ?").run(id);
    const grant = db.prepare("INSERT INTO shared_ai_profile_grants (profileId,userId) VALUES (?,?)");
    for (const user of members) grant.run(id, user);
    return adminSharedAIProfile(getSharedAIProfile(id)!);
  })();
}

export function deleteSharedAIProfile(id: string, revision: number): void {
  const db = getDb();
  db.transaction(() => {
    const profile = getSharedAIProfile(id);
    if (!profile) throw new SharedAIProfileError("AI_SHARED_PROFILE_NOT_FOUND", "共享配置不存在", 404);
    if (profile.revision !== revision) throw new SharedAIProfileError("AI_SHARED_PROFILE_CONFLICT", "共享配置已更新，请刷新后重试", 409);
    db.prepare("DELETE FROM shared_ai_profiles WHERE id = ?").run(id);
  })();
}
