import { getBaseUrl } from "./api";

export type WorkspacePermissionRole = "owner" | "admin" | "editor" | "viewer";

export interface RoundTripPermissionMember {
  sourceUserId: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: WorkspacePermissionRole;
}

export interface RoundTripPermissionsManifest {
  format: "nowen-workspace-permissions";
  version: 1;
  exportedAt: string;
  sourceWorkspace: { id: string; name: string };
  members: RoundTripPermissionMember[];
}

export interface PermissionMappingSuggestion {
  sourceUserId: string;
  username: string;
  email: string | null;
  sourceRole: WorkspacePermissionRole;
  suggestedTargetUserId: string | null;
  suggestedTargetUsername: string | null;
  match: "email" | "username" | "none" | "ambiguous";
  appliedRole: "admin" | "editor" | "viewer";
  warning?: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("nowen-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`) as Error & { code?: string; status?: number };
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function downloadNowenPackageWithPermissions(workspaceId: string): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams({ workspaceId });
  const response = await fetch(`${getBaseUrl()}/settings/roundtrip-permissions/package?${params}`, {
    credentials: "include",
    headers: authHeaders(),
  });
  if (!response.ok) await parseResponse(response);
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = /filename="([^"]+)"/.exec(disposition)?.[1] || "nowen-workspace-with-permissions.zip";
  let filename = encoded;
  try { filename = decodeURIComponent(encoded); } catch { /* keep encoded fallback */ }
  return { blob: await response.blob(), filename };
}

export async function previewPermissionManifest(
  workspaceId: string,
  manifest: RoundTripPermissionsManifest,
): Promise<PermissionMappingSuggestion[]> {
  const response = await fetch(`${getBaseUrl()}/settings/roundtrip-permissions/preview`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ workspaceId, manifest }),
  });
  const payload = await parseResponse<{ success: boolean; suggestions: PermissionMappingSuggestion[] }>(response);
  return payload.suggestions || [];
}

export async function previewPermissionPackage(
  workspaceId: string,
  file: File,
): Promise<{ included: boolean; manifest?: RoundTripPermissionsManifest; suggestions: PermissionMappingSuggestion[] }> {
  const form = new FormData();
  form.set("workspaceId", workspaceId);
  form.set("file", file);
  const response = await fetch(`${getBaseUrl()}/settings/roundtrip-permissions/preview-package`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: form,
  });
  return parseResponse(response);
}

export async function applyPermissionMappings(options: {
  workspaceId: string;
  manifest: RoundTripPermissionsManifest;
  mappings: Array<{ sourceUserId: string; targetUserId: string; role?: "admin" | "editor" | "viewer" }>;
}): Promise<{ applied: number; skipped: number }> {
  const response = await fetch(`${getBaseUrl()}/settings/roundtrip-permissions/apply`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(options),
  });
  return parseResponse(response);
}
