import { api, getBaseUrl, getCurrentWorkspace } from "./api";

export interface RoundTripPermissionExportRequest {
  id: number;
  workspaceId: string;
}

type Listener = (requests: RoundTripPermissionExportRequest[]) => void;

let sequence = 1;
let requests: RoundTripPermissionExportRequest[] = [];
const listeners = new Set<Listener>();
const resolvers = new Map<number, (includePermissions: boolean) => void>();
let installed = false;

function emit(): void {
  const snapshot = requests.slice();
  for (const listener of listeners) listener(snapshot);
}

function readToken(): string | null {
  try { return localStorage.getItem("nowen-token"); }
  catch { return null; }
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

export async function downloadRoundTripPermissionPackage(options: {
  workspaceId?: string;
  includePermissions?: boolean;
}): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams();
  if (options.workspaceId && options.workspaceId !== "personal") params.set("workspaceId", options.workspaceId);
  if (options.includePermissions) params.set("includePermissions", "true");
  const token = readToken();
  const response = await fetch(`${getBaseUrl()}/settings/import-batches/package?${params.toString()}`, {
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

export function requestRoundTripPermissionExport(workspaceId: string): Promise<boolean> {
  const id = sequence++;
  requests = [...requests, { id, workspaceId }];
  emit();
  return new Promise((resolve) => resolvers.set(id, resolve));
}

export function resolveRoundTripPermissionExport(id: number, includePermissions: boolean): void {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  requests = requests.filter((request) => request.id !== id);
  emit();
  resolve?.(includePermissions);
}

export function subscribeRoundTripPermissionExports(listener: Listener): () => void {
  listeners.add(listener);
  listener(requests.slice());
  return () => listeners.delete(listener);
}

export function installRoundTripPermissionExportBridge(): void {
  if (installed) return;
  installed = true;
  const nativeDownload = api.downloadNowenPackage.bind(api);
  api.downloadNowenPackage = (async (...args: any[]) => {
    const workspace = getCurrentWorkspace();
    if (!workspace || workspace === "personal") {
      try { return await downloadRoundTripPermissionPackage({}); }
      catch { return nativeDownload(...args); }
    }
    const includePermissions = await requestRoundTripPermissionExport(workspace);
    return downloadRoundTripPermissionPackage({ workspaceId: workspace, includePermissions });
  }) as typeof api.downloadNowenPackage;
}

export const roundTripPermissionExportTestUtils = {
  reset(): void {
    for (const resolve of resolvers.values()) resolve(false);
    resolvers.clear();
    requests = [];
    sequence = 1;
    emit();
  },
};
