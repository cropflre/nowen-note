// Shared server/account identity for offline storage and conversion barriers.
export const STORAGE_KEY_PREFIX = "nowen-offline-queue:v2";

function normalizeScopePart(value: string): string {
  return encodeURIComponent((value || "unknown").replace(/\/+$/, "").toLowerCase());
}

function decodeUserIdFromToken(token: string | null): string {
  if (!token) return "anonymous";
  try {
    const payload = token.split(".")[1];
    if (!payload) return "anonymous";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")))
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
    const data = JSON.parse(json) as { userId?: string; sub?: string };
    return data.userId || data.sub || "anonymous";
  } catch {
    return "anonymous";
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function getServerScope(): string {
  let server = "";
  try { server = localStorage.getItem("nowen-server-url") || ""; } catch { /* ignore */ }
  const origin = typeof window !== "undefined" && window.location.origin.startsWith("http")
    ? window.location.origin
    : "";
  const isDesktop = typeof window !== "undefined" && !!(window as any).nowenDesktop?.isDesktop;

  if (isDesktop && ((server && isLoopbackUrl(server)) || (!server && origin && isLoopbackUrl(origin)))) {
    return "local-desktop";
  }
  if (server) return normalizeUrl(server);
  if (origin) return normalizeUrl(origin);
  return "same-origin";
}

export function getOfflineQueueStorageKey(): string {
  let token: string | null = null;
  try { token = localStorage.getItem("nowen-token"); } catch { /* ignore */ }
  return `${STORAGE_KEY_PREFIX}:${normalizeScopePart(getServerScope())}:${normalizeScopePart(decodeUserIdFromToken(token))}`;
}
