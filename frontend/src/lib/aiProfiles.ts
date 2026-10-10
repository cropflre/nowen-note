import { getBaseUrl } from "@/lib/api";

export interface AIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
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
  model: string;
}

export interface AIModelOption {
  id: string;
  name: string;
}

const BASE_PATH = "/user-preferences/ai-profiles";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token") || "";
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${getBaseUrl()}${BASE_PATH}${path}`, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `Request failed: ${response.status}`);
  }
  return body as T;
}

export interface AIProxyStatus {
  enabled: boolean;
  valid: boolean;
  message: string;
}

export const aiProfiles = {
  proxyStatus: async (): Promise<AIProxyStatus> => {
    const token = localStorage.getItem("nowen-token") || "";
    const response = await fetch(`${getBaseUrl()}/ai/proxy-status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as AIProxyStatus;
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
