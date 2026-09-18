import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export type PluginStudioProjectStatus = "draft" | "ready" | "archived";
export type PluginStudioFileEncoding = "utf8" | "base64";

export interface PluginStudioProject {
  id: string;
  ownerUserId: string;
  name: string;
  slug: string;
  status: PluginStudioProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginStudioProjectFile {
  path: string;
  size: number;
  mimeType: string;
  encoding: PluginStudioFileEncoding;
}

export interface PluginStudioFileContent extends PluginStudioProjectFile {
  content: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
  }, getBaseUrl());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {
      code: payload.code,
      status: response.status,
    });
  }
  return payload as T;
}

export const pluginStudioApi = {
  listProjects: () => request<PluginStudioProject[]>("/plugins/studio/projects"),
  createProject: (name: string) => request<{ success: true; project: PluginStudioProject }>(
    "/plugins/studio/projects",
    { method: "POST", body: JSON.stringify({ name }) },
  ),
  importProject: (file: File, name?: string) => {
    const body = new FormData();
    body.append("file", file);
    if (name) body.append("name", name);
    return request<{ success: true; project: PluginStudioProject }>(
      "/plugins/studio/projects/import",
      { method: "POST", body },
    );
  },
  getProject: (projectId: string) => request<PluginStudioProject>(
    `/plugins/studio/projects/${encodeURIComponent(projectId)}`,
  ),
  updateProject: (
    projectId: string,
    input: { name?: string; status?: PluginStudioProjectStatus; expectedRevision: number },
  ) => request<{ success: true; project: PluginStudioProject }>(
    `/plugins/studio/projects/${encodeURIComponent(projectId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  exportProject: async (projectId: string): Promise<Blob> => {
    const token = getAccessToken();
    const response = await fetchWithAuthRefresh(
      `${getBaseUrl()}/plugins/studio/projects/${encodeURIComponent(projectId)}/export`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      getBaseUrl(),
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {
        code: payload.code,
        status: response.status,
      });
    }
    return response.blob();
  },
  listFiles: (projectId: string) => request<PluginStudioProjectFile[]>(
    `/plugins/studio/projects/${encodeURIComponent(projectId)}/files`,
  ),
  readFile: (projectId: string, path: string) => request<PluginStudioFileContent>(
    `/plugins/studio/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`,
  ),
  writeFile: (
    projectId: string,
    input: { path: string; content: string; encoding?: PluginStudioFileEncoding; expectedRevision: number },
  ) => request<{ success: true; project: PluginStudioProject; file: PluginStudioFileContent }>(
    `/plugins/studio/projects/${encodeURIComponent(projectId)}/files/content`,
    { method: "PUT", body: JSON.stringify(input) },
  ),
};
