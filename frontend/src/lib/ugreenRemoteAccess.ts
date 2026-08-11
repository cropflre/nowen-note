import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { normalizeServerBaseUrl } from "@/lib/serverUrl";

const UGREEN_REMOTE_HOST_SUFFIXES = [".ugdocker.link", ".ug.link"];
const UGREEN_FETCH_PATCH_MARK = "__nowenUgreenCredentialedFetchInstalled";

export function getUgreenRemoteAccessUrl(input: string | null | undefined): string {
  const normalized = normalizeServerBaseUrl(input);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase();
    const isUgreenHost = hostname === "ug.link"
      || UGREEN_REMOTE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    if (url.protocol !== "https:" || !isUgreenHost) return "";
    return normalized;
  } catch {
    return "";
  }
}

export function isUgreenRemoteAccessUrl(input: string | null | undefined): boolean {
  return getUgreenRemoteAccessUrl(input) !== "";
}

/**
 * Electron 的主界面运行在 file://，默认 fetch 不会携带远端绿联会话 Cookie。
 * 仅对可信绿联 HTTPS 主机把 credentials 提升为 include，其它请求保持原样。
 */
export function installUgreenCredentialedFetch(): void {
  if (typeof window === "undefined" || !(window as any).nowenDesktop?.isDesktop) return;
  const runtime = window as any;
  if (runtime[UGREEN_FETCH_PATCH_MARK]) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (!isUgreenRemoteAccessUrl(rawUrl)) return nativeFetch(input, init);

    if (input instanceof Request) {
      return nativeFetch(new Request(input, { ...init, credentials: "include" }));
    }
    return nativeFetch(input, { ...init, credentials: "include" });
  }) as typeof window.fetch;
  runtime[UGREEN_FETCH_PATCH_MARK] = true;
}

/**
 * UGREENlink protects remote applications with its own browser session. The
 * desktop bridge opens only the health endpoint in an isolated window; once the
 * gateway is ready, the main login form continues the Nowen sign-in itself.
 */
export async function openUgreenRemoteWorkspace(input: string): Promise<void> {
  const url = getUgreenRemoteAccessUrl(input);
  if (!url) throw new Error("Invalid UGREENlink address");

  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url });
    return;
  }

  if ((window as any).nowenDesktop?.isDesktop) {
    const openInDesktop = (window as any).nowenDesktop?.openUgreenRemoteWorkspace;
    if (typeof openInDesktop !== "function") {
      throw new Error("Desktop UGREEN access is unavailable");
    }
    const result = await openInDesktop(url);
    if (!result?.ok) throw new Error(result?.error || "Unable to open UGREEN workspace");
    return;
  }

  const opened = window.open(url, "_blank");
  if (!opened) throw new Error("Browser window was blocked");
  opened.opener = null;
}
