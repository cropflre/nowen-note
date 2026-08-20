import { useEffect, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";

import { resolveAttachmentUrl } from "@/lib/api";
import {
  acquireAttachmentRenderUrl,
  getAttachmentAccessSnapshot,
  getAttachmentRenderSource,
  subscribeAttachmentAccess,
} from "@/lib/noteAttachmentAccessBridge";

export type AttachmentVideoRenderSource = {
  attachmentId: string | null;
  persistentSrc: string;
  renderSrc: string;
  renderKey: string;
};

const ANDROID_MEDIA_PROXY_PATH = "/_nowen_attachment_media";

export function toAndroidAttachmentVideoUrl(
  resolvedSrc: string,
  platform = Capacitor.getPlatform(),
  pageOrigin = typeof window !== "undefined" ? window.location.origin : "",
): string {
  if (!resolvedSrc || platform !== "android" || !pageOrigin) return resolvedSrc;

  let source: URL;
  let page: URL;
  try {
    source = new URL(resolvedSrc);
    page = new URL(pageOrigin);
  } catch {
    return resolvedSrc;
  }

  if (page.protocol !== "https:" || source.protocol !== "http:") return resolvedSrc;
  if (!/^\/api\/attachments\/[0-9a-fA-F-]{36}$/.test(source.pathname)) return resolvedSrc;

  // An unsigned attachment URL would only produce a transient 401 before note priming finishes.
  // Keep the media element idle until the signed access map triggers the next render.
  if (!["exp", "sig", "scope"].every((key) => source.searchParams.has(key))) return "";

  const proxy = new URL(ANDROID_MEDIA_PROXY_PATH, page.origin);
  proxy.searchParams.set("url", source.toString());
  return proxy.toString();
}

/**
 * 视频附件保持稳定 attachmentId，运行时跟随 signed/offline 地址变化重新解析播放源。
 *
 * Android 上不能像图片一样把整段视频 fetch 成 Blob，否则几十 MB 视频会失去 Range/206
 * 流式播放并显著增加内存占用；这里只更新 <video src>，继续交给浏览器按字节范围读取。
 */
export function useAttachmentVideoRenderSource(
  rawSrc: string | null | undefined,
  options: { enabled?: boolean } = {},
): AttachmentVideoRenderSource {
  const enabled = options.enabled !== false;
  useSyncExternalStore(
    subscribeAttachmentAccess,
    getAttachmentAccessSnapshot,
    getAttachmentAccessSnapshot,
  );

  const source = getAttachmentRenderSource(rawSrc);
  const resolvedSrc = rawSrc && enabled
    ? resolveAttachmentUrl(rawSrc)
    : "";
  const renderSrc = toAndroidAttachmentVideoUrl(resolvedSrc);

  useEffect(() => (
    enabled && renderSrc
      ? acquireAttachmentRenderUrl(renderSrc)
      : () => undefined
  ), [enabled, renderSrc]);

  return {
    attachmentId: source.attachmentId,
    persistentSrc: source.persistentSrc,
    renderSrc,
    renderKey: renderSrc || source.persistentSrc || "video-empty",
  };
}
