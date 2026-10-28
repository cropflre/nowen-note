import { getDb } from "../db/schema";
import { AppError } from "../lib/app-error";
import { getActiveProfile } from "../sync/profile";
import { getRemoteCredential } from "../sync/credentials";
import { isLocalFirstSyncV2Enabled } from "../sync/flag";
import { getUserAISetting, getUserAISettings, isManualAIEnabled, setUserAISetting } from "./user-ai-settings";
import type { AISettings } from "./ai-client";

const PREFIX = "remote-shared:";
interface RemoteBinding {
  localUserId: string;
  syncProfileId: string;
  remoteUserId: string;
  serverUrl: string;
}
interface RemoteSelection extends RemoteBinding {
  kind: "remote-shared";
  sharedProfileId: string;
  name: string;
  provider: string;
  model: string;
}
interface PublicRemoteProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: true;
}

function unavailable(): never {
  throw new AppError("AI_SHARED_REMOTE_UNAVAILABLE", "共享模型需要连接原服务器账号，请检查同步连接或重新选择模型", { status: 403 });
}

/** The desktop sync relationship is installation-scoped, so only its local account may use it. */
function bindingForUser(userId: string): RemoteBinding | null {
  if (!process.env.ELECTRON_USER_DATA || !isLocalFirstSyncV2Enabled()) return null;
  const local = getDb().prepare("SELECT id FROM users ORDER BY createdAt ASC, rowid ASC LIMIT 1").get() as { id: string } | undefined;
  if (local?.id !== userId) return null;
  const profile = getActiveProfile(getDb());
  if (!profile?.remoteUserId) return null;
  const credential = getRemoteCredential(profile.id);
  if (!credential || credential.remoteUserId !== profile.remoteUserId
    || credential.serverUrl.replace(/\/+$/, "") !== profile.serverUrl.replace(/\/+$/, "")) return null;
  return { localUserId: userId, syncProfileId: profile.id, remoteUserId: profile.remoteUserId, serverUrl: profile.serverUrl.replace(/\/+$/, "") };
}

function sameBinding(a: RemoteBinding | null, b: RemoteBinding): boolean {
  return !!a && a.localUserId === b.localUserId && a.syncProfileId === b.syncProfileId
    && a.remoteUserId === b.remoteUserId && a.serverUrl === b.serverUrl;
}

function reference(binding: RemoteBinding, id: string): string {
  return PREFIX + Buffer.from(JSON.stringify([binding.syncProfileId, id])).toString("base64url");
}

async function remoteRequest(binding: RemoteBinding, path: string, init: RequestInit = {}): Promise<Response> {
  if (!sameBinding(bindingForUser(binding.localUserId), binding)) unavailable();
  const credential = getRemoteCredential(binding.syncProfileId)!;
  let result: Response;
  try {
    result = await fetch(`${binding.serverUrl}/api/ai${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}`, ...(path === "/profiles/available" ? { "X-Nowen-Shared-Directory": "local" } : {}) },
      redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new AppError("AI_SHARED_REMOTE_UNREACHABLE", "无法连接共享模型服务器，请检查连接后重试", { status: 503 });
  }
  if (!sameBinding(bindingForUser(binding.localUserId), binding)) {
    void result.body?.cancel().catch(() => undefined);
    unavailable();
  }
  if (!result.ok) {
    void result.body?.cancel().catch(() => undefined);
    throw new AppError("AI_SHARED_REMOTE_UNAVAILABLE", result.status === 404
      ? "服务器尚不支持此共享模型功能，请升级服务器或重新选择模型"
      : "共享模型不可用，授权可能已撤销或登录已过期，请重新连接服务器或选择模型", { status: result.status === 401 ? 401 : 403 });
  }
  if (!result.body) return result;
  const reader = result.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!sameBinding(bindingForUser(binding.localUserId), binding)) unavailable();
        const chunk = await reader.read();
        if (!sameBinding(bindingForUser(binding.localUserId), binding)) unavailable();
        if (chunk.done) { controller.close(); reader.releaseLock(); }
        else controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); void reader.cancel().catch(() => undefined); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { headers: result.headers, status: result.status });
}

async function readDirectory(binding: RemoteBinding): Promise<Array<Omit<PublicRemoteProfile, "enabled">>> {
  const response = await remoteRequest(binding, "/profiles/available");
  const data = await response.json().catch(() => null) as any;
  if (!sameBinding(bindingForUser(binding.localUserId), binding)) unavailable();
  if (!data || data.capabilities?.sharedProfiles !== 1 || !Array.isArray(data.sharedProfiles)) {
    throw new AppError("AI_SHARED_REMOTE_UNAVAILABLE", "服务器尚不支持共享模型，请升级服务器", { status: 409 });
  }
  return data.sharedProfiles.filter((p: any) => p && typeof p.id === "string" && !p.id.startsWith(PREFIX)
    && p.id.length <= 100 && typeof p.name === "string" && typeof p.provider === "string"
    && typeof p.model === "string" && p.enabled !== false).map((p: any) => ({
      id: p.id, name: p.name.slice(0, 80), provider: p.provider.slice(0, 40), model: p.model.slice(0, 200),
    }));
}

export async function listRemoteSharedProfiles(userId: string): Promise<{ profiles: PublicRemoteProfile[]; error?: string }> {
  const binding = bindingForUser(userId);
  if (!binding) return { profiles: [] };
  try {
    return { profiles: (await readDirectory(binding)).map(profile => ({ ...profile, id: reference(binding, profile.id), enabled: true })) };
  } catch (error) {
    return { profiles: [], error: error instanceof AppError ? error.message : "无法读取服务器共享模型" };
  }
}

/** Resolve an opaque directory reference again before persisting public metadata only. */
export async function activateRemoteSharedProfile(userId: string, id: string): Promise<boolean> {
  if (!id.startsWith(PREFIX)) return false;
  const binding = bindingForUser(userId);
  if (!binding) unavailable();
  let parts: unknown;
  try { parts = JSON.parse(Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8")); } catch { unavailable(); }
  if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== binding.syncProfileId || typeof parts[1] !== "string") unavailable();
  const profile = (await readDirectory(binding)).find(profile => profile.id === parts[1]);
  if (!profile || !sameBinding(bindingForUser(userId), binding)) unavailable();
  const selection: RemoteSelection = { kind: "remote-shared", ...binding, sharedProfileId: profile.id, name: profile.name, provider: profile.provider, model: profile.model };
  setUserAISetting(userId, "ai_active_shared_profile_id", JSON.stringify(selection));
  return true;
}

export function remoteSharedActiveId(userId: string): string | null {
  const selection = readSelection(userId);
  return selection ? reference(selection, selection.sharedProfileId) : null;
}

export function getRemoteSharedSelectionId(raw: string): string | null {
  if (!raw.startsWith("{")) return null;
  try {
    const selection = JSON.parse(raw) as RemoteSelection;
    return selection.kind === "remote-shared" ? reference(selection, selection.sharedProfileId) : null;
  } catch { return null; }
}

function readSelection(userId: string): RemoteSelection | null {
  const raw = getUserAISetting(userId, "ai_active_shared_profile_id");
  if (!raw.startsWith("{")) return null;
  let selection: RemoteSelection;
  try { selection = JSON.parse(raw); } catch { unavailable(); }
  if (selection.kind !== "remote-shared") unavailable();
  if (selection.localUserId !== userId || !sameBinding(bindingForUser(userId), selection)) unavailable();
  return selection;
}

export function resolveRemoteSharedChatSettings(userId: string): AISettings | null {
  const selection = readSelection(userId);
  if (!selection) return null;
  if (!isManualAIEnabled(userId)) throw new AppError("AI_DISABLED", "AI 已关闭", { status: 403 });
  return {
    ...getUserAISettings(userId),
    ai_provider: selection.provider,
    ai_api_url: `${selection.serverUrl}/api/ai/shared-profiles/${encodeURIComponent(selection.sharedProfileId)}`,
    ai_api_key: "",
    ai_custom_headers: "{}",
    ai_model: selection.model,
    ai_remote_shared: selection,
  };
}

export async function requestRemoteSharedChat(settings: AISettings, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const binding = settings.ai_remote_shared;
  if (!binding) unavailable();
  if (!isManualAIEnabled(binding.localUserId)) throw new AppError("AI_DISABLED", "AI 已关闭", { status: 403 });
  return remoteRequest(binding, `/shared-profiles/${encodeURIComponent(binding.sharedProfileId)}/invoke`, {
    method: "POST", body: JSON.stringify(body), signal,
  });
}
