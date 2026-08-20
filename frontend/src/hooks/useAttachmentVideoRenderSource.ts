import { useEffect, useState, useSyncExternalStore } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";

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

type AndroidAttachmentPreparation = {
  attachmentId: string;
  url: string;
};

interface AttachmentMediaPlugin {
  prepare(options: AndroidAttachmentPreparation): Promise<{ uri: string; size: number }>;
}

const AttachmentMedia = registerPlugin<AttachmentMediaPlugin>("AttachmentMedia");

export function getAndroidAttachmentVideoPreparation(
  resolvedSrc: string,
  platform = Capacitor.getPlatform(),
): AndroidAttachmentPreparation | null {
  if (!resolvedSrc || platform !== "android") return null;

  try {
    const source = new URL(resolvedSrc);
    const match = source.pathname.match(/^\/api\/attachments\/([0-9a-fA-F-]{36})$/);
    if (source.protocol !== "http:" || !match) return null;
    if (!["exp", "sig", "scope"].every((key) => source.searchParams.has(key))) return null;
    return { attachmentId: match[1], url: source.toString() };
  } catch {
    return null;
  }
}

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

  if (!/^\/api\/attachments\/[0-9a-fA-F-]{36}$/.test(source.pathname)) return resolvedSrc;

  const signed = ["exp", "sig", "scope"].every((key) => source.searchParams.has(key));
  if (page.protocol === "https:" && source.origin === page.origin && !signed) return "";
  if (page.protocol !== "https:" || source.protocol !== "http:") return resolvedSrc;

  // Clear-text Android attachments are prepared asynchronously as app-local files below.
  // Keep <video> idle for both the unsigned priming window and the native download window.
  return "";
}

/**
 * 视频附件保持稳定 attachmentId，运行时跟随 signed/offline 地址变化重新解析播放源。
 *
 * Android 局域网 HTTP 视频由原生层流式写入应用缓存，再通过 Capacitor 本地文件地址播放。
 * 这样既绕过 mixed-content，也避免把几十 MB 视频作为 Blob 放进 JS 内存。
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
  const preparation = getAndroidAttachmentVideoPreparation(resolvedSrc);
  const preparationKey = preparation
    ? `${preparation.attachmentId}\n${preparation.url}`
    : "";
  const preparationAttachmentId = preparation?.attachmentId ?? "";
  const preparationUrl = preparation?.url ?? "";
  const [prepared, setPrepared] = useState({ key: "", src: "" });

  useEffect(() => {
    if (!enabled || !preparationKey) return;
    let cancelled = false;
    setPrepared({ key: preparationKey, src: "" });
    AttachmentMedia.prepare({
      attachmentId: preparationAttachmentId,
      url: preparationUrl,
    })
      .then((result) => {
        if (cancelled) return;
        if (!result?.uri) throw new Error("Android video cache did not return a file URI");
        setPrepared({ key: preparationKey, src: Capacitor.convertFileSrc(result.uri) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[attachment-video-render] Android local preparation failed", {
          attachmentId: preparationAttachmentId,
          error: error instanceof Error ? error.message : String(error),
        });
        setPrepared({ key: preparationKey, src: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, preparationAttachmentId, preparationKey, preparationUrl]);

  const renderSrc = preparation
    ? (prepared.key === preparationKey ? prepared.src : "")
    : toAndroidAttachmentVideoUrl(resolvedSrc);

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
