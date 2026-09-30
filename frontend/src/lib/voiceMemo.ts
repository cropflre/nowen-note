import { getServerUrl } from "./api";
import { getAccessToken } from "./authSession";
import type { VoiceMemoAttachment } from "./voiceMemoDraftStore";
import { isMobileLocalMode, MOBILE_LOCAL_USER_ID } from "./mobileLocalMode";
import { isElectronFullLocalRuntime } from "./uploadRequest";
import { getPersistentAttachmentUrl } from "./noteAttachmentAccessBridge";

export interface VoiceMemoRequest {
  noteId: string;
  insert: (attachment: VoiceMemoAttachment) => boolean;
  release?: () => void;
}
export function requestVoiceMemo(request: VoiceMemoRequest): void {
  window.dispatchEvent(new CustomEvent("nowen:voice-record", { detail: request }));
}
export function voiceMemoScope(): string {
  if (isMobileLocalMode()) return `mobile-local|${MOBILE_LOCAL_USER_ID}`;
  try {
    const payload = JSON.parse(atob((getAccessToken() || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const userId = payload.userId || payload.sub || payload.id;
    const server = getServerUrl();
    // 桌面本地服务重启后端口会变化，草稿必须使用稳定的设备作用域。
    const desktop = Boolean((window as Window & { nowenDesktop?: { isDesktop?: boolean } }).nowenDesktop?.isDesktop);
    const scope = isElectronFullLocalRuntime(server, desktop) ? "desktop-local" : server || window.location.origin;
    return userId ? `${scope}|${userId}` : "";
  } catch { return ""; }
}
export function voiceMemoHtml(attrs: Partial<VoiceMemoAttachment>): string {
  const src = getPersistentAttachmentUrl(attrs.src) || (attrs.attachmentId ? `/api/attachments/${attrs.attachmentId}` : attrs.src);
  const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<audio controls preload="metadata" src="${escape(src)}" data-attachment-id="${escape(attrs.attachmentId)}" data-filename="${escape(attrs.filename)}" data-mime-type="${escape(attrs.mimeType)}" data-size="${escape(attrs.size)}" data-duration-ms="${escape(attrs.durationMs)}"></audio>`;
}
