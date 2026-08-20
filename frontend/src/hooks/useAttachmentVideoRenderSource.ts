import { useEffect, useSyncExternalStore } from "react";

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
  const renderSrc = rawSrc && enabled
    ? resolveAttachmentUrl(rawSrc)
    : "";

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
