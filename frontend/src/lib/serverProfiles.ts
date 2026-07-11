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
  displayName: string;
  token: string;
  status: ServerProfileStatus;
  serverInstanceId?: string;
  lastCheckedAt?: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "nowen-server-profiles-v1";
const ACTIVE_KEY = "nowen-active-server-profile-v1";
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

function decodeTokenUsername(token: string): string {
  if (!token || token.startsWith("nkn_")) return "";
  try {
    const part = token.split(".")[1];
    if (!part) return "";
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { username?: string };
    return typeof payload.username === "string" ? payload.username : "";
  } catch {
    return "";
  }
}

function profileIdentity(serverUrl: string, username: string): string {
  return `${normalizeProfileUrl(serverUrl).toLowerCase()}|${String(username || "").trim().toLowerCase()}`;
}

function sanitizeProfile(value: Partial<ServerProfile>): ServerProfile | null {
  const serverUrl = normalizeProfileUrl(value.serverUrl || "");
  if (!serverUrl) return null;
  const now = Date.now();
  const username = String(value.username || decodeTokenUsername(value.token || "")).trim();
  return {
    id: String(value.id || randomId()),
    name: String(value.name || (isLoopbackProfileUrl(serverUrl) ? "本地服务" : new URL(serverUrl).hostname)).trim().slice(0, 40),
    serverUrl,
    kind: value.kind === "local" || value.kind === "nas" || value.kind === "demo" ? value.kind : (isLoopbackProfileUrl(serverUrl) ? "local" : "remote"),
    username,
    displayName: String(value.displayName || username).trim().slice(0, 80),
    token: String(value.token || ""),
    status: value.status === "online" || value.status === "offline" || value.status === "checking" || value.status === "auth-expired"
      ? value.status
      : "unknown",
    serverInstanceId: value.serverInstanceId ? String(value.serverInstanceId) : undefined,
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
    const normalized = sanitizeProfile(profile);
    if (!normalized) continue;
    const identity = profileIdentity(normalized.serverUrl, normalized.username);
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

function readStoredProfiles(): ServerProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<ServerProfile>[];
    return Array.isArray(parsed) ? parsed.map(sanitizeProfile).filter(Boolean) as ServerProfile[] : [];
  } catch {
    return [];
  }
}

function legacyProfiles(): ServerProfile[] {
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
          token: typeof row.token === "string" ? row.token : "",
          status: "unknown",
          lastUsedAt: typeof row.lastUsedAt === "number" ? row.lastUsedAt : undefined,
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
  const stored = readStoredProfiles();
  const currentUrl = normalizeProfileUrl(getServerUrl() || localStorage.getItem("nowen-server-url-last") || "");
  const currentToken = localStorage.getItem("nowen-token") || "";
  const currentUsername = decodeTokenUsername(currentToken);
  const current = currentUrl
    ? sanitizeProfile({
        name: isLoopbackProfileUrl(currentUrl) ? "本地服务" : "当前服务",
        serverUrl: currentUrl,
        kind: isLoopbackProfileUrl(currentUrl) ? "local" : "remote",
        username: currentUsername,
        displayName: currentUsername,
        token: currentToken,
        status: "unknown",
        lastUsedAt: Date.now(),
      })
    : null;

  const profiles = writeProfiles([
    ...(current ? [current] : []),
    ...stored,
    ...legacyProfiles(),
  ]);

  if (current) {
    const active = profiles.find((profile) => profileIdentity(profile.serverUrl, profile.username) === profileIdentity(current.serverUrl, current.username));
    if (active) {
      try { localStorage.setItem(ACTIVE_KEY, active.id); } catch { /* ignore */ }
    }
  }
  return profiles;
}

export function listServerProfiles(): ServerProfile[] {
  const profiles = readStoredProfiles();
  return profiles.length ? profiles : bootstrapServerProfiles();
}

export function getActiveServerProfile(): ServerProfile | null {
  const profiles = listServerProfiles();
  const activeId = localStorage.getItem(ACTIVE_KEY) || "";
  const byId = profiles.find((profile) => profile.id === activeId);
  if (byId) return byId;
  const currentUrl = normalizeProfileUrl(getServerUrl());
  const token = localStorage.getItem("nowen-token") || "";
  const username = decodeTokenUsername(token);
  return profiles.find((profile) => profileIdentity(profile.serverUrl, profile.username) === profileIdentity(currentUrl, username))
    || profiles.find((profile) => profile.serverUrl === currentUrl)
    || null;
}

export function upsertServerProfile(input: Partial<ServerProfile> & { serverUrl: string; name: string }): ServerProfile {
  const profile = sanitizeProfile(input);
  if (!profile) throw new Error("服务器地址无效");
  const profiles = listServerProfiles();
  const identity = profileIdentity(profile.serverUrl, profile.username);
  const existing = profiles.find((item) => item.id === profile.id || profileIdentity(item.serverUrl, item.username) === identity);
  const merged = sanitizeProfile({
    ...existing,
    ...profile,
    id: existing?.id || profile.id,
    createdAt: existing?.createdAt || profile.createdAt,
    updatedAt: Date.now(),
  })!;
  writeProfiles([merged, ...profiles.filter((item) => item.id !== merged.id && profileIdentity(item.serverUrl, item.username) !== identity)]);
  return merged;
}

export function removeServerProfile(id: string): ServerProfile[] {
  const profiles = writeProfiles(listServerProfiles().filter((profile) => profile.id !== id));
  if (localStorage.getItem(ACTIVE_KEY) === id) {
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
  }
  return profiles;
}

export function markServerProfileActive(id: string): ServerProfile | null {
  const profiles = listServerProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return null;
  target.lastUsedAt = Date.now();
  target.updatedAt = Date.now();
  writeProfiles([target, ...profiles.filter((profile) => profile.id !== id)]);
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
  return target;
}

export function updateServerProfileStatus(
  id: string,
  patch: Pick<ServerProfile, "status"> & Partial<Pick<ServerProfile, "serverInstanceId" | "username" | "displayName" | "token">>,
): ServerProfile | null {
  const profiles = listServerProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return null;
  const updated = sanitizeProfile({ ...target, ...patch, lastCheckedAt: Date.now(), updatedAt: Date.now() })!;
  writeProfiles([updated, ...profiles.filter((profile) => profile.id !== id)]);
  return updated;
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
