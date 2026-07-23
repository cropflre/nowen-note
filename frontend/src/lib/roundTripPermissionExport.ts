import { getBaseUrl } from "./api";

function readToken(): string | null {
  try {
    return localStorage.getItem("nowen-token");
  } catch {
    return null;
  }
}

function decodeFilename(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8?.[1]) return decodeFilename(utf8[1].trim().replace(/^"|"$/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1] ? decodeFilename(plain[1].trim()) : null;
}

export interface RoundTripPermissionPackageDownloadOptions {
  workspaceId: string;
  includePermissions?: boolean;
}

export async function downloadRoundTripPermissionPackage(
  options: RoundTripPermissionPackageDownloadOptions,
): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams();
  if (options.workspaceId && options.workspaceId !== "personal") {
    params.set("workspaceId", options.workspaceId);
  }
  if (options.includePermissions) params.set("includePermissions", "true");

  const token = readToken();
  const response = await fetch(`${getBaseUrl()}/settings/import-batches/package?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get("Content-Disposition"))
      || `nowen-note-${new Date().toISOString().slice(0, 10)}.nowen.zip`,
  };
}
