import { registerAttachmentAccessUrls } from "@/lib/noteAttachmentAccessBridge";

const PERSISTED_ATTACHMENT_REF_RE = /\/api\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[?"'\\)\s]|$)/i;
const DEFAULT_PRIME_TIMEOUT_MS = 4_000;

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

/**
 * Prime the short-lived attachment access map for a cached note before its editor mounts.
 *
 * notes.content intentionally persists only `/api/attachments/<id>` references. Since those
 * raw URLs are no longer authorization capabilities, a fresh renderer must exchange its JWT
 * for signed access URLs before native image/media requests are allowed to leave the page.
 *
 * A normal remote GET /notes/:id already performs the same exchange through
 * noteAttachmentAccessBridge. Cache-first note loading can skip that GET on the critical path,
 * so this lightweight request closes the lifecycle gap without changing persisted content.
 */
export async function primeNoteAttachmentAccess(
  noteId: string,
  apiBaseUrl: string,
  options: PrimeNoteAttachmentAccessOptions = {},
): Promise<number> {
  if (!noteId) return 0;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;

  const token = options.token !== undefined ? options.token : readStoredToken();
  if (!token) return 0;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(250, Number(options.timeoutMs))
    : DEFAULT_PRIME_TIMEOUT_MS;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const url = joinApiPath(
    apiBaseUrl,
    `/attachments/access/urls?noteId=${encodeURIComponent(noteId)}`,
  );

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!response.ok) {
      throw new Error(`Attachment access priming failed: ${response.status}`);
    }
    const payload = await response.json() as { urls?: Record<string, string> };
    return registerAttachmentAccessUrls(payload.urls, url);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
