import { isAndroidNativeRuntime } from "./androidNativeHttpBridge";
import {
  classifyMobileBootstrapTarget,
  selectNotesFromBootstrap,
  type MobileBootstrapPayload,
} from "./mobileStartupBridge";

const INSTALL_FLAG = "__nowenMobileWebStartupBridgeInstalled";
const STARTUP_CACHE_MS = 20_000;
const SHARE_STATUS_CACHE_MS = 5 * 60_000;
const FAILURE_COOLDOWN_MS = 8_000;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchFn = typeof fetch;
type BootstrapTarget = NonNullable<ReturnType<typeof classifyMobileBootstrapTarget>>;

interface BootstrapCacheEntry {
  payload?: MobileBootstrapPayload;
  promise?: Promise<MobileBootstrapPayload>;
  startupExpiresAt: number;
  shareExpiresAt: number;
  failedUntil: number;
}

export interface MobileWebRuntimeHints {
  nativeAndroid?: boolean;
  userAgent?: string;
  userAgentDataMobile?: boolean;
  maxTouchPoints?: number;
  coarsePointer?: boolean;
  narrowViewport?: boolean;
  standalone?: boolean;
}

export interface MobileWebStartupBridgeOptions {
  /** Test/diagnostic override. Production callers should leave this false. */
  force?: boolean;
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
  const marker = "/api/";
  const index = url.pathname.lastIndexOf(marker);
  if (index < 0) return null;
  return url.pathname.slice(0, index + marker.length - 1);
}

function apiRelativePath(url: URL): string | null {
  const prefix = apiPrefix(url);
  if (!prefix) return null;
  return url.pathname.slice(prefix.length) || "/";
}

function requestedWorkspace(url: URL): string {
  return url.searchParams.get("workspaceId") || "personal";
}

function cacheKey(url: URL, workspaceId: string): string | null {
  const prefix = apiPrefix(url);
  if (!prefix) return null;
  return `${url.origin}${prefix}|${workspaceId}`;
}

function responseFromJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Nowen-Mobile-Bootstrap": "web-hit",
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
  if (!response.ok) throw new Error(`Mobile web bootstrap failed: HTTP ${response.status}`);

  const payload = await response.json() as MobileBootstrapPayload;
  if (
    payload?.schemaVersion !== 1 ||
    !Array.isArray(payload.notes) ||
    !Array.isArray(payload.notebooks) ||
    !Array.isArray(payload.tags) ||
    !Array.isArray(payload.sharedNoteIds) ||
    !Array.isArray(payload.sharedNotebooks) ||
    !payload.preferences ||
    typeof payload.preferences !== "object"
  ) {
    throw new Error("Mobile web bootstrap returned an invalid payload");
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
      console.warn("[mobile-web-startup] compact bootstrap unavailable; using normal APIs", error);
      throw error;
    })
    .finally(() => {
      entry!.promise = undefined;
    });
  return entry.promise.catch(() => null);
}

export function shouldEnableMobileWebStartup(hints: MobileWebRuntimeHints): boolean {
  if (hints.nativeAndroid) return false;
  const userAgent = hints.userAgent || "";
  const mobileUserAgent = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(userAgent);
  const touchViewport = Number(hints.maxTouchPoints || 0) > 0 &&
    hints.coarsePointer === true &&
    hints.narrowViewport === true;
  return hints.userAgentDataMobile === true || mobileUserAgent || hints.standalone === true || touchViewport;
}

export function isMobileWebStartupRuntime(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
    standalone?: boolean;
  };
  const match = (query: string): boolean => {
    try { return window.matchMedia?.(query).matches === true; } catch { return false; }
  };

  return shouldEnableMobileWebStartup({
    nativeAndroid: isAndroidNativeRuntime(),
    userAgent: nav.userAgent,
    userAgentDataMobile: nav.userAgentData?.mobile === true,
    maxTouchPoints: nav.maxTouchPoints || 0,
    coarsePointer: match("(pointer: coarse)"),
    narrowViewport: match("(max-width: 900px)") || window.innerWidth <= 900,
    standalone: nav.standalone === true || match("(display-mode: standalone)"),
  });
}

export function clearMobileWebStartupCache(): void {
  bootstrapCache.clear();
}

/**
 * Mobile browser/PWA/remote-WebView startup request coalescer.
 *
 * The first implementation intentionally covered only native Android. Field logs from
 * phones loading the NAS-hosted web bundle showed the same duplicated reads but no
 * `/mobile-bootstrap` request, proving that mobile Web/PWA runtimes bypassed that guard.
 * This bridge gives those runtimes the same compact snapshot without changing desktop
 * Web or Electron behavior. Failure remains transparent and falls back to normal APIs.
 */
export function installMobileWebStartupBridge(
  options: MobileWebStartupBridgeOptions = {},
): (() => void) | null {
  if (typeof window === "undefined") return null;
  if (!options.force && !isMobileWebStartupRuntime()) return null;

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

    if (invalidatesBootstrap(url, method)) clearMobileWebStartupCache();
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
    clearMobileWebStartupCache();
  };
}
