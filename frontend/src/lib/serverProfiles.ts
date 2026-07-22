import { getServerUrl } from "@/lib/api";
import { normalizeServerBaseUrl } from "@/lib/serverUrl";

export type ServerProfileKind = "local" | "nas" | "remote" | "demo";
export type ServerProfileStatus = "unknown" | "checking" | "online" | "offline" | "auth-expired";

export interface ServerProfile {
  id: string;
  name: string;
  serverUrl: string;
  kind: ServerProfileKind;
  username: string;
  userId?: string;
  displayName: string;
  avatarUrl?: string;
  status: ServerProfileStatus;
  serverInstanceId?: string;
  rememberCredential: boolean;
  autoLogin: boolean;
  lastCheckedAt?: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LegacyServerProfileCredential {
  id: string;
  serverUrl: string;
  username: string;
  token: string;
}

const STORAGE_KEY = "nowen-server-profiles-v2";
const ACTIVE_KEY = "nowen-active-server-profile-v2";
const LEGACY_STORAGE_KEY = "nowen-server-profiles-v1";
const LEGACY_ACTIVE_KEY = "nowen-active-server-profile-v1";
const LEGACY_CLOUD_RECORDS_KEY = "nowen-cloud-login-records-v1";
const PROFILE_EVENT = "nowen:server-profiles-changed";
const MAX_PROFILES = 20;

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function normalizeProfileUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return normalizeServerBaseUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
}

export function isLoopbackProfileUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function decodeTokenIdentity(token: string): { username: string; userId?: string } {
  if (!token || token.startsWith("nkn_")) return { username: "" };
  try {
    const part = token.split(".")[1];
    if (!part) return { username: "" };
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { username?: string; userId?: string; sub?: string };
    return {
      username: typeof payload.username === "string" ? payload.username : "",
      userId: typeof payload.userId === "string" ? payload.userId : (typeof payload.sub === "string" ? payload.sub : undefined),
    };
  } catch {
    return { username: "" };
  }
}

export function serverProfileIdentity(serverUrl: string, username: string): string {
  return `${normalizeProfileUrl(serverUrl).toLowerCase()}|${String(username || "").trim().toLowerCase()}`;
}

function sanitizeProfile(value: Partial<ServerProfile> & Record<string, unknown>): ServerProfile | null {
  const serverUrl = normalizeProfileUrl(String(value.serverUrl || ""));
  if (!serverUrl) return null;
  const now = Date.now();
  const legacyToken = typeof value.token === "string" ? value.token : "";
  const tokenIdentity = decodeTokenIdentity(legacyToken);
  const username = String(value.username || tokenIdentity.username || "").trim();
  return {
    id: String(value.id || randomId()),
    name: String(value.name || (isLoopbackProfileUrl(serverUrl) ? "本地服务" : new URL(serverUrl).hostname)).trim().slice(0, 40),
    serverUrl,
    kind: value.kind === "local" || value.kind === "nas" || value.kind === "demo" ? value.kind : (isLoopbackProfileUrl(serverUrl) ? "local" : "remote"),
    username,
    userId: typeof value.userId === "string" && value.userId ? value.userId : tokenIdentity.userId,
    displayName: String(value.displayName || username).trim().slice(0, 80),
    avatarUrl: typeof value.avatarUrl === "string" && value.avatarUrl ? value.avatarUrl : undefined,
    status: value.status === "online" || value.status === "offline" || value.status === "checking" || value.status === "auth-expired"
      ? value.status
      : "unknown",
    serverInstanceId: value.serverInstanceId ? String(value.serverInstanceId) : undefined,
    rememberCredential: value.rememberCredential === true,
    autoLogin: value.autoLogin === true,
    lastCheckedAt: Number.isFinite(value.lastCheckedAt) ? Number(value.lastCheckedAt) : undefined,
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? Number(value.lastUsedAt) : undefined,
    createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : now,
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : now,
  };
}

function writeProfiles(profiles: ServerProfile[]): ServerProfile[] {
  const deduped: ServerProfile[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const normalized = sanitizeProfile(profile as ServerProfile & Record<string, unknown>);
    if (!normalized) continue;
    const identity = serverProfileIdentity(normalized.serverUrl, normalized.username);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(normalized);
    if (deduped.length >= MAX_PROFILES) break;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(deduped));
    window.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: { profiles: deduped } }));
  } catch {
    /* storage can be unavailable in hardened webviews */
  }
  return deduped;
}

function readProfilesFromKey(key: string): ServerProfile[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<ServerProfile> & Record<string, unknown>>;
    return Array.isArray(parsed) ? parsed.map(sanitizeProfile).filter(Boolean) as ServerProfile[] : [];
  } catch {
    return [];
  }
}

function legacyCloudProfiles(): ServerProfile[] {
  const result: ServerProfile[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_CLOUD_RECORDS_KEY);
    const rows = raw ? JSON.parse(raw) as Array<Record<string, unknown>> : [];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const profile = sanitizeProfile({
          id: typeof row.id === "string" ? row.id : undefined,
          name: typeof row.displayName === "string" && row.displayName ? `${row.displayName} · 云端` : "云端服务",
          serverUrl: typeof row.cloudUrl === "string" ? row.cloudUrl : "",
          kind: "remote",
          username: typeof row.username === "string" ? row.username : "",
          displayName: typeof row.displayName === "string" ? row.displayName : "",
          status: "unknown",
          lastUsedAt: typeof row.lastUsedAt === "number" ? row.lastUsedAt : undefined,
          rememberCredential: false,
          autoLogin: false,
        });
        if (profile) result.push(profile);
      }
    }
  } catch {
    /* ignore corrupt legacy records */
  }
  return result;
}

export function bootstrapServerProfiles(): ServerProfile[] {
  const stored = readProfilesFromKey(STORAGE_KEY);
  const legacy = stored.length === 0 ? readProfilesFromKey(LEGACY_STORAGE_KEY) : [];
  const currentUrl = normalizeProfileUrl(getServerUrl() || localStorage.getItem("nowen-server-url-last") || "");
  const currentToken = localStorage.getItem("nowen-token") || "";
  const currentIdentity = decodeTokenIdentity(currentToken);
  const current = currentUrl
    ? sanitizeProfile({
        name: isLoopbackProfileUrl(currentUrl) ? "本地服务" : "当前服务",
        serverUrl: currentUrl,
        kind: isLoopbackProfileUrl(currentUrl) ? "local" : "remote",
        username: currentIdentity.username,
        userId: currentIdentity.userId,
        displayName: currentIdentity.username,
        status: "unknown",
        lastUsedAt: Date.now(),
        rememberCredential: false,
        autoLogin: false,
      })
    : null;

  const profiles = writeProfiles([
    ...(current ? [current] : []),
    ...stored,
    ...legacy,
    ...legacyCloudProfiles(),
  ]);

  const oldActiveId = localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(LEGACY_ACTIVE_KEY) || "";
  const active = profiles.find((profile) => profile.id === oldActiveId)
    || (current ? profiles.find((profile) => serverProfileIdentity(profile.serverUrl, profile.username) === serverProfileIdentity(current.serverUrl, current.username)) : null);
  if (active) {
    try { localStorage.setItem(ACTIVE_KEY, active.id); } catch { /* ignore */ }
  }
  return profiles;
}

export function listServerProfiles(): ServerProfile[] {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return readProfilesFromKey(STORAGE_KEY);
  } catch { /* fall through to bootstrap */ }
  return bootstrapServerProfiles();
}

export function getActiveServerProfile(): ServerProfile | null {
  const profiles = listServerProfiles();
  const activeId = localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(LEGACY_ACTIVE_KEY) || "";
  const byId = profiles.find((profile) => profile.id === activeId);
  if (byId) return byId;
  const currentUrl = normalizeProfileUrl(getServerUrl());
  const identity = decodeTokenIdentity(localStorage.getItem("nowen-token") || "");
  return profiles.find((profile) => serverProfileIdentity(profile.serverUrl, profile.username) === serverProfileIdentity(currentUrl, identity.username))
    || profiles.find((profile) => profile.serverUrl === currentUrl)
    || null;
}

export function upsertServerProfile(input: Partial<ServerProfile> & { serverUrl: string; name: string; token?: unknown; password?: unknown }): ServerProfile {
  const profile = sanitizeProfile(input as Partial<ServerProfile> & Record<string, unknown>);
  if (!profile) throw new Error("服务器地址无效");
  const profiles = listServerProfiles();
  const identity = serverProfileIdentity(profile.serverUrl, profile.username);
  const existing = profiles.find((item) => item.id === profile.id || serverProfileIdentity(item.serverUrl, item.username) === identity);
  const merged = sanitizeProfile({
    ...existing,
    ...profile,
    id: existing?.id || profile.id,
    createdAt: existing?.createdAt || profile.createdAt,
    updatedAt: Date.now(),
  })!;
  writeProfiles([merged, ...profiles.filter((item) => item.id !== merged.id && serverProfileIdentity(item.serverUrl, item.username) !== identity)]);
  return merged;
}

export function removeServerProfile(id: string): ServerProfile[] {
  const activeId = localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(LEGACY_ACTIVE_KEY) || "";
  if (id === activeId) return listServerProfiles();
  const profiles = writeProfiles(listServerProfiles().filter((profile) => profile.id !== id));
  if (localStorage.getItem(ACTIVE_KEY) === id || localStorage.getItem(LEGACY_ACTIVE_KEY) === id) {
    try {
      localStorage.removeItem(ACTIVE_KEY);
      localStorage.removeItem(LEGACY_ACTIVE_KEY);
    } catch { /* ignore */ }
  }
  return profiles;
}

export function markServerProfileActive(id: string): ServerProfile | null {
  const profiles = listServerProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return null;
  const updated = { ...target, lastUsedAt: Date.now(), updatedAt: Date.now() };
  writeProfiles([updated, ...profiles.filter((profile) => profile.id !== id)]);
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
  return updated;
}

export function updateServerProfileStatus(
  id: string,
  patch: Pick<ServerProfile, "status"> & Partial<Pick<ServerProfile, "serverInstanceId" | "username" | "userId" | "displayName" | "avatarUrl">>,
): ServerProfile | null {
  const profiles = listServerProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return null;
  const updated = sanitizeProfile({ ...target, ...patch, lastCheckedAt: Date.now(), updatedAt: Date.now() })!;
  writeProfiles([updated, ...profiles.filter((profile) => profile.id !== id)]);
  return updated;
}

export function updateServerProfileCredentialState(
  id: string,
  patch: Partial<Pick<ServerProfile, "rememberCredential" | "autoLogin" | "status">>,
): ServerProfile | null {
  const profiles = listServerProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return null;
  const updated = sanitizeProfile({ ...target, ...patch, updatedAt: Date.now() })!;
  writeProfiles([updated, ...profiles.filter((profile) => profile.id !== id)]);
  return updated;
}

export function getLegacyServerProfileCredentials(): LegacyServerProfileCredential[] {
  const profiles = listServerProfiles();
  const byIdentity = new Map(profiles.map((profile) => [serverProfileIdentity(profile.serverUrl, profile.username), profile]));
  const result: LegacyServerProfileCredential[] = [];
  const seen = new Set<string>();
  const push = (serverUrl: unknown, username: unknown, token: unknown, id?: unknown) => {
    if (typeof token !== "string" || !token) return;
    const normalizedUrl = normalizeProfileUrl(String(serverUrl || ""));
    const tokenIdentity = decodeTokenIdentity(token);
    const normalizedUsername = String(username || tokenIdentity.username || "").trim();
    if (!normalizedUrl || !normalizedUsername) return;
    const identity = serverProfileIdentity(normalizedUrl, normalizedUsername);
    if (seen.has(identity)) return;
    const profile = (typeof id === "string" ? profiles.find((item) => item.id === id) : null) || byIdentity.get(identity);
    if (!profile) return;
    seen.add(identity);
    result.push({ id: profile.id, serverUrl: normalizedUrl, username: normalizedUsername, token });
  };

  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const rows = raw ? JSON.parse(raw) as Array<Record<string, unknown>> : [];
    if (Array.isArray(rows)) {
      for (const row of rows) push(row.serverUrl, row.username, row.token, row.id);
    }
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(LEGACY_CLOUD_RECORDS_KEY);
    const rows = raw ? JSON.parse(raw) as Array<Record<string, unknown>> : [];
    if (Array.isArray(rows)) {
      for (const row of rows) push(row.cloudUrl, row.username, row.token, row.id);
    }
  } catch { /* ignore */ }

  const currentToken = localStorage.getItem("nowen-token") || "";
  const currentUrl = getServerUrl() || localStorage.getItem("nowen-server-url-last") || "";
  push(currentUrl, decodeTokenIdentity(currentToken).username, currentToken, localStorage.getItem(ACTIVE_KEY) || undefined);
  return result;
}

export function removeLegacyServerProfileStorage(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_CLOUD_RECORDS_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch { /* ignore */ }
}

export function subscribeServerProfiles(listener: () => void): () => void {
  window.addEventListener(PROFILE_EVENT, listener);
  window.addEventListener("nowen:server-url-changed", listener);
  window.addEventListener("nowen:token-changed", listener);
  return () => {
    window.removeEventListener(PROFILE_EVENT, listener);
    window.removeEventListener("nowen:server-url-changed", listener);
    window.removeEventListener("nowen:token-changed", listener);
  };
}

export function profileKindLabel(kind: ServerProfileKind): string {
  if (kind === "local") return "本地";
  if (kind === "nas") return "NAS";
  if (kind === "demo") return "演示";
  return "远程";
}
