import {
  normalizePublicWebOrigin,
  resolvePublicWebOrigin,
} from "@/lib/publicWebOrigin";

export interface PublicAttachmentUrlOptions {
  filePublicOrigin?: string | null;
  publicWebOrigin?: string | null;
}

export interface PublicAttachmentOriginResolution {
  origin: string;
  source: "file" | "public-web" | "current";
}

export function resolvePublicAttachmentOrigin(
  options: PublicAttachmentUrlOptions = {},
): PublicAttachmentOriginResolution {
  const fileOrigin = normalizePublicWebOrigin(options.filePublicOrigin);
  if (fileOrigin) return { origin: fileOrigin, source: "file" };

  const publicWeb = resolvePublicWebOrigin({
    runtimeOrigin: options.publicWebOrigin,
  });
  // Explicit/runtime/build public origins are valid delivery origins. A "current" fallback is
  // deliberately not used here: the already-resolved attachment URL knows the actual API/LAN
  // server, while window.location may be a dev server or native WebView shell.
  if (publicWeb.origin && publicWeb.source !== "current" && publicWeb.source !== "relative") {
    return { origin: publicWeb.origin, source: "public-web" };
  }

  return { origin: "", source: "current" };
}
