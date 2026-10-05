import { wechatCaptureApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT } from "./pluginApi";
import { invalidateNotebooks } from "./notebookInvalidation";

export const WECHAT_CAPTURE_CHANGED_EVENT = "nowen:wechat-capture-changed";
export const WECHAT_CAPTURE_SETTINGS_EVENT = PLUGIN_CONTRIBUTIONS_CHANGED_EVENT;

export function wechatArticleLinks(text: string): string[] {
  if (text.length > 16384) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(/https:\/\/[^\s<>"'，。；！？）】]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[),.;!?]+$/, "").replace(/&amp;/g, "&"));
      if (url.hostname !== "mp.weixin.qq.com" || url.port || url.username || url.password || !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) continue;
      if (url.pathname === "/s" && !["__biz", "mid", "idx"].every((key) => url.searchParams.get(key))) continue;
      const clean = new URL(url.origin + url.pathname);
      for (const key of ["__biz", "mid", "idx", "sn", "chksm"]) if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key)!);
      found.add(clean.href);
    } catch { /* A pasted message may include non-URL text. */ }
  }
  return found.size <= 20 ? [...found] : [];
}

export async function collectWechatArticles(text: string) {
  const result = await wechatCaptureApi.collect(text);
  invalidateNotebooks("create");
  window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "wechat-inbox" } }));
  window.dispatchEvent(new Event(WECHAT_CAPTURE_CHANGED_EVENT));
  return result;
}

// Automatic reads never trigger a browser permission request. A paste event works
// even when clipboard-read is unavailable (HTTP LAN, Safari, mobile WebViews).
export async function readWechatClipboard(): Promise<string[]> {
  const desktop = (window as any).nowenDesktop;
  if (desktop?.readWechatArticleClipboard) return wechatArticleLinks(await desktop.readWechatArticleClipboard());
  if (!document.hasFocus() || !navigator.clipboard?.readText || !navigator.permissions?.query) return [];
  try {
    const permission = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    if (permission.state !== "granted") return [];
    return wechatArticleLinks(await navigator.clipboard.readText());
  } catch { return []; }
}
