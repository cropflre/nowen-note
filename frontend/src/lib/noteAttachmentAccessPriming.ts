import { registerAttachmentAccessUrls } from "@/lib/noteAttachmentAccessBridge";
import { fetchWithAuthRefresh } from "./authSession";
import { getOfflineQueueStorageKey } from "./offlineScope";

const PERSISTED_ATTACHMENT_REF_RE = /\/api\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[?"'\\)\s]|$)/i;
const DEFAULT_PRIME_TIMEOUT_MS = 4_000;
const primingInFlight = new Map<string, Promise<number>>();

type AttachmentAccessPayload = {
  urls?: Record<string, string>;
};

export interface PrimeNoteAttachmentAccessOptions {
  fetchImpl?: typeof fetch;
  token?: string | null;
  timeoutMs?: number;
}

export function hasPersistentNoteAttachmentReference(content: string | null | undefined): boolean {
  return typeof content === "string" && PERSISTED_ATTACHMENT_REF_RE.test(content);
}

function readStoredToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem("nowen-token");
  } catch {
    return null;
  }
}

function joinApiPath(apiBaseUrl: string, path: string): string {
  const base = (apiBaseUrl || "/api").replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function isNativeCapacitorRuntime(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean((window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

function isPrivateNetworkUrl(value: string): boolean {
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    const url = new URL(value, base);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname === "::1") return true;
    if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(hostname) || /^fe80:/i.test(hostname)) return true;

    const octets = hostname.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    const [a, b] = octets;
    return a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  } catch {
    return false;
  }
}

function shouldPreferNativeHttpTransport(url: string): boolean {
  if (!isNativeCapacitorRuntime()) return false;
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

function parseNativePayload(data: unknown): AttachmentAccessPayload {
  if (typeof data === "string") {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed as AttachmentAccessPayload : {};
  }
  return data && typeof data === "object" ? data as AttachmentAccessPayload : {};
}

async function requestAccessViaNative(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<AttachmentAccessPayload> {
  const { CapacitorHttp } = await import("@capacitor/core");
  const response = await CapacitorHttp.request({
    url,
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    responseType: "json",
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`Attachment access native priming failed: ${response.status}`), { status: response.status });
  }
  return parseNativePayload(response.data);
}

async function requestAccessViaWeb(
  url: string,
  apiBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<AttachmentAccessPayload> {
  const response = await fetchWithAuthRefresh(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  }, apiBaseUrl, fetchImpl);
  if (!response.ok) {
    throw Object.assign(new Error(`Attachment access priming failed: ${response.status}`), { status: response.status });
  }
  return response.json() as Promise<AttachmentAccessPayload>;
}

/**
 * Prime the short-lived attachment access map for a note before its editor mounts.
 *
 * notes.content intentionally persists only `/api/attachments/<id>` references. Since those
 * raw URLs are no longer authorization capabilities, a fresh renderer must exchange its JWT
 * for signed access URLs before native image/media requests are allowed to leave the page.
 *
 * Android has one important transport split: ordinary API calls can fall back to CapacitorHttp,
 * while <video>/<img> requests are emitted directly by WebView. When the configured server is a
 * clear-text LAN address such as http://192.168.x.x:3001, the authorization preflight therefore
 * must not depend on WebView fetch succeeding. Use native HTTP first for that exact runtime, then
 * register the returned signed URLs against the real LAN origin before media nodes are mounted.
 */
export function primeNoteAttachmentAccess(
  noteId: string,
  apiBaseUrl: string,
  options: PrimeNoteAttachmentAccessOptions = {},
): Promise<number> {
  const token = options.token !== undefined ? options.token : readStoredToken();
  if (!noteId || !token) return Promise.resolve(0);
  const accountScope = getOfflineQueueStorageKey();
  const key = JSON.stringify([accountScope, apiBaseUrl, noteId, token]);
  const existing = primingInFlight.get(key);
  if (existing) return existing;
  const pending = requestNoteAttachmentAccess(noteId, apiBaseUrl, options, token, accountScope)
    .finally(() => { if (primingInFlight.get(key) === pending) primingInFlight.delete(key); });
  primingInFlight.set(key, pending);
  return pending;
}

async function requestNoteAttachmentAccess(
  noteId: string, apiBaseUrl: string, options: PrimeNoteAttachmentAccessOptions,
  token: string, accountScope: string,
): Promise<number> {

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(250, Number(options.timeoutMs))
    : DEFAULT_PRIME_TIMEOUT_MS;
  const url = joinApiPath(
    apiBaseUrl,
    `/attachments/access/urls?noteId=${encodeURIComponent(noteId)}`,
  );

  // navigator.onLine describes Internet reachability poorly on isolated Wi-Fi/LAN networks.
  // A private Nowen server may still be perfectly reachable, so do not suppress its auth exchange.
  if (
    typeof navigator !== "undefined"
    && navigator.onLine === false
    && !isPrivateNetworkUrl(url)
  ) return 0;

  const fetchImpl = options.fetchImpl ?? fetch;
  const allowNativeFallback = options.fetchImpl === undefined && isNativeCapacitorRuntime();
  const preferNative = allowNativeFallback && shouldPreferNativeHttpTransport(url);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    let payload: AttachmentAccessPayload;

    if (preferNative) {
      try {
        payload = await requestAccessViaNative(url, token, timeoutMs);
      } catch (nativeError) {
        // Older/custom native shells may not expose CapacitorHttp. Preserve the WebView path as
        // a compatibility fallback instead of turning media preparation into a hard load failure.
        console.warn("[attachment-access] native LAN priming failed; retrying with WebView fetch", nativeError);
        payload = await requestAccessViaWeb(url, apiBaseUrl, token, fetchImpl, controller?.signal);
      }
    } else {
      try {
        payload = await requestAccessViaWeb(url, apiBaseUrl, token, fetchImpl, controller?.signal);
      } catch (webError) {
        if (!allowNativeFallback) throw webError;
        payload = await requestAccessViaNative(url, token, timeoutMs);
      }
    }

    if (accountScope !== getOfflineQueueStorageKey()) return 0;
    return registerAttachmentAccessUrls(payload.urls, url);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
