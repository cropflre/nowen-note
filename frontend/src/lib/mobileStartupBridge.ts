import { isAndroidNativeRuntime } from "./androidNativeHttpBridge";

const INSTALL_FLAG = "__nowenMobileStartupBridgeInstalled";
const STARTUP_CACHE_MS = 20_000;
const SHARE_STATUS_CACHE_MS = 5 * 60_000;
const FAILURE_COOLDOWN_MS = 8_000;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchFn = typeof fetch;

type BootstrapTarget =
  | "notes"
  | "notebooks"
  | "tags"
  | "shared-note-ids"
  | "shared-notebooks"
  | "preferences";

export interface MobileBootstrapNote {
  id: string;
  notebookId: string;
  workspaceId?: string | null;
  title?: string;
  contentText?: string;
  contentLength?: number;
  isPinned?: number;
  isFavorite?: number;
  isTrashed?: number;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface MobileBootstrapNotebook {
  id: string;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface MobileBootstrapPayload {
  schemaVersion: number;
  workspaceId: string;
  generatedAt: number;
  notes: MobileBootstrapNote[];
  notebooks: MobileBootstrapNotebook[];
  tags: unknown[];
  sharedNoteIds: string[];
  sharedNotebooks: unknown[];
  preferences: Record<string, unknown>;
}

interface BootstrapCacheEntry {
  payload?: MobileBootstrapPayload;
  promise?: Promise<MobileBootstrapPayload>;
  startupExpiresAt: number;
  shareExpiresAt: number;
  failedUntil: number;
}

const bootstrapCache = new Map<string, BootstrapCacheEntry>();

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function getRequestUrl(input: FetchInput): string {
  return isRequest(input) ? input.url : String(input);
}

function getRequestMethod(input: FetchInput, init?: FetchInit): string {
  return (init?.method || (isRequest(input) ? input.method : "GET") || "GET").toUpperCase();
}

function mergeHeaders(input: FetchInput, init?: FetchInit): Headers {
  const result = new Headers(isRequest(input) ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => result.set(key, value));
  }
  return result;
}

function apiPrefix(url: URL): string | null {
  const match = url.pathname.match(/\/(?:api|publicapi)(?:\/|$)/);
  if (!match || match.index === undefined) return null;
  return url.pathname.slice(0, match.index + match[0].replace(/\/$/, "").length);
}

function apiRelativePath(url: URL): string | null {
  const prefix = apiPrefix(url);
  if (!prefix) return null;
  return url.pathname.slice(prefix.length) || "/";
}

function cacheKey(url: URL, workspaceId: string): string | null {
  const prefix = apiPrefix(url);
  if (!prefix) return null;
  return `${url.origin}${prefix}|${workspaceId}`;
}

function requestedWorkspace(url: URL): string {
  return url.searchParams.get("workspaceId") || "personal";
}

function hasOnlySearchParams(url: URL, allowed: Set<string>): boolean {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

export function classifyMobileBootstrapTarget(
  url: URL,
  method = "GET",
): BootstrapTarget | null {
  if (method.toUpperCase() !== "GET") return null;
  const path = apiRelativePath(url);
  if (!path) return null;

  if (path === "/notes") {
    const allowed = new Set([
      "workspaceId",
      "sortBy",
      "sortOrder",
      "notebookId",
      "isFavorite",
      "isTrashed",
      "dateFrom",
      "dateTo",
    ]);
    if (!hasOnlySearchParams(url, allowed)) return null;
    if (url.searchParams.get("isTrashed") === "1") return null;
    return "notes";
  }
  if (path === "/notebooks") {
    return hasOnlySearchParams(url, new Set(["workspaceId"])) ? "notebooks" : null;
  }
  if (path === "/tags") {
    return hasOnlySearchParams(url, new Set(["workspaceId"])) ? "tags" : null;
  }
  if (path === "/shares/status/batch" && url.search === "") return "shared-note-ids";
  if (path === "/notebooks/shared-with-me" && url.search === "") return "shared-notebooks";
  if (path === "/user-preferences" && url.search === "") return "preferences";
  return null;
}

function collectNotebookIds(notebooks: MobileBootstrapNotebook[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const notebook of notebooks) {
    const parent = notebook.parentId || "";
    const list = children.get(parent) || [];
    list.push(notebook.id);
    children.set(parent, list);
  }

  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const child of children.get(current) || []) stack.push(child);
  }
  return result;
}

function compareText(a: unknown, b: unknown): number {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
}

export function selectNotesFromBootstrap(
  payload: MobileBootstrapPayload,
  url: URL,
): MobileBootstrapNote[] | null {
  if (requestedWorkspace(url) !== payload.workspaceId) return null;
  if (url.searchParams.get("isTrashed") === "1") return null;

  let notes = payload.notes.slice();
  const notebookId = url.searchParams.get("notebookId");
  if (notebookId) {
    const allowedNotebookIds = collectNotebookIds(payload.notebooks, notebookId);
    notes = notes.filter((note) => allowedNotebookIds.has(note.notebookId));
  }
  if (url.searchParams.get("isFavorite") === "1") {
    notes = notes.filter((note) => Number(note.isFavorite) === 1);
  }

  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  if (dateFrom) notes = notes.filter((note) => String(note.updatedAt || "").slice(0, 10) >= dateFrom);
  if (dateTo) notes = notes.filter((note) => String(note.updatedAt || "").slice(0, 10) <= dateTo);

  const sortBy = url.searchParams.get("sortBy") || "manual";
  const direction = url.searchParams.get("sortOrder") === "asc" ? 1 : -1;
  notes.sort((a, b) => {
    const pinned = Number(b.isPinned || 0) - Number(a.isPinned || 0);
    if (pinned !== 0) return pinned;

    if (sortBy === "title") {
      return compareText(a.title, b.title) * direction || String(a.id).localeCompare(String(b.id));
    }
    if (sortBy === "updatedAt" || sortBy === "createdAt") {
      const left = String(a[sortBy] || "");
      const right = String(b[sortBy] || "");
      return (left < right ? -1 : left > right ? 1 : 0) * direction
        || String(a.id).localeCompare(String(b.id));
    }

    const manual = Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
    if (manual !== 0) return manual;
    const updated = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    return updated || String(a.id).localeCompare(String(b.id));
  });
  return notes;
}

function responseFromJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Nowen-Mobile-Bootstrap": "hit",
    },
  });
}

function bootstrapUrlFor(targetUrl: URL, workspaceId: string): URL | null {
  const prefix = apiPrefix(targetUrl);
  if (!prefix) return null;
  const url = new URL(targetUrl.toString());
  url.pathname = `${prefix}/user-preferences/mobile-bootstrap`;
  url.search = "";
  url.searchParams.set("workspaceId", workspaceId);
  return url;
}

async function loadBootstrap(
  originalFetch: FetchFn,
  input: FetchInput,
  init: FetchInit | undefined,
  targetUrl: URL,
  workspaceId: string,
): Promise<MobileBootstrapPayload> {
  const url = bootstrapUrlFor(targetUrl, workspaceId);
  if (!url) throw new Error("Invalid Nowen API URL");

  const response = await originalFetch(url.toString(), {
    method: "GET",
    headers: mergeHeaders(input, init),
    credentials: init?.credentials || (isRequest(input) ? input.credentials : undefined),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Mobile bootstrap failed: HTTP ${response.status}`);
  const payload = await response.json() as MobileBootstrapPayload;
  if (
    payload?.schemaVersion !== 1 ||
    !Array.isArray(payload.notes) ||
    !Array.isArray(payload.notebooks) ||
    !Array.isArray(payload.tags)
  ) {
    throw new Error("Mobile bootstrap returned an invalid payload");
  }
  return payload;
}

async function getBootstrap(
  originalFetch: FetchFn,
  input: FetchInput,
  init: FetchInit | undefined,
  url: URL,
  target: BootstrapTarget,
): Promise<MobileBootstrapPayload | null> {
  const workspaceId = target === "shared-note-ids" || target === "shared-notebooks" || target === "preferences"
    ? "personal"
    : requestedWorkspace(url);
  const key = cacheKey(url, workspaceId);
  if (!key) return null;

  const now = Date.now();
  let entry = bootstrapCache.get(key);
  if (entry?.payload) {
    const valid = target === "shared-note-ids"
      ? now < entry.shareExpiresAt
      : now < entry.startupExpiresAt;
    if (valid) return entry.payload;
    return null;
  }
  if (entry?.failedUntil && now < entry.failedUntil) return null;
  if (entry?.promise) return entry.promise.catch(() => null);

  entry = {
    startupExpiresAt: 0,
    shareExpiresAt: 0,
    failedUntil: 0,
  };
  bootstrapCache.set(key, entry);
  entry.promise = loadBootstrap(originalFetch, input, init, url, workspaceId)
    .then((payload) => {
      entry!.payload = payload;
      entry!.startupExpiresAt = Date.now() + STARTUP_CACHE_MS;
      entry!.shareExpiresAt = Date.now() + SHARE_STATUS_CACHE_MS;
      entry!.failedUntil = 0;
      return payload;
    })
    .catch((error) => {
      entry!.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
      console.warn("[mobile-startup] compact bootstrap unavailable; using normal APIs", error);
      throw error;
    })
    .finally(() => {
      entry!.promise = undefined;
    });
  return entry.promise.catch(() => null);
}

function dataForTarget(
  payload: MobileBootstrapPayload,
  target: BootstrapTarget,
  url: URL,
): unknown | null {
  if (target === "notes") return selectNotesFromBootstrap(payload, url);
  if (target === "notebooks") {
    return requestedWorkspace(url) === payload.workspaceId ? payload.notebooks : null;
  }
  if (target === "tags") {
    return requestedWorkspace(url) === payload.workspaceId ? payload.tags : null;
  }
  if (target === "shared-note-ids") return payload.sharedNoteIds;
  if (target === "shared-notebooks") return payload.sharedNotebooks;
  if (target === "preferences") return payload.preferences;
  return null;
}

function invalidatesBootstrap(url: URL, method: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const path = apiRelativePath(url) || "";
  return path === "/user-preferences" ||
    path.startsWith("/notes") ||
    path.startsWith("/notebooks") ||
    path.startsWith("/tags") ||
    path.startsWith("/shares");
}

export function clearMobileStartupCache(): void {
  bootstrapCache.clear();
}

/**
 * Android cold-start request coalescer.
 *
 * Web/Electron are deliberately untouched. On Android, the duplicate collection reads
 * issued by App sync, NoteList and Sidebar share one compact server snapshot. Unsupported
 * filters and any bootstrap failure transparently fall through to the original API call.
 */
export function installMobileStartupBridge(): (() => void) | null {
  if (typeof window === "undefined" || !isAndroidNativeRuntime()) return null;
  const runtime = window as typeof window & Record<string, unknown>;
  if (runtime[INSTALL_FLAG]) return null;

  const originalFetch: FetchFn = window.fetch.bind(window);
  const bridgedFetch: FetchFn = async (input, init) => {
    const method = getRequestMethod(input, init);
    let url: URL;
    try {
      url = new URL(getRequestUrl(input), window.location.href);
    } catch {
      return originalFetch(input, init);
    }

    if (invalidatesBootstrap(url, method)) clearMobileStartupCache();
    const target = classifyMobileBootstrapTarget(url, method);
    if (!target) return originalFetch(input, init);

    const payload = await getBootstrap(originalFetch, input, init, url, target);
    if (!payload) return originalFetch(input, init);
    const data = dataForTarget(payload, target, url);
    return data === null ? originalFetch(input, init) : responseFromJson(data);
  };

  runtime[INSTALL_FLAG] = true;
  window.fetch = bridgedFetch;

  return () => {
    if (window.fetch === bridgedFetch) window.fetch = originalFetch;
    delete runtime[INSTALL_FLAG];
    clearMobileStartupCache();
  };
}
