import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { getServerUrl, resolveAttachmentUrl } from "./api";
import { extractAttachmentId, getAttachmentRenderSource, registerAttachmentAccessUrls } from "./noteAttachmentAccessBridge";
import { getAccessToken } from "./authSession";

export interface PhotoMediaInfo {
  kind: "image" | "heif" | "live-photo" | "motion-photo" | "video" | "file";
  mimeType: string;
  hasMotion: boolean;
  motionStatus: "available" | "missing-companion" | "none";
  hasMotionOriginal: boolean;
  canDownloadOriginal?: boolean;
}

/** 查询参数必须保留签名；派生视频不能命中原照片的离线 Blob。 */
export function photoMediaUrl(source: string, kind: "info" | "motion" | "motion-original"): string {
  const persistent = getAttachmentRenderSource(source);
  if (!persistent.attachmentId) return "";
  const url = new URL(extractAttachmentId(source) ? source : persistent.persistentSrc, window.location.href);
  for (const key of ["w", "download", "inline", "media", "variant"]) url.searchParams.delete(key);
  if (kind === "info") url.searchParams.set("media", "info");
  else {
    url.searchParams.set("variant", kind);
    url.searchParams.set(kind === "motion-original" ? "download" : "inline", "1");
  }
  const path = url.origin === window.location.origin ? url.pathname + url.search : url.toString();
  return resolveAttachmentUrl(path);
}

export async function fetchPhotoMediaInfo(url: string, signal: AbortSignal): Promise<PhotoMediaInfo> {
  const origin = new URL(url, window.location.href).origin;
  const serverOrigin = new URL(getServerUrl() || window.location.origin, window.location.href).origin;
  const token = origin === serverOrigin || origin === window.location.origin ? getAccessToken() : null;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const register = (info: PhotoMediaInfo & { accessUrls?: Record<string, string> }) => {
    if (!signal.aborted) registerAttachmentAccessUrls(info.accessUrls, url);
    return info;
  };
  // Android 局域网 HTTP 由原生 HTTP 层读取元数据，避开 HTTPS WebView 的混合内容限制。
  if (Capacitor.isNativePlatform() && /^http:\/\//i.test(url)) {
    const response = await CapacitorHttp.get({ url, headers, responseType: "json", connectTimeout: 20000, readTimeout: 20000 });
    if (response.status !== 200) throw new Error("PHOTO_MEDIA_INFO_FAILED");
    return register(response.data as PhotoMediaInfo);
  }
  const response = await fetch(url, { signal, headers });
  if (!response.ok) throw new Error("PHOTO_MEDIA_INFO_FAILED");
  return register(await response.json() as PhotoMediaInfo);
}
