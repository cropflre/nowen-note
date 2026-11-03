import { getBaseUrl } from "@/lib/api";
import { fetchWithAuthRefresh } from "@/lib/authSession";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { isMobileLocalMode, MobileLocalModeRemoteRequestError } from "@/lib/mobileLocalMode";

export interface AIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  customHeaders?: Record<string, string>;
  apiKeySet: boolean;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIProfileDraft {
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  customHeaders?: Record<string, string>;
  model: string;
}

export interface AIModelOption {
  id: string;
  name: string;
}

const BASE_PATH = "/user-preferences/ai-profiles";

export interface AIProfileSelection { scope: "personal" | "shared"; id: string }
export interface SharedAIProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface ManagedSharedAIProfile extends AIProfile {
  enabled: boolean;
  revision: number;
  memberIds: string[];
}
export interface SharedAIProfileDraft extends AIProfileDraft {
  enabled: boolean;
  memberIds: string[];
  revision?: number;
}
export interface AIProfileMember { id: string; username: string; displayName?: string | null; isDisabled?: boolean | number }
export interface AvailableAIProfiles {
  personalProfiles: AIProfile[];
  sharedProfiles: SharedAIProfile[];
  active: AIProfileSelection;
  unavailable: boolean;
  sharedSupported: boolean;
  isAdmin: boolean;
  aiEnabled: boolean;
  remoteError?: string;
}

export function getAIProfilesScope(): string {
  return `${getBaseUrl()}\n${getOfflineQueueStorageKey()}`;
}

async function request<T>(path: string, init?: RequestInit, basePath = BASE_PATH): Promise<T> {
  if (isMobileLocalMode()) throw new MobileLocalModeRemoteRequestError(path);
  const baseUrl = getBaseUrl();
  const scope = getAIProfilesScope();
  const token = localStorage.getItem("nowen-token") || "";
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetchWithAuthRefresh(`${baseUrl}${basePath}${path}`, {
    ...init,
    headers,
  }, baseUrl);
  const body = await response.json().catch(() => null);
  if (scope !== getAIProfilesScope()) throw new Error("AI profile session changed");
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || `Request failed: ${response.status}`), { status: response.status, code: body?.code });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid AI profile response");
  return body as T;
}

export interface AIProxyStatus {
  enabled: boolean;
  valid: boolean;
  message: string;
}

export const aiProfiles = {
  proxyStatus: () => request<AIProxyStatus>("/proxy-status", undefined, "/ai"),
  available: async (): Promise<AvailableAIProfiles> => {
    try {
      const result = await request<AvailableAIProfiles>("/profiles/available", undefined, "/ai");
      if (!Array.isArray(result.personalProfiles) || !Array.isArray(result.sharedProfiles) || !result.active || !["personal", "shared"].includes(result.active.scope)) throw new Error("Invalid AI profile directory");
      return result;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      const personal = await aiProfiles.list();
      return { personalProfiles: personal.profiles, sharedProfiles: [], active: { scope: "personal", id: personal.activeProfileId }, unavailable: false, sharedSupported: false, isAdmin: false, aiEnabled: true };
    }
  },
  activateSelection: (active: AIProfileSelection) =>
    request<{ active: AIProfileSelection }>("/profiles/active", { method: "PUT", body: JSON.stringify(active) }, "/ai"),
  shared: {
    list: () => request<{ profiles: ManagedSharedAIProfile[]; members: AIProfileMember[] }>("/shared-profiles", undefined, "/ai"),
    create: (draft: SharedAIProfileDraft | { sourceProfileId: string; enabled: boolean; memberIds: string[] }) =>
      request<{ profile: ManagedSharedAIProfile }>("/shared-profiles", { method: "POST", body: JSON.stringify(draft) }, "/ai"),
    update: (id: string, draft: SharedAIProfileDraft) =>
      request<{ profile: ManagedSharedAIProfile }>(`/shared-profiles/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(draft) }, "/ai"),
    remove: (id: string, revision: number) =>
      request<{ success: true }>(`/shared-profiles/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) }, "/ai"),
    test: (id: string) =>
      request<{ success: boolean; message?: string; error?: string }>(`/shared-profiles/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" }, "/ai"),
  },
  list: () => request<{ profiles: AIProfile[]; activeProfileId: string }>(""),

  create: (draft: AIProfileDraft, activate = true) =>
    request<{ profile: AIProfile; activeProfileId: string }>("", {
      method: "POST",
      body: JSON.stringify({ ...draft, activate }),
    }),

  update: (profileId: string, draft: AIProfileDraft) =>
    request<{ profile: AIProfile; activeProfileId: string }>(`/${encodeURIComponent(profileId)}`, {
      method: "PUT",
      body: JSON.stringify(draft),
    }),

  remove: (profileId: string) =>
    request<{ success: true; activeProfileId: string }>(`/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    }),

  activate: (profileId: string) =>
    request<{ profile: AIProfile; activeProfileId: string }>(`/${encodeURIComponent(profileId)}/activate`, {
      method: "PUT",
    }),

  test: (profileId: string) =>
    request<{ success: boolean; message?: string; error?: string; code?: string; preview?: string }>(
      `/${encodeURIComponent(profileId)}/test`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),

  /** Test a draft without saving or activating a profile. */
  testDraft: (draft: AIProfileDraft, profileId?: string) =>
    request<{ success: boolean; message?: string; error?: string; code?: string; preview?: string }>(
      "/test-draft",
      {
        method: "POST",
        body: JSON.stringify({ ...draft, ...(profileId ? { profileId } : {}) }),
      },
    ),

  discoverModels: (draft: AIProfileDraft, profileId?: string) =>
    request<{ models: AIModelOption[]; source?: string; filteredNonChatCount?: number }>("/discover-models", {
      method: "POST",
      body: JSON.stringify({ ...draft, profileId }),
    }),
};

export function emitAIProfilesChanged(activeProfileId?: string): void {
  window.dispatchEvent(new CustomEvent("nowen:ai-profiles-changed", {
    detail: { activeProfileId: activeProfileId || null },
  }));
}
