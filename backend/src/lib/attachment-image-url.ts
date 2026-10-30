import type { Context } from "hono";
import { getDb } from "../db/schema";
import { readFilePublicOriginEnv, resolveRuntimeFilePublicOrigin } from "./file-public-origin";
import { readPublicWebOriginEnv, resolveRuntimePublicWebOrigin } from "./public-web-origin";
import { resolvePublicOrigin } from "./shareUrlRewrite";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
  "image/svg+xml": "svg", "image/tiff": "tiff", "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico", "image/heic": "heic", "image/heif": "heif",
  "image/heic-sequence": "heic", "image/heif-sequence": "heif",
};

/** The suffix describes the stored MIME, never an untrusted original filename. */
export function imageAttachmentPath(id: string, mimeType: string): string | undefined {
  const ext = IMAGE_EXTENSIONS[mimeType.toLowerCase().split(";")[0].trim()];
  return ext ? `/api/attachments/${encodeURIComponent(id)}/image.${ext}` : undefined;
}

export function imageAttachmentUrl(c: Context, id: string, mimeType: string): string | undefined {
  const path = imageAttachmentPath(id, mimeType);
  if (!path) return undefined;
  const setting = (key: string) => (getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const file = resolveRuntimeFilePublicOrigin({
    storedOrigin: setting("site_file_public_origin"), storedSource: setting("site_file_public_origin_source"), envOrigin: readFilePublicOriginEnv(),
  });
  const web = resolveRuntimePublicWebOrigin({
    storedOrigin: setting("site_public_web_origin"), storedSource: setting("site_public_web_origin_source"), envOrigin: readPublicWebOriginEnv(),
  });
  const origin = file.origin || web.origin || resolvePublicOrigin((name) => c.req.header(name)) || new URL(c.req.url).origin;
  return `${origin.replace(/\/+$/, "")}${path}`;
}
