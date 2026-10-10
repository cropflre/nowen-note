import path from "node:path";
import { MIME_TO_EXT, isHighRiskMime } from "../routes/attachments";

const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "msi", "msp", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe",
  "js", "jse", "wsf", "wsh", "hta", "lnk", "sh", "bash", "zsh", "fish", "app",
  "apk", "apks", "xapk", "dmg", "pkg", "jar", "dex", "so", "sys", "reg", "pif",
]);

const INLINE_PREVIEW_MIME_PREFIXES = ["image/", "audio/", "video/"] as const;
const INLINE_PREVIEW_MIMES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

export function getTaskAttachmentMaxSizeBytes(): number {
  const envVal = process.env.MAX_ATTACHMENT_SIZE_MB;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10240) {
      return parsed * 1024 * 1024;
    }
  }
  return 100 * 1024 * 1024;
}

export function getTaskAttachmentExtension(filename: string, mimeType: string): string {
  const mime = (mimeType || "application/octet-stream").toLowerCase().split(";")[0].trim();
  const byMime = MIME_TO_EXT[mime];
  if (byMime && /^[a-z0-9]{1,8}$/i.test(byMime)) return byMime.toLowerCase();

  const ext = path.extname(filename || "").replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

export function isBlockedTaskAttachment(filename: string, mimeType: string): boolean {
  const mime = (mimeType || "application/octet-stream").toLowerCase().split(";")[0].trim();
  if (isHighRiskMime(mime)) return true;
  const ext = path.extname(filename || "").replace(/^\./, "").toLowerCase();
  return !!ext && BLOCKED_EXTENSIONS.has(ext);
}

export function shouldInlineTaskAttachment(mimeType: string): boolean {
  const mime = (mimeType || "application/octet-stream").toLowerCase().split(";")[0].trim();
  if (INLINE_PREVIEW_MIMES.has(mime)) return true;
  return INLINE_PREVIEW_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}
